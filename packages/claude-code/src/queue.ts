import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  appendPrivateFile,
  ensurePrivateDir,
  observe,
  scrubObservation,
  type Observation,
  type Scope,
} from '@oortmem/core';
import type { HookDeps } from './deps.js';
import { unlinkQuietly, withShortLock, writeFileAtomic } from './fsutil.js';

/**
 * The write-path queue between the Stop hook and the drain.
 *
 * - `$OORT_HOME/queue/<session>.jsonl`: one JSON line per scrubbed observation,
 *   appended by the Stop hook (0600, directory 0700).
 * - `$OORT_HOME/queue/.lock`: the drain lock (`wx`); one drain at a time. A lock
 *   older than ten minutes is from a crashed drain and is broken.
 * - `<file>.lock`: a short per-file lock held by an append, and by the drain
 *   while it rewrites the file, so no concurrent append is lost.
 * - `$OORT_HOME/queue/dead/<session>.jsonl`: lines that failed three times, or
 *   could not be parsed.
 */

export const DRAIN_LOCK_STALE_MS = 10 * 60 * 1000;
export const DRAIN_MAX_PER_RUN = 50;
export const MAX_ATTEMPTS = 3;
/** Consecutive adapter failures after which a drain run stops (the adapter is likely down). */
const CIRCUIT_BREAKER = 3;
const APPEND_LOCK_WAIT_MS = 500;
const COMMIT_LOCK_WAIT_MS = 5_000;

const ScopeSchema = z.object({
  orgId: z.string(),
  customerId: z.string(),
  agentId: z.string(),
  projectId: z.string().optional(),
});

const ObservationSchema = z.object({
  userText: z.string(),
  assistantText: z.string(),
  toolSummaries: z.array(z.string()),
  sessionId: z.string().optional(),
  turnRef: z.string().optional(),
  projectId: z.string().optional(),
  at: z.string(),
});

const QueueLineSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  scope: ScopeSchema,
  obs: ObservationSchema,
  attempts: z.number().int().min(0),
  queuedAt: z.string(),
});
export type QueueLine = z.infer<typeof QueueLineSchema>;

export const queueDir = (home: string): string => path.join(home, 'queue');

/** A file-name-safe form of a session id; anything unusual is hashed. */
export function queueName(session: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(session)
    ? session
    : `h-${createHash('sha256').update(session).digest('hex').slice(0, 40)}`;
}

/**
 * Scrubs and appends observations to the session's queue file; observations
 * that are mostly secret are dropped. Never holds a lock across anything but
 * the append; if the file lock is busy, the batch goes to a unique segment
 * file instead (the drain reads every `*.jsonl`), so nothing is lost.
 */
export function enqueueObservations(
  home: string,
  session: string,
  scope: Scope,
  observations: Observation[],
  now: Date = new Date(),
): { queued: number; dropped: number } {
  const lines: string[] = [];
  let dropped = 0;
  for (const raw of observations) {
    const s = scrubObservation(raw);
    if (s.dropped) {
      dropped++;
      continue;
    }
    const line: QueueLine = {
      v: 1,
      id: randomUUID(),
      scope,
      obs: s.obs,
      attempts: 0,
      queuedAt: now.toISOString(),
    };
    lines.push(`${JSON.stringify(line)}\n`);
  }
  if (lines.length === 0) return { queued: 0, dropped };
  const dir = queueDir(home);
  ensurePrivateDir(dir);
  const file = path.join(dir, `${queueName(session)}.jsonl`);
  const data = lines.join('');
  const r = withShortLock(`${file}.lock`, APPEND_LOCK_WAIT_MS, () => appendPrivateFile(file, data));
  if (!r.ok) {
    const segment = path.join(
      dir,
      `${queueName(session)}.${process.pid}-${randomBytes(4).toString('hex')}.jsonl`,
    );
    appendPrivateFile(segment, data);
  }
  return { queued: lines.length, dropped };
}

function queueFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: { name: string; mtime: number }[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.jsonl')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) files.push({ name, mtime: st.mtimeMs });
    } catch {
      // Removed by a concurrent drain.
    }
  }
  files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files.map((f) => f.name);
}

function countLines(dir: string): number {
  let n = 0;
  for (const name of queueFiles(dir)) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const l of text.split('\n')) if (l.length > 0) n++;
    } catch {
      // Gone.
    }
  }
  return n;
}

/** True when some queue file is waiting to be drained. */
export function hasPendingQueue(home: string): boolean {
  return queueFiles(queueDir(home)).length > 0;
}

