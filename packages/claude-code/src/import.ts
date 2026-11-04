import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendPrivateFile,
  localScope,
  observe,
  resolveProjectId,
  scrubObservation,
  type Observation,
  type ObserveResult,
  type Scope,
} from '@oortmem/core';
import type { HookDeps } from './deps.js';
import { cursorKey } from './hooks.js';
import { parseTranscriptDetailed, selectAfterCursor } from './transcript.js';

export interface ImportOptions {
  /** Claude Code's projects directory, usually `~/.claude/projects`. */
  projectsDir: string;
  /** Only transcripts modified at or after this time. */
  since?: Date;
  /** Count and estimate only; write nothing. */
  estimateOnly: boolean;
  /** Share of observations expected to reach the writer (after the gate). Default 0.25. */
  writerFraction?: number;
  /**
   * Import sessions whose project cannot be resolved into global scope.
   * Default false: they are skipped, since a deleted private project's
   * memories would otherwise surface in every project.
   */
  includeUnresolved?: boolean;
}

export interface ImportResult {
  /** Sessions with at least one observation to import. */
  sessions: number;
  observations: number;
  /** Writer tokens: Σ(chars / 4 + 400) × writerFraction. No price table in Phase 1. */
  estimatedTokens: number;
  /**
   * Sessions with observations that were left out because their project could
   * not be resolved (recorded `cwd` gone, or not in a git repository).
   */
  skippedUnresolved: number;
  /** Transcripts that vanished or could not be read during the walk. */
  skippedUnreadable: number;
  results?: ObserveResult[];
  /** Per-outcome counts, plus `failed` for observations whose observe threw. */
  outcomes?: Record<string, number>;
  /**
   * Sessions that stopped at a failed observation: its cursor stays before it,
   * and the session's later observations were not attempted (the Stop hook or
   * a later import picks them up).
   */
  failedSessions?: Record<string, { failed: number; notAttempted: number; reason: string }>;
  /**
   * Observations skipped because the failure is permanent for that input (the
   * writer's output never fits the schema, or the model refused or truncated),
   * keyed by `failureReason`. Their sessions continue and the cursor passes them.
   */
  unwritable?: Record<string, number>;
}

/** A failure a re-run would repeat for the same observation: skip it rather than stop the session. */
function isPermanent(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'WriterOutputError') return true;
  return e.name === 'WriterError' && (e as { kind?: unknown }).kind === 'bad-response';
}

/**
 * Why an observation failed, from the error's class and the typed fields our
 * adapters set (`kind`, `status`, `fields`). Never the message: a provider's
 * message may echo the observation it was given.
 */
export function failureReason(e: unknown): string {
  if (!(e instanceof Error)) return 'non-error thrown';
  const { kind, status, fields } = e as { kind?: unknown; status?: unknown; fields?: unknown };
  const parts: string[] = [];
  if (typeof kind === 'string') parts.push(kind);
  if (typeof status === 'number') parts.push(`HTTP ${status}`);
  if (Array.isArray(fields) && fields.every((f) => typeof f === 'string'))
    parts.push(`fields: ${fields.join(', ')}`);
  return parts.length === 0 ? e.name : `${e.name} (${parts.join(', ')})`;
}

/** Fixed per-call writer overhead (system prompt, schema), in tokens. */
const WRITER_OVERHEAD_TOKENS = 400;
const DEFAULT_WRITER_FRACTION = 0.25;

interface Item {
  session: string;
  /** Position within the session, oldest first. */
  pos: number;
  obs: Observation;
  scope: Scope;
}

/**
 * Session transcripts: `<projectsDir>/<project>/<session>.jsonl`. Subagent
 * transcripts (one level deeper) and orphaned copies Claude Code set aside
 * (`<session>.orphaned-…jsonl`) are not sessions of their own.
 */
function transcripts(projectsDir: string, since: Date | undefined, skip: () => void): string[] {
  const out: string[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir, p.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.includes('.orphaned-')) continue;
      const file = path.join(dir, f.name);
      if (since !== undefined) {
        let mtime: number;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          skip(); // Vanished mid-walk.
          continue;
        }
        if (mtime < since.getTime()) continue;
      }
      out.push(file);
    }
  }
  return out.sort();
}

/**
 * The session's project id, or undefined when it cannot be resolved. A missing
 * directory is unresolved even inside a git repo: walking up from it would
 * attribute the session to the enclosing repository instead.
 */
function resolveProject(cwd: string | undefined, home: string): string | undefined {
  if (cwd === undefined || !fs.existsSync(cwd)) return undefined;
  return resolveProjectId(cwd, home);
}

function chars(o: Observation): number {
  return (
    o.userText.length + o.assistantText.length + o.toolSummaries.reduce((n, s) => n + s.length, 0)
  );
}

/**
 * Imports existing Claude Code transcripts. Every transcript is parsed,
 * paired and scrubbed; turns already behind a session's cursor (observed by
 * the Stop hook or an earlier import) are skipped. With `estimateOnly` it
 * only reports the estimate. Otherwise it observes oldest first across all
 * sessions, advances each session's cursor so the Stop hook never re-observes
 * imported turns, and appends one eval row per added memory to
 * `$OORT_HOME/eval/import-<YYYY-MM-DD>.jsonl`.
 *
 * The scope of each transcript is derived from the `cwd` its rows recorded.
 * A session whose project cannot be resolved is skipped (and counted in
 * `skippedUnresolved`) unless `includeUnresolved` imports it as global.
 */
