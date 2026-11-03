import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The file layer under the SQLite store: owner-only directories and files,
 * atomic unique-per-write cold blobs, and the crash-leftover sweep. No SQL here.
 */

export type Log = (message: string) => void;

/** A `.zst.tmp` older than this is a crashed write. */
const STALE_TMP_MS = 60 * 60 * 1000;
/**
 * An unreferenced blob younger than this may belong to another process's
 * `coldPut` that has renamed it but not yet committed (the commit can wait up
 * to the 5 s busy timeout), so the sweep leaves it for a later open.
 */
const ORPHAN_GRACE_MS = 60 * 1000;

/** Marks a directory as an Oort cold directory; the sweep never runs without it. */
const MARKER = '.oort-cold';

/**
 * `<safeId>.<pid>-<rand>.zst`, optionally `.tmp`. Unique per write, so one
 * `coldPut` never overwrites, and a sweep or unlink never hits, another
 * write's file. The sweep touches nothing that does not match.
 */
const BLOB_NAME = /^(?:[a-z0-9_-]{1,128}|~[0-9a-f]{64})\.\d+-[0-9a-f]{8}\.zst(\.tmp)?$/;

/** Ids that are safe, case-insensitive-unique file names are used as is; anything else is hashed. */
function safeId(id: string): string {
  return /^[a-z0-9_-]{1,128}$/.test(id) ? id : `~${createHash('sha256').update(id).digest('hex')}`;
}

export function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function chmodIfExists(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * The database's directory. One the store creates is owner-only. An existing
 * one (often a project root) is the caller's: it is never chmodded, only
 * warned about when group or others can read it.
 */
export function prepareDbDir(dir: string, log: Log): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077) !== 0) {
    log(`oort: ${dir} is readable by group/others; memory files inside are 0600`);
  }
}

/** Creates `dir` owner-only, or tightens an existing one; returns true when it had to tighten. */
function ensureOwnerDir(dir: string): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return false;
  if ((fs.statSync(dir).mode & 0o077) === 0) return false;
  fs.chmodSync(dir, 0o700);
  return true;
}

/**
 * Runs `fn` with umask 077 so files SQLite creates (`-wal`, `-shm`) are
 * owner-only. The umask is process-global: while `fn` runs (synchronously),
 * files created by other threads of this process also get 077. Worker threads
 * cannot set it at all; there the explicit chmods after open are the only guard.
 */
export function withPrivateUmask<T>(fn: () => T): T {
  let previous: number | undefined;
  try {
    previous = process.umask(0o077);
  } catch {
    previous = undefined;
  }
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.umask(previous);
  }
}

/** Opens a new owner-only file exclusively; a leftover file at `file` is removed and the open retried once. */
function openExclusive(file: string): number {
  try {
    return fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    unlinkQuietly(file);
    return fs.openSync(file, 'wx', 0o600);
  }
}

/** Best-effort fsync of a directory so a rename survives a crash (not supported everywhere). */
function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Windows cannot open directories; the rename is still atomic.
  }
}

export interface BlobDir {
  /** Writes a new blob for `id` atomically (tmp, fsync, rename) and returns its file name. */
  write(id: string, data: Uint8Array): string;
  /** The blob's bytes, or null when it is missing or `name` is not a blob name. */
  read(name: string): Buffer | null;
  /** Removes a blob; missing files and non-blob names are ignored. */
  remove(name: string): void;
  /**
   * Removes crash leftovers: blob temp files older than an hour, and blobs not
   * in `referenced` older than a minute. Only when the directory carries the
   * marker, and only files matching the blob-name pattern. Logs counts only.
   */
  sweep(referenced: ReadonlySet<string>): void;
}

/**
 * Opens the cold directory, creating it owner-only (or tightening it). The
 * marker is written when the directory is new or empty; a populated directory
 * without one is not swept, so a misconfigured shared directory loses nothing.
 */
export function openBlobDir(dir: string, log: Log): BlobDir {
  if (ensureOwnerDir(dir)) log('oort store: tightened permissions to 0700 on the cold directory');
  const marker = path.join(dir, MARKER);
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(dir).length === 0) fs.closeSync(fs.openSync(marker, 'a', 0o600));
    else log(`oort: ${dir} has no ${MARKER} marker; orphan cold blob sweep disabled`);
  }

  return {
    write(id, data) {
      const base = `${safeId(id)}.${process.pid}-${randomBytes(4).toString('hex')}`;
      const name = `${base}.zst`;
      const tmp = path.join(dir, `${name}.tmp`);
      const fd = openExclusive(tmp);
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmp, path.join(dir, name));
      } catch (e) {
        unlinkQuietly(tmp);
        throw e;
      }
      fsyncDir(dir);
      return name;
    },

    read(name) {
      if (!BLOB_NAME.test(name) || name.endsWith('.tmp')) return null;
      try {
        return fs.readFileSync(path.join(dir, name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    remove(name) {
      if (BLOB_NAME.test(name)) unlinkQuietly(path.join(dir, name));
    },

    sweep(referenced) {
      if (!fs.existsSync(marker)) return;
      const now = Date.now();
      let tmps = 0;
      let orphans = 0;
      for (const name of fs.readdirSync(dir)) {
        const m = BLOB_NAME.exec(name);
        if (m === null) continue;
        const isTmp = m[1] !== undefined;
        if (!isTmp && referenced.has(name)) continue;
        let age: number;
        try {
          age = now - fs.statSync(path.join(dir, name)).mtimeMs;
        } catch {
          continue;
        }
        if (age < (isTmp ? STALE_TMP_MS : ORPHAN_GRACE_MS)) continue;
        unlinkQuietly(path.join(dir, name));
        if (isTmp) tmps++;
        else orphans++;
      }
      if (tmps + orphans > 0) {
        log(`oort store: removed ${orphans} orphan cold blob(s) and ${tmps} stale temp file(s)`);
      }
    },
  };
}
