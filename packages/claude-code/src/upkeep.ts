import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  consolidateGrant,
  ensurePrivateDir,
  localScope,
  principalGrant,
  type ConsolidateResult,
} from '@oortmem/core';
import type { HookDeps } from './deps.js';
import { unlinkQuietly, withShortLock, writeFileAtomic } from './fsutil.js';

/**
 * Consolidation in a hook-only life (CON-48). Without a long-running process nothing calls
 * `consolidate`, so the detached drain that every `Stop` starts runs it when it is due:
 *
 * - due once a day (`CONSOLIDATE_EVERY_MS`), or early after the drain saved
 *   `CONSOLIDATE_EVERY_SAVES` turns, about the cadence of Oort Cloud's alarm;
 * - over every project of the person and their global memories, each ranked on its own, in every
 *   node the drain's grant writes (the Planet and Claude Code's Star, or only the Star when Claude
 *   Code keeps one);
 * - under `$OORT_HOME/consolidate.lock`, so two drains never run it at once;
 * - within `CONSOLIDATE_BUDGET_MS`, evicting in small batches so no write transaction holds the
 *   store long enough to make a hook wait. A run cut short keeps what it wrote and is resumed by a
 *   later drain (`partial`).
 *
 * Never in cloud mode: Oort Cloud consolidates itself. State lives in `$OORT_HOME/consolidate.json`
 * (times and counts only).
 */

/** A complete run is due again after this long. */
export const CONSOLIDATE_EVERY_MS = 24 * 60 * 60 * 1000;
/** ...or once the drain has saved this many turns since it. */
export const CONSOLIDATE_EVERY_SAVES = 200;
/** The longest one drain spends consolidating before it stops between two writes. */
export const CONSOLIDATE_BUDGET_MS = 2000;
/** A run cut short by the budget resumes no sooner than this. */
export const CONSOLIDATE_RESUME_AFTER_MS = 60 * 1000;
/** A run that failed is retried no sooner than this. */
export const CONSOLIDATE_RETRY_AFTER_MS = 60 * 60 * 1000;
/** A lock older than this is from a crashed drain and is broken. */
export const CONSOLIDATE_LOCK_STALE_MS = 5 * 60 * 1000;
/** Evictions per store transaction inside the drain: a hook waits at most 250 ms for the lock. */
export const DRAIN_EVICT_BATCH = 50;

const STATE_LOCK_WAIT_MS = 200;

export type ConsolidationOutcome = 'complete' | 'partial' | 'error';

export interface ConsolidationState {
  v: 1;
  /** When the last run (any outcome) started. */
  lastRunAt: string | null;
  /** When the last complete run started. */
  lastCompleteAt: string | null;
  lastOutcome: ConsolidationOutcome | null;
  /** Turns the drain saved since the last complete run started. */
  savesSince: number;
  /** Counts of the last run. */
  last?: {
    promoted: number;
    demoted: number;
    evicted: number;
    expired: number;
    skipped: number;
    ms: number;
  };
}

export type DueReason = 'never' | 'daily' | 'saves' | 'resume' | 'retry';

export interface Due {
  due: boolean;
  reason: DueReason | null;
  /** When it falls due, if not now. */
  nextAt: string | null;
}

const EMPTY_STATE: ConsolidationState = {
  v: 1,
  lastRunAt: null,
  lastCompleteAt: null,
  lastOutcome: null,
  savesSince: 0,
};

export const consolidationStateFile = (home: string): string => path.join(home, 'consolidate.json');
const lockFile = (home: string): string => path.join(home, 'consolidate.lock');

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;

/** The saved state; a missing or damaged file reads as "never ran". */
export function readConsolidationState(home: string): ConsolidationState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(consolidationStateFile(home), 'utf8'));
  } catch {
    return { ...EMPTY_STATE };
  }
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_STATE };
  const r = raw as Record<string, unknown>;
  const outcome = r['lastOutcome'];
  const saves = r['savesSince'];
  const last = r['last'];
  return {
    v: 1,
    lastRunAt: isoOrNull(r['lastRunAt']),
    lastCompleteAt: isoOrNull(r['lastCompleteAt']),
    lastOutcome:
      outcome === 'complete' || outcome === 'partial' || outcome === 'error' ? outcome : null,
    savesSince: Number.isSafeInteger(saves) && (saves as number) > 0 ? (saves as number) : 0,
    ...(typeof last === 'object' && last !== null && { last: last as ConsolidationState['last'] }),
  };
}