export async function importTranscripts(
  opts: ImportOptions,
  deps: HookDeps,
): Promise<ImportResult> {
  const items: Item[] = [];
  let weighted = 0;
  const sessions = new Set<string>();
  let skippedUnresolved = 0;
  let skippedUnreadable = 0;
  const skip = (): void => {
    skippedUnreadable++;
  };
  for (const file of transcripts(opts.projectsDir, opts.since, skip)) {
    const session = path.basename(file, '.jsonl');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      skip();
      continue;
    }
    const detailed = parseTranscriptDetailed(text);
    const cwd = detailed.find((d) => d.turn.cwd.length > 0)?.turn.cwd;
    const projectId = resolveProject(cwd, deps.config.home);
    const scope = localScope(projectId);
    const { fresh } = selectAfterCursor(detailed, await deps.store.getCursor(cursorKey(session)));
    const mine: Item[] = [];
    for (const raw of fresh) {
      const s = scrubObservation(raw);
      if (s.dropped) continue;
      mine.push({ session, pos: mine.length, obs: s.obs, scope });
    }
    if (mine.length === 0) continue;
    if (projectId === undefined && opts.includeUnresolved !== true) {
      skippedUnresolved++;
      continue;
    }
    for (const item of mine) weighted += chars(item.obs) / 4 + WRITER_OVERHEAD_TOKENS;
    items.push(...mine);
    sessions.add(session);
  }
  const fraction = opts.writerFraction ?? DEFAULT_WRITER_FRACTION;
  const summary = {
    sessions: sessions.size,
    observations: items.length,
    estimatedTokens: Math.ceil(weighted * fraction),
    skippedUnresolved,
    skippedUnreadable,
  };
  if (opts.estimateOnly) return summary;

  const { embed, decide, write } = deps;
  if (embed === undefined || decide === undefined || write === undefined) {
    throw new Error('import needs the embed, decide and write adapters');
  }
  // Oldest first across sessions, but never out of order within one: each item
  // sorts at its session's running maximum timestamp (the sort is stable).
  const runningMax = new Map<string, number>();
  const key = new Map<Item, number>();
  for (const item of items) {
    const t = Date.parse(item.obs.at);
    const k = Math.max(runningMax.get(item.session) ?? 0, Number.isNaN(t) ? 0 : t);
    runningMax.set(item.session, k);
    key.set(item, k);
  }
  items.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0));

  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const evalFile = path.join(deps.config.home, 'eval', `import-${day}.jsonl`);
  const results: ObserveResult[] = [];
  const outcomes: Record<string, number> = {};
  const failedSessions: Record<string, { failed: number; notAttempted: number; reason: string }> =
    {};
  const unwritable: Record<string, number> = {};
  const done = new Map<string, number>();
  // Only forward within a session, and only past observations that are finished with.
  const advance = async (item: (typeof items)[number]): Promise<void> => {
    const prev = done.get(item.session) ?? -1;
    if (item.pos > prev && item.obs.turnRef !== undefined) {
      await deps.store.setCursor(cursorKey(item.session), item.obs.turnRef);
      done.set(item.session, item.pos);
    }
  };
  for (const item of items) {
    const stopped = failedSessions[item.session];
    if (stopped !== undefined) {
      // The session stopped at an earlier failure; its cursor must not pass it.
      stopped.notAttempted++;
      continue;
    }
    let r: ObserveResult;
    try {
      r = await observe(item.obs, item.scope, {
        store: deps.store,
        embed,
        decide,
        write,
        config: deps.config,
        now: deps.now?.() ?? new Date(),
        harness: 'claude-code',
      });
    } catch (e) {
      if (isPermanent(e)) {
        outcomes['unwritable'] = (outcomes['unwritable'] ?? 0) + 1;
        const why = failureReason(e);
        unwritable[why] = (unwritable[why] ?? 0) + 1;
        await advance(item);
        continue;
      }
      outcomes['failed'] = (outcomes['failed'] ?? 0) + 1;
      failedSessions[item.session] = { failed: 1, notAttempted: 0, reason: failureReason(e) };
      continue;
    }
    results.push(r);
    // A turn can become several memories (CON-56): count and log each one.
    for (const m of r.memories) {
      outcomes[m.outcome] = (outcomes[m.outcome] ?? 0) + 1;
      if (m.outcome !== 'added' || m.memoryId === undefined) continue;
      const row = {
        memoryId: m.memoryId,
        question: '',
        expectedMemoryIds: [m.memoryId],
        asOf: item.obs.at,
      };
      appendPrivateFile(evalFile, `${JSON.stringify(row)}\n`);
    }
    await advance(item);
  }
  return {
    ...summary,
    results,
    outcomes,
    ...(Object.keys(failedSessions).length > 0 && { failedSessions }),
    ...(Object.keys(unwritable).length > 0 && { unwritable }),
  };
}
