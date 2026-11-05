import * as fs from 'node:fs';
import { z } from 'zod';
import {
  activation,
  formatForInjection,
  localGrant,
  localScope,
  resolveProjectId,
  recall,
  shouldRecall,
  type RecallQuery,
  type RecallResult,
  type Grant,
  type Memory,
  type RecalledMemory,
  type Scope,
  type ScopeFilter,
} from '@oortmem/core';
import type { HookDeps } from './deps.js';
import type { HookLogEntry } from './log.js';
import { drainQueue, enqueueObservations, hasPendingQueue } from './queue.js';
import {
  parseTranscriptDetailed,
  readTranscriptFrom,
  resumeOffset,
  selectAfterCursor,
  type DetailedTurn,
  type TranscriptRead,
} from './transcript.js';

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

/** Full recall gets this long before the hook falls back to lexical-only recall (CON-57: was 2.5 s). */
export const RECALL_TIMEOUT_MS = 1500;
/** At most this many observations are queued per Stop (the newest). */
export const STOP_MAX_OBSERVATIONS = 20;
/** Claude Code moves a longer `additionalContext` to a file and injects only a preview. */
const CONTEXT_MAX_CHARS = 10_000;

const EMPTY: HookOutput = { stdout: '', exitCode: 0 };
const TIMEOUT = Symbol('timeout');

export const cursorKey = (session: string): string => `claude-code:${session}`;
/** Where the Stop hook resumes reading a session's transcript: `{ cursor, offset }` as JSON. */
export const offsetKey = (session: string): string => `claude-code-offset:${session}`;

function parseSavedOffset(raw: string | null): { cursor: string; offset: number } | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as { cursor?: unknown; offset?: unknown };
    if (
      typeof v.cursor === 'string' &&
      Number.isSafeInteger(v.offset) &&
      (v.offset as number) >= 0
    ) {
      return { cursor: v.cursor, offset: v.offset as number };
    }
  } catch {
    // A damaged value only costs one full read.
  }
  return undefined;
}

