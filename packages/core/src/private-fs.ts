import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Owner-only file helpers shared by the store and the harness integrations:
 * directories Oort creates under `OORT_HOME` are 0700, files are 0600.
 * POSIX permissions only; on Windows the mode bits are not enforced.
 */

const posix = process.platform !== 'win32';

/** Creates `dir` (and parents) owner-only, or tightens an existing one; returns true when it had to tighten. */
export function ensurePrivateDir(dir: string): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!posix) return false;
  if ((fs.statSync(dir).mode & 0o077) === 0) return false;
  fs.chmodSync(dir, 0o700);
  return true;
}

/** Tightens an open file to 0600 when group or others have any access. */
function tightenFd(fd: number): void {
  if (posix && (fs.fstatSync(fd).mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
}

/**
 * Appends `data` to `file`, creating it 0600 (and its directory 0700). An
 * existing file with wider permissions is tightened to 0600.
 */
export function appendPrivateFile(file: string, data: string): void {
  ensurePrivateDir(path.dirname(file));
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    tightenFd(fd);
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replaces `file` with `data` atomically: a 0600 temp file beside it, then a
 * rename (its directory is created 0700). Readers see the old or the new
 * content, never a partial write.
 */
export function writePrivateFile(file: string, data: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      tightenFd(fd);
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already renamed or never created: nothing to clean up.
    }
    throw e;
  }
}
