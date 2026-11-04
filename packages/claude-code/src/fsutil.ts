import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';

export function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Replaces `file` atomically: write a temp file beside it (with `mode`), fsync, rename. */
export function writeFileAtomic(file: string, data: string | Buffer, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try {
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fs.fsyncSync(fd);
      if (process.platform !== 'win32') fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    unlinkQuietly(tmp);
    throw e;
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** A short-held lock older than this belongs to a crashed process. */
const SHORT_LOCK_STALE_MS = 30_000;

/**
 * Runs `fn` while holding the exclusive lock file `lock` (created with `wx`),
 * waiting up to `waitMs` for it. For locks held only around a few file
 * operations, never across adapter calls. Returns `{ ok: false }` when the
 * lock could not be taken in time; `fn` then did not run.
 */
export function withShortLock<T>(
  lock: string,
  waitMs: number,
  fn: () => T,
): { ok: true; value: T } | { ok: false } {
  const deadline = Date.now() + waitMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > SHORT_LOCK_STALE_MS) {
          unlinkQuietly(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return { ok: false };
      sleepSync(2);
    }
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    fs.closeSync(fd);
    unlinkQuietly(lock);
  }
}
