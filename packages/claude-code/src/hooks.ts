import * as fs from 'node:fs';
import { z } from 'zod';
import {
  activation,
  formatForInjection,
  localScope,
  projectIdFor,
  recall,
  shouldRecall,
  type RecallQuery,
  type RecallResult,
  type RecalledMemory,
  type Scope,
  type ScopeFilter,
} from '@oortmem/core';
import type { HookDeps } from './deps.js';
import type { HookLogEntry } from './log.js';
import { drainQueue, enqueueObservations, hasPendingQueue } from './queue.js';
import { parseTranscriptDetailed, selectAfterCursor } from './transcript.js';

/**
 * Claude Code hook handlers (https://code.claude.com/docs/en/hooks). Every
 * handler resolves `{ stdout, exitCode: 0 }`, catches every error, and writes
 * exactly one line to the hook log. Context reaches Claude through
 * `hookSpecificOutput.additionalContext` on UserPromptSubmit and SessionStart;
 * Stop prints nothing, since any Stop output would make Claude keep going.
 */

export type HookEvent = 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'drain';

export interface HookOutput {
  stdout: string;
  exitCode: 0;
}

/** Full recall gets this long before the hook falls back to lexical-only recall. */
export const RECALL_TIMEOUT_MS = 2500;
/** At most this many observations are queued per Stop (the newest). */
export const STOP_MAX_OBSERVATIONS = 20;
/** Claude Code moves a longer `additionalContext` to a file and injects only a preview. */
const CONTEXT_MAX_CHARS = 10_000;

const EMPTY: HookOutput = { stdout: '', exitCode: 0 };
const TIMEOUT = Symbol('timeout');

export const cursorKey = (session: string): string => `claude-code:${session}`;

function scopeFor(cwd: string, deps: HookDeps): Scope {
  return deps.scope ?? localScope(projectIdFor(cwd));
}

/** The scope's project plus global memories. A private project's memories carry its own id. */
export function filterFor(scope: Scope): ScopeFilter {
  return {
    orgId: scope.orgId,
    customerId: scope.customerId,
    agentId: scope.agentId,
    projectIds: [...new Set<string | null>([scope.projectId ?? null, null])],
  };
}

function contextOutput(event: 'UserPromptSubmit' | 'SessionStart', text: string): HookOutput {
  if (text.length === 0) return EMPTY;
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    }),
    exitCode: 0,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

type Log = Omit<HookLogEntry, 'ts'>;

/** Runs `body` with a log entry it fills in; the entry is written once, whatever happens. */
async function logged(
  base: Pick<Log, 'event' | 'session'>,
  deps: HookDeps,
  body: (entry: Log) => Promise<HookOutput>,
): Promise<HookOutput> {
  const t0 = performance.now();
  const entry: Log = { ...base, project: null, outcome: 'error', counts: {}, timings: {} };
  try {
    return await body(entry);
  } catch {
    entry.outcome = 'error';
    return EMPTY;
  } finally {
    entry.timings['totalMs'] = performance.now() - t0;
    deps.log.write(entry);
  }
}

export async function handleUserPromptSubmit(
  input: { prompt: string; cwd: string; session_id: string },
  deps: HookDeps,
): Promise<HookOutput> {
  return logged({ event: 'UserPromptSubmit', session: input.session_id }, deps, async (entry) => {
    const gate = shouldRecall(input.prompt);
    if (!gate.recall) {
      entry.outcome = `skipped:${gate.reason}`;
      return EMPTY;
    }
    const scope = scopeFor(input.cwd, deps);
    entry.project = scope.projectId ?? null;
    const q: RecallQuery = { text: input.prompt, scope: filterFor(scope) };
    const now = deps.now?.() ?? new Date();
    const { store, config } = deps;
    const degraded: string[] = [];
    const t = performance.now();
    let result: RecallResult;
    const full = recall(q, {
      store,
      config,
      now,
      ...(deps.embed !== undefined && { embed: deps.embed }),
      ...(deps.rerank !== undefined && { rerank: deps.rerank }),
    });
    // The full recall may lose the race and fail later; nobody awaits it then.
    full.catch(() => {});
    try {
      const r = await withTimeout(full, RECALL_TIMEOUT_MS);
      if (r === TIMEOUT) {
        degraded.push('timeout');
        result = await recall(q, { store, config, now });
      } else {
        result = r;
      }
    } catch {
      degraded.push('error');
      result = await recall(q, { store, config, now });
    }
    entry.timings['recallMs'] = performance.now() - t;
    degraded.push(...(result.degraded ?? []));
    entry.degraded = [...new Set(degraded)];
    const text = formatForInjection(
      result,
      Math.min(config.recall.budgetChars, CONTEXT_MAX_CHARS),
      now,
    );
    entry.counts = { memories: result.memories.length, chars: text.length };
    entry.outcome = text.length > 0 ? 'injected' : 'empty';
    return contextOutput('UserPromptSubmit', text);
  });
}