/**
 * Whether a drain should consolidate now. A run cut short resumes after a minute, a failed one is
 * retried after an hour; otherwise a complete run is due a day after the last one, or after
 * `CONSOLIDATE_EVERY_SAVES` saves.
 */
export function consolidationDue(state: ConsolidationState, now: Date): Due {
  const t = now.getTime();
  const at = (iso: string | null, after: number): number =>
    iso === null ? -Infinity : Date.parse(iso) + after;
  const verdict = (reason: DueReason, from: number): Due =>
    from <= t
      ? { due: true, reason, nextAt: null }
      : { due: false, reason: null, nextAt: new Date(from).toISOString() };
  if (state.lastOutcome === 'partial') {
    return verdict('resume', at(state.lastRunAt, CONSOLIDATE_RESUME_AFTER_MS));
  }
  if (state.lastOutcome === 'error') {
    return verdict('retry', at(state.lastRunAt, CONSOLIDATE_RETRY_AFTER_MS));
  }
  if (state.lastCompleteAt === null) return { due: true, reason: 'never', nextAt: null };
  if (state.savesSince >= CONSOLIDATE_EVERY_SAVES)
    return { due: true, reason: 'saves', nextAt: null };
  return verdict('daily', at(state.lastCompleteAt, CONSOLIDATE_EVERY_MS));
}

/** True when a drain started now would consolidate: one small file read, for the Stop hook. */
export function isConsolidationDue(home: string, now: Date): boolean {
  return consolidationDue(readConsolidationState(home), now).due;
}

/** Changes the state file under its own short lock. False when the lock was busy. */
function updateState(home: string, fn: (s: ConsolidationState) => ConsolidationState): boolean {
  const file = consolidationStateFile(home);
  ensurePrivateDir(home);
  const r = withShortLock(`${file}.lock`, STATE_LOCK_WAIT_MS, () => {
    writeFileAtomic(file, `${JSON.stringify(fn(readConsolidationState(home)))}\n`, 0o600);
  });
  return r.ok;
}

/** Counts `n` new memories towards the next consolidation. Best effort. */
export function noteSaves(home: string, n: number): void {
  if (n <= 0) return;
  try {
    updateState(home, (s) => ({ ...s, savesSince: s.savesSince + n }));
  } catch {
    // A lost count only delays the next run to its daily slot.
  }
}