function scopeFor(cwd: string, deps: HookDeps): Scope {
  return deps.scope ?? localScope(resolveProjectId(cwd, deps.config.home));
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

/** The grant for `filterFor(scope)`: what hooks, import and the CLI read and write. */
export function grantFor(scope: Scope): Grant {
  return localGrant(filterFor(scope));
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
    const { store, config } = deps;
    const budget = Math.min(config.recall.budgetChars, CONTEXT_MAX_CHARS);
    // Recall returns (and records access for) only what this block can hold (CON-47).
    const q: RecallQuery = {
      text: input.prompt,
      scope: filterFor(scope),
      budgetChars: budget,
      ...(deps.home !== undefined && { home: deps.home }),
    };
    const now = deps.now?.() ?? new Date();
    const degraded: string[] = [];
    const t = performance.now();
    let result: RecallResult;
    if (deps.remote !== undefined) {
      // Oort Cloud: the cloud recalls. A timeout or an error injects nothing, never a local guess.
      const remote = deps.remote.recall({
        text: input.prompt,
        ...(scope.projectId !== undefined && { projectId: scope.projectId }),
      });
      remote.catch(() => {});
      let r: RecallResult | typeof TIMEOUT | undefined;
      try {
        r = await withTimeout(remote, RECALL_TIMEOUT_MS);
      } catch {
        r = undefined;
      }
      entry.timings['recallMs'] = performance.now() - t;
      if (r === TIMEOUT || r === undefined) {
        entry.degraded = [r === TIMEOUT ? 'cloud-timeout' : 'cloud-error'];
        entry.counts = { memories: 0, chars: 0 };
        entry.outcome = 'empty';
        return EMPTY;
      }
      result = r;
    } else {
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
    }
    // Per-stage timings from recall (numbers only), so slow stages show in the log (CON-57).
    for (const [k, ms] of Object.entries(result.timings)) {
      if (k !== 'totalMs' && k !== 'gateMs') entry.timings[k] = ms;
    }
    degraded.push(...(result.degraded ?? []));
    entry.degraded = [...new Set(degraded)];
    const text = formatForInjection(result, budget, now);
    entry.counts = {
      memories: result.memories.length,
      chars: text.length,
      ...(result.abstained === true && { abstained: 1 }),
      ...(result.gate !== undefined && { gateDropped: result.gate.dropped }),
      ...(result.rerankSkipped !== undefined && { rerankSkipped: 1 }),
      ...(result.embedSkipped !== undefined && { embedSkipped: 1 }),
    };
    // Abstained: candidates were found but none was relevant enough, so nothing is injected.
    entry.outcome =
      text.length > 0 ? 'injected' : result.abstained === true ? 'abstained' : 'empty';
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
    const key = cursorKey(input.session_id);
    const grant = grantFor(scope);
    const [cursor, savedRaw] = await Promise.all([
      deps.store.getCursor(grant, key),
      deps.store.getCursor(grant, offsetKey(input.session_id)),
    ]);
    // Read from the saved offset when it was saved for this very cursor (CON-51); anything else
    // (no offset yet, a cursor moved by import) reads the whole transcript, as before.
    const saved = parseSavedOffset(savedRaw);
    const from = saved !== undefined && saved.cursor === cursor ? saved.offset : 0;
    const t = performance.now();
    let read: TranscriptRead;
    let detailed: DetailedTurn[];
    let sel: ReturnType<typeof selectAfterCursor>;
    try {
      read = readTranscriptFrom(input.transcript_path, from);
      let bytesRead = read.bytes;
      detailed = parseTranscriptDetailed(read.text, read.base);
      sel = selectAfterCursor(detailed, cursor);
      if (read.base > 0 && !sel.cursorFound) {
        // The file changed under the offset (rewritten or rotated): read it all.
        read = readTranscriptFrom(input.transcript_path, 0);
        bytesRead += read.bytes;
        detailed = parseTranscriptDetailed(read.text, read.base);
        sel = selectAfterCursor(detailed, cursor);
      }
      entry.counts = { bytesRead };
    } catch {
      entry.outcome = 'no-transcript';
      return EMPTY;
    }
    entry.timings['parseMs'] = performance.now() - t;
    if (read.base > 0) entry.counts['incremental'] = 1;
    else if (from > 0) entry.counts['offsetStale'] = 1;

    entry.counts['turns'] = detailed.length;
    entry.counts['observations'] = sel.fresh.length;
    let fresh = sel.fresh;
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
    if (last !== undefined) await deps.store.setCursor(grant, key, last);
    // The next Stop starts where this cursor's pair starts (written only when it moved).
    const anchor = last ?? (sel.cursorFound ? cursor : null);
    const offset = anchor === null ? undefined : resumeOffset(detailed, anchor);
    if (anchor !== null && offset !== undefined) {
      if (saved?.cursor !== anchor || saved.offset !== offset) {
        await deps.store.setCursor(
          grant,
          offsetKey(input.session_id),
          JSON.stringify({ cursor: anchor, offset }),
        );
      }
    }
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
    let current: Memory[];
    if (deps.remote !== undefined) {
      try {
        current = await deps.remote.sessionMemories(
          scope.projectId !== undefined ? { projectId: scope.projectId } : {},
        );
      } catch {
        entry.degraded = ['cloud-error'];
        entry.counts = { memories: 0, chars: 0 };
        entry.outcome = 'empty';
        return EMPTY;
      }
    } else {
      // Two indexed queries, whatever the store holds, and no embeddings (CON-51).
      const grant = grantFor(scope);
      const [hot, pinned] = await Promise.all([
        deps.store.list(grant, { tier: 'hot', embeddings: false }),
        deps.store.list(grant, { pinned: true, embeddings: false }),
      ]);
      current = [...new Map([...pinned, ...hot].map((m) => [m.id, m])).values()];
    }
    const picked: RecalledMemory[] = current
      .filter((m) => m.pinned || m.tier === 'hot')
      .map((m) => ({
        ...m,
        explanation: {
          fused: 0,
          rrf: 0,
          coverage: 0,
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
