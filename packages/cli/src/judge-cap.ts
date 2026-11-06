import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The daily cap on judgments an agent records in an expert's name (CON-71, CON-108 §6.3): one
 * counter per Oort home, shared by the MCP server and the SDK's agent role. The file and lock
 * names are 0.5.x's (`judge-mcp-count.json`, `.lock`), so every version counts against one cap.
 */

/** Judgments agents may record per day, per Oort home (MCP and the SDK together). */
export const AGENT_JUDGMENTS_PER_DAY = 50;

const counterFile = (home: string): string => path.join(home, 'judge-mcp-count.json');

const lockFile = (home: string): string => path.join(home, 'judge-mcp-count.lock');

/** A lock file older than this is left over from a crashed process and is taken over. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

/**
 * Why a slot could not be taken: `daily-limit` (the cap is reached) or `unavailable` (the counter
 * could not be read, written or locked, so nothing may be saved). Callers word it for their users.
 */
export class AgentJudgmentCapError extends Error {
  readonly kind: 'daily-limit' | 'unavailable';
  constructor(kind: 'daily-limit' | 'unavailable') {
    super(
      kind === 'daily-limit'
        ? `agents already recorded ${AGENT_JUDGMENTS_PER_DAY} judgments today`
        : 'the daily judgment count could not be kept',
    );
    this.name = 'AgentJudgmentCapError';
    this.kind = kind;
  }
}

/**
 * What identifies one lock file: its content (a token unique to the holder; empty for a 0.5.x
 * lock), modification time and inode. The inode alone is not enough: Linux reuses a deleted
 * file's inode at once, so a fresh lock can carry the stale one's number.
 */
export interface LockId {
  token: string;
  mtimeMs: number;
  ino: number;
}

/** The lock at `file` as `LockId`, or undefined when it is gone or unreadable. */
export function lockIdOf(file: string): LockId | undefined {
  try {
    const st = fs.statSync(file);
    return { token: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return undefined;
  }
}

const sameLock = (a: LockId, b: LockId): boolean =>
  a.token === b.token && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

/**
 * Removes the lock at `file` only if it is still the one `seen` describes. It is first renamed
 * to a unique name, which is atomic, and checked there: a lock another process created in the
 * meantime is put back instead of deleted. So two waiters that both found the same stale lock
 * can never delete each other's fresh one. True when removed.
 */
export function removeLockIfSame(file: string, seen: LockId): boolean {
  const aside = `${file}.${process.pid}.${randomUUID()}.aside`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false; // Already gone.
  }
  try {
    const now = lockIdOf(aside);
    if (now !== undefined && sameLock(now, seen)) return true;
    // Someone else's lock: back where it was. Should yet another lock have appeared in the
    // microseconds between the rename and this link, the link fails and that newer lock stands.
    try {
      fs.linkSync(aside, file);
    } catch {
      // See above.
    }
    return false;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** In-process queue per home, so calls in one process never race each other for the lock file. */
const homeQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` holding this home's counter lock: an in-process queue, then an exclusive lock file
 * (for other processes: another MCP server, another host, an app using the SDK). Refuses when the
 * lock can't be taken.
 */
async function withCounterLock<T>(home: string, fn: () => T): Promise<T> {
  const prev = homeQueues.get(home) ?? Promise.resolve();
  const run = prev.then(async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = lockFile(home);
    const start = Date.now();
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = fs.openSync(file, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new AgentJudgmentCapError('unavailable');
        }
        const seen = lockIdOf(file); // undefined: gone in between, so try again.
        // Only the stale lock we looked at is taken over, never a fresh one that replaced it.
        if (seen !== undefined && Date.now() - seen.mtimeMs > STALE_LOCK_MS) {
          removeLockIfSame(file, seen);
        }
        if (Date.now() - start > LOCK_WAIT_MS) throw new AgentJudgmentCapError('unavailable');
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const token = `${process.pid}.${randomUUID()}`;
    let mine: LockId;
    try {
      fs.writeSync(fd, token);
      const st = fs.fstatSync(fd);
      mine = { token, mtimeMs: st.mtimeMs, ino: st.ino };
    } catch {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw new AgentJudgmentCapError('unavailable');
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      // Our own lock only: if a waiter took it over as stale, the lock there now is theirs.
      removeLockIfSame(file, mine);
    }
  });
  // The queue continues whatever this call's outcome.
  homeQueues.set(
    home,
    run.catch(() => {}),
  );
  return run;
}

/** Today's count, read under the lock. A missing file is 0; an unreadable one is a refusal. */
function readCounter(home: string, day: string): number {
  let text: string;
  try {
    text = fs.readFileSync(counterFile(home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new AgentJudgmentCapError('unavailable');
  }
  try {
    const raw = JSON.parse(text) as { day?: unknown; count?: unknown };
    return raw.day === day && typeof raw.count === 'number' && raw.count >= 0 ? raw.count : 0;
  } catch {
    throw new AgentJudgmentCapError('unavailable');
  }
}

/** Writes the count atomically (a temporary file, then a rename); a failure is a refusal. */
function writeCounter(home: string, day: string, count: number): void {
  const tmp = `${counterFile(home)}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ day, count }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, counterFile(home));
  } catch {
    fs.rmSync(tmp, { force: true });
    throw new AgentJudgmentCapError('unavailable');
  }
}

/**
 * Takes one of `day`'s slots (under a lock, persisted) before anything is written, or rejects
 * with `AgentJudgmentCapError` at the cap; concurrent calls can never exceed it.
 */
export async function reserveAgentJudgment(home: string, day: string): Promise<void> {
  await withCounterLock(home, () => {
    const used = readCounter(home, day);
    if (used >= AGENT_JUDGMENTS_PER_DAY) throw new AgentJudgmentCapError('daily-limit');
    writeCounter(home, day, used + 1);
  });
}

/** Gives a slot back (the write was unchanged or failed). Best effort. */
export async function refundAgentJudgment(home: string, day: string): Promise<void> {
  try {
    await withCounterLock(home, () => {
      const used = readCounter(home, day);
      if (used > 0) writeCounter(home, day, used - 1);
    });
  } catch {
    // The slot stays taken: the cap errs on the safe side.
  }
}