function parseLine(raw: string): QueueLine | undefined {
  try {
    const r = QueueLineSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Takes the drain lock, breaking one older than ten minutes; null when another drain holds it. */
function acquireDrainLock(lock: string): number | null {
  try {
    return fs.openSync(lock, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= DRAIN_LOCK_STALE_MS) return null;
    unlinkQuietly(lock);
    return fs.openSync(lock, 'wx', 0o600);
  } catch {
    return null;
  }
}

export interface DrainResult {
  processed: number;
  failed: number;
  remaining: number;
}

/**
 * Observes queued lines, oldest file first, at most 50 per run, under the
 * drain lock. A line that observed is removed; one whose observe threw keeps
 * its place with `attempts + 1`, and moves to `dead/` at the third failure.
 * Without embed, decide and write adapters the queue is left untouched.
 */
export async function drainQueue(deps: HookDeps): Promise<DrainResult> {
  const t0 = performance.now();
  const dir = queueDir(deps.config.home);
  const logBase = { event: 'drain', session: null, project: null } as const;
  const { embed, decide, write } = deps;
  if (embed === undefined || decide === undefined || write === undefined) {
    const remaining = countLines(dir);
    deps.log.write({
      ...logBase,
      outcome: 'drain skipped: missing adapters',
      counts: { remaining },
      timings: { totalMs: performance.now() - t0 },
    });
    return { processed: 0, failed: 0, remaining };
  }
  if (queueFiles(dir).length === 0) {
    deps.log.write({
      ...logBase,
      outcome: 'ok',
      counts: { processed: 0, failed: 0, remaining: 0 },
      timings: { totalMs: performance.now() - t0 },
    });
    return { processed: 0, failed: 0, remaining: 0 };
  }

  const lockPath = path.join(dir, '.lock');
  const lock = acquireDrainLock(lockPath);
  if (lock === null) {
    const remaining = countLines(dir);
    deps.log.write({
      ...logBase,
      outcome: 'locked',
      counts: { remaining },
      timings: { totalMs: performance.now() - t0 },
    });
    return { processed: 0, failed: 0, remaining };
  }

  let processed = 0;
  let failed = 0;
  let budget = DRAIN_MAX_PER_RUN;
  let consecutive = 0;
  let deadCount = 0;
  const deadIds: string[] = [];
  try {
    fs.writeSync(lock, `${process.pid}\n`);
    for (const name of queueFiles(dir)) {
      if (budget === 0 || consecutive >= CIRCUIT_BREAKER) break;
      const file = path.join(dir, name);
      let buf: Buffer;
      try {
        buf = fs.readFileSync(file);
      } catch {
        continue;
      }
      // Only complete lines; a trailing partial line is left for later.
      const end = buf.lastIndexOf(0x0a) + 1;
      const lines = buf.subarray(0, end).toString('utf8').split('\n');
      lines.pop();
      const keep: string[] = [];
      const dead: string[] = [];
      for (const raw of lines) {
        if (raw.length === 0) continue;
        if (budget === 0 || consecutive >= CIRCUIT_BREAKER) {
          keep.push(raw);
          continue;
        }
        const line = parseLine(raw);
        if (line === undefined) {
          dead.push(raw);
          failed++;
          continue;
        }
        budget--;
        try {
          await observe(line.obs, line.scope, {
            store: deps.store,
            embed,
            decide,
            write,
            config: deps.config,
            now: deps.now?.() ?? new Date(),
            harness: 'claude-code',
          });
          processed++;
          consecutive = 0;
        } catch {
          failed++;
          consecutive++;
          const next = JSON.stringify({ ...line, attempts: line.attempts + 1 });
          if (line.attempts + 1 >= MAX_ATTEMPTS) {
            dead.push(next);
            deadIds.push(line.id);
          } else {
            keep.push(next);
          }
        }
        try {
          const now = new Date();
          fs.futimesSync(lock, now, now);
        } catch {
          // Best effort: keeps a long run from looking stale.
        }
      }
      if (dead.length > 0) {
        deadCount += dead.length;
        appendPrivateFile(path.join(dir, 'dead', name), dead.map((l) => `${l}\n`).join(''));
      }
      const committed = withShortLock(`${file}.lock`, COMMIT_LOCK_WAIT_MS, () => {
        let current: Buffer;
        try {
          current = fs.readFileSync(file);
        } catch {
          current = Buffer.alloc(0);
        }
        // Appends only ever grow the file; everything past `end` arrived during this run.
        const tail = current.subarray(Math.min(end, current.length));
        const out = Buffer.concat([Buffer.from(keep.map((l) => `${l}\n`).join(''), 'utf8'), tail]);
        if (out.length === 0) unlinkQuietly(file);
        else writeFileAtomic(file, out, 0o600);
      });
      if (!committed.ok) {
        // Lines stay queued and are observed again next run; a duplicate is reconciled.
        deps.log.write({ ...logBase, outcome: 'commit-lock-busy', counts: {}, timings: {} });
      }
    }
  } finally {
    fs.closeSync(lock);
    unlinkQuietly(lockPath);
  }

  if (deadCount > 0) {
    deps.log.write({
      ...logBase,
      outcome: 'dead-lettered',
      counts: { lines: deadCount },
      timings: {},
      ids: deadIds,
    });
  }
  const remaining = countLines(dir);
  deps.log.write({
    ...logBase,
    outcome: 'ok',
    counts: { processed, failed, remaining },
    timings: { totalMs: performance.now() - t0 },
  });
  return { processed, failed, remaining };
}