/** Takes the consolidation lock, breaking a stale one; null when another drain holds it. */
function acquireLock(file: string, nowMs: number): number | null {
  try {
    return fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  try {
    if (nowMs - fs.statSync(file).mtimeMs <= CONSOLIDATE_LOCK_STALE_MS) return null;
    unlinkQuietly(file);
    return fs.openSync(file, 'wx', 0o600);
  } catch {
    return null;
  }
}

export type ConsolidateIfDueOutcome = 'skipped:cloud' | 'not-due' | 'locked' | ConsolidationOutcome;

export interface ConsolidateIfDueOptions {
  budgetMs?: number;
  /** Milliseconds, monotonic; the budget is measured on it (default `performance.now`). */
  clock?: () => number;
  /** Run even when not due (the lock is still taken). */
  force?: boolean;
}

/**
 * Runs consolidation when it is due, under the lock and within the budget, and records the run.
 * Never throws: a failure is logged (`consolidate` / `error`) and retried later. Writes one hook
 * log line when it ran or found the lock taken, none when nothing was due.
 */
export async function consolidateIfDue(
  deps: HookDeps,
  opts: ConsolidateIfDueOptions = {},
): Promise<{ outcome: ConsolidateIfDueOutcome; result?: ConsolidateResult }> {
  // Oort Cloud consolidates on its own; the local store holds only cursors and the queue then.
  if (deps.remote !== undefined) return { outcome: 'skipped:cloud' };
  const home = deps.config.home;
  const clock = opts.clock ?? (() => performance.now());
  const budgetMs = opts.budgetMs ?? CONSOLIDATE_BUDGET_MS;
  const nowOf = (): Date => deps.now?.() ?? new Date();
  const logBase = { event: 'consolidate', session: null, project: null } as const;
  try {
    if (opts.force !== true && !consolidationDue(readConsolidationState(home), nowOf()).due) {
      return { outcome: 'not-due' };
    }
    ensurePrivateDir(home);
  } catch {
    return { outcome: 'not-due' };
  }

  const lockPath = lockFile(home);
  let lock: number | null;
  try {
    lock = acquireLock(lockPath, Date.now());
  } catch {
    lock = null;
  }
  if (lock === null) {
    deps.log.write({ ...logBase, outcome: 'locked', counts: {}, timings: {} });
    return { outcome: 'locked' };
  }

  const start = clock();
  const startedAt = nowOf();
  try {
    // Another drain may have finished a run between our check and the lock.
    const state = readConsolidationState(home);
    if (opts.force !== true && !consolidationDue(state, startedAt).due) {
      return { outcome: 'not-due' };
    }
    try {
      fs.writeSync(lock, `${process.pid}\n`);
    } catch {
      // The pid is informational.
    }
    const scope = deps.scope ?? localScope();
    const grant = principalGrant(
      { orgId: scope.orgId, customerId: scope.customerId, agentId: scope.agentId },
      deps.home !== undefined ? { home: deps.home } : {},
    );
    let result: ConsolidateResult;
    try {
      result = await consolidateGrant(grant, {
        store: deps.store,
        config: deps.config,
        now: startedAt,
        evictBatch: DRAIN_EVICT_BATCH,
        shouldStop: () => clock() - start >= budgetMs,
      });
    } catch {
      const ms = clock() - start;
      recordRun(home, startedAt, 'error', state.savesSince);
      deps.log.write({ ...logBase, outcome: 'error', counts: {}, timings: { totalMs: ms } });
      return { outcome: 'error' };
    }
    const ms = clock() - start;
    const outcome: ConsolidationOutcome = result.complete ? 'complete' : 'partial';
    const counts = {
      promoted: result.promoted.length,
      demoted: result.demoted.length,
      evicted: result.evicted.length,
      expired: result.expired.length,
      skipped: result.skipped,
    };
    recordRun(home, startedAt, outcome, state.savesSince, { ...counts, ms });
    deps.log.write({
      ...logBase,
      outcome: outcome === 'complete' ? 'ok' : 'partial',
      counts,
      timings: { totalMs: ms },
    });
    return { outcome, result };
  } catch {
    return { outcome: 'error' };
  } finally {
    try {
      fs.closeSync(lock);
    } catch {
      // Already closed.
    }
    try {
      unlinkQuietly(lockPath);
    } catch {
      // A stale lock is broken after CONSOLIDATE_LOCK_STALE_MS.
    }
  }
}

/** Records a run; saves counted while it ran stay counted towards the next one. */
function recordRun(
  home: string,
  startedAt: Date,
  outcome: ConsolidationOutcome,
  savesAtStart: number,
  last?: ConsolidationState['last'],
): void {
  try {
    updateState(home, (s) => ({
      ...s,
      lastRunAt: startedAt.toISOString(),
      lastOutcome: outcome,
      ...(outcome === 'complete' && {
        lastCompleteAt: startedAt.toISOString(),
        savesSince: Math.max(0, s.savesSince - savesAtStart),
      }),
      ...(last !== undefined && { last }),
    }));
  } catch {
    // Without a record the next drain runs it again; consolidation is idempotent.
  }
}

/**
 * Records a run made outside the drain (`oort consolidate`), so the drain and `oort doctor` count
 * it. `savesAtStart` is `readConsolidationState(home).savesSince` read before the run.
 */
export function recordConsolidation(
  home: string,
  startedAt: Date,
  savesAtStart: number,
  result: ConsolidateResult,
  ms: number,
): void {
  recordRun(home, startedAt, result.complete ? 'complete' : 'partial', savesAtStart, {
    promoted: result.promoted.length,
    demoted: result.demoted.length,
    evicted: result.evicted.length,
    expired: result.expired.length,
    skipped: result.skipped,
    ms,
  });
}
