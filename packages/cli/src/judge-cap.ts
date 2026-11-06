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
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS)
            fs.rmSync(file, { force: true });
        } catch {
          // Gone in between: try again.
        }
        if (Date.now() - start > LOCK_WAIT_MS) throw new AgentJudgmentCapError('unavailable');
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
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