export async function handleStop(
  input: {
    transcript_path: string;
    session_id: string;
    cwd: string;
    stop_hook_active: boolean;
  },
  deps: HookDeps,
): Promise<HookOutput> {
  return logged({ event: 'Stop', session: input.session_id }, deps, async (entry) => {
    // Claude is already continuing because of a stop hook; this turn is not over.
    if (input.stop_hook_active) {
      entry.outcome = 'skipped:stop-hook-active';
      return EMPTY;
    }
    const scope = scopeFor(input.cwd, deps);
    entry.project = scope.projectId ?? null;
    let text: string;
    try {
      text = fs.readFileSync(input.transcript_path, 'utf8');
    } catch {
      entry.outcome = 'no-transcript';
      return EMPTY;
    }
    const t = performance.now();
    const detailed = parseTranscriptDetailed(text);
    entry.timings['parseMs'] = performance.now() - t;

    const key = cursorKey(input.session_id);
    const sel = selectAfterCursor(detailed, await deps.store.getCursor(key));
    let fresh = sel.fresh;
    entry.counts = { turns: detailed.length, observations: fresh.length };
    // Compaction or rotation dropped the cursor's row; take only the newest turns.
    if (!sel.cursorFound) entry.counts['cursorMissing'] = 1;
    if (fresh.length > STOP_MAX_OBSERVATIONS) {
      entry.counts['capped'] = fresh.length - STOP_MAX_OBSERVATIONS;
      fresh = fresh.slice(-STOP_MAX_OBSERVATIONS);
    }
    const now = deps.now?.() ?? new Date();
    const { queued, dropped } = enqueueObservations(
      deps.config.home,
      input.session_id,
      scope,
      fresh,
      now,
    );
    entry.counts['queued'] = queued;
    entry.counts['dropped'] = dropped;
    const last = fresh.at(-1)?.turnRef;
    if (last !== undefined) await deps.store.setCursor(key, last);
    if (queued > 0 || hasPendingQueue(deps.config.home)) {
      try {
        deps.spawnDrain?.();
      } catch {
        entry.counts['spawnFailed'] = 1;
      }
    }
    entry.outcome = queued > 0 ? 'queued' : 'nothing-new';
    return EMPTY;
  });
}

export async function handleSessionStart(
  input: { cwd: string; session_id: string; source?: string },
  deps: HookDeps,
): Promise<HookOutput> {
  return logged({ event: 'SessionStart', session: input.session_id }, deps, async (entry) => {
    const scope = scopeFor(input.cwd, deps);
    entry.project = scope.projectId ?? null;
    const now = deps.now?.() ?? new Date();
    const { config } = deps;
    const current = await deps.store.list(filterFor(scope));
    const picked: RecalledMemory[] = current
      .filter((m) => m.pinned || m.tier === 'hot')
      .map((m) => ({
        ...m,
        explanation: {
          fused: 0,
          activation: activation(m.accessLog, m.salience, now, config.activation),
          hydrated: false,
        },
      }))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          b.explanation.activation - a.explanation.activation,
      );
    const budget = Math.floor(Math.min(config.recall.budgetChars, CONTEXT_MAX_CHARS) / 2);
    const text = formatForInjection({ memories: picked, timings: {} }, budget, now);
    entry.counts = { memories: picked.length, chars: text.length };
    entry.outcome = text.length > 0 ? 'injected' : 'empty';
    return contextOutput('SessionStart', text);
  });
}

const UserPromptSubmitInput = z.looseObject({
  session_id: z.string(),
  cwd: z.string(),
  prompt: z.string(),
});
const StopInput = z.looseObject({
  session_id: z.string(),
  cwd: z.string(),
  transcript_path: z.string(),
  stop_hook_active: z.boolean().default(false),
});
const SessionStartInput = z.looseObject({
  session_id: z.string(),
  cwd: z.string(),
  source: z.string().optional(),
});

/**
 * The `oort hook <event>` entry point: parses the hook's stdin JSON (unknown
 * fields are kept and ignored) and dispatches. `drain` ignores stdin. Invalid
 * input logs one line and yields empty stdout; nothing here ever throws.
 *
 * Task 13 (CLI): write `stdout`, then call `process.exit(0)` at once; after a
 * recall timeout the losing full recall is still pending and would hold the process.
 */
export async function runHook(
  event: HookEvent,
  stdinText: string,
  deps: HookDeps,
): Promise<HookOutput> {
  let session: string | null = null;
  try {
    if (event === 'drain') {
      await drainQueue(deps);
      return EMPTY;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stdinText);
    } catch {
      raw = undefined;
    }
    if (typeof raw === 'object' && raw !== null && 'session_id' in raw) {
      const s = (raw as { session_id: unknown }).session_id;
      if (typeof s === 'string') session = s;
    }
    if (event === 'UserPromptSubmit') {
      const p = UserPromptSubmitInput.safeParse(raw);
      if (p.success) return await handleUserPromptSubmit(p.data, deps);
    } else if (event === 'Stop') {
      const p = StopInput.safeParse(raw);
      if (p.success) return await handleStop(p.data, deps);
    } else if (event === 'SessionStart') {
      const p = SessionStartInput.safeParse(raw);
      if (p.success) return await handleSessionStart(p.data, deps);
    }
    deps.log.write({
      event,
      session,
      project: null,
      outcome: 'invalid-input',
      counts: {},
      timings: {},
    });
    return EMPTY;
  } catch {
    try {
      deps.log.write({ event, session, project: null, outcome: 'error', counts: {}, timings: {} });
    } catch {
      // Nothing left to do; the session must go on.
    }
    return EMPTY;
  }
}
