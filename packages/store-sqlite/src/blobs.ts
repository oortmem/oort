import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ensurePrivateDir } from '@oortmem/core';

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

/** Runs every unlink, best effort; returns the failures (missing files are not failures). */
function unlinkEach(files: readonly string[]): unknown[] {
  const failures: unknown[] = [];
  for (const file of files) {
    try {
      unlinkQuietly(file);
    } catch (e) {
      failures.push(e);
    }
  }
  return failures;
}

/**
 * Returns `original`, the error the caller must see, with any cleanup
 * failures attached as its `cause` (an `AggregateError`; a cause it already
 * had becomes that error's cause). A non-Error is returned unchanged.
 */
export function withCleanupFailures(original: unknown, failures: readonly unknown[]): unknown {
  if (failures.length === 0 || !(original instanceof Error)) return original;
  const previous = original.cause;
  original.cause = new AggregateError(
    failures,
    `cold blob cleanup: ${failures.length} unlink(s) failed`,
    previous === undefined ? undefined : { cause: previous },
  );
  return original;
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
async function openExclusive(file: string): Promise<fsp.FileHandle> {
  try {
    return await fsp.open(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    unlinkQuietly(file);
    return await fsp.open(file, 'wx', 0o600);
  }
}

/**
 * Durability note. Blob files are NOT fsynced individually; the rename and one
 * directory fsync per batch are kept. Per-file fsync cost about 12 ms each and
 * made the first consolidate of 10k memories take 60 s (25 s even with 8
 * fsyncs in parallel). A cold blob holds the embedding and a snapshot only:
 * the database row keeps text, stub and entities. After a power loss a blob
 * may be torn or empty; the v2 frame's CRC32 detects that, `coldGet` returns
 * null (logged), and recall falls back to the live row. Worst case the
 * embedding is lost and must be re-derived. A process crash loses nothing
 * (the page cache survives it). The database itself keeps its WAL durability.
 */

/** Blobs written at once: bounds open file handles. */
const WRITE_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight; every started task settles before this does. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i] as T, i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
  /**
   * Writes a new uniquely named blob per item: temp files written with bounded
   * parallelism, then all renamed, then one directory fsync. The files
   * themselves are not fsynced (see the durability note above).
   * Returns the file names in input order. On any failure every file this call
   * created is removed and the error is rethrown.
   */
  writeMany(items: readonly { id: string; data: Uint8Array }[]): Promise<string[]>;
  /** The blob's bytes, or null when it is missing or `name` is not a blob name. */
  read(name: string): Buffer | null;
  /** Removes a blob; missing files and non-blob names are ignored. */
  remove(name: string): void;
  /**
   * `remove` for every name, best effort: one failing unlink does not stop the
   * rest. Returns the failures (empty when all went).
   */
  removeAll(names: readonly string[]): unknown[];
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
  if (ensurePrivateDir(dir)) log('oort store: tightened permissions to 0700 on the cold directory');
  const marker = path.join(dir, MARKER);
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(dir).length === 0) fs.closeSync(fs.openSync(marker, 'a', 0o600));
    else log(`oort: ${dir} has no ${MARKER} marker; orphan cold blob sweep disabled`);
  }

  return {
    async writeMany(items) {
      const names = items.map(
        ({ id }) => `${safeId(id)}.${process.pid}-${randomBytes(4).toString('hex')}.zst`,
      );
      const tmpOf = (name: string): string => path.join(dir, `${name}.tmp`);
      const renamed: string[] = [];
      // Best effort over every file this call created; never masks the original error.
      const cleanup = (): unknown[] =>
        unlinkEach(
          names.flatMap((name) =>
            renamed.includes(name) ? [tmpOf(name), path.join(dir, name)] : [tmpOf(name)],
          ),
        );
      try {
        const written = await mapBounded(items, WRITE_CONCURRENCY, async ({ data }, i) => {
          const fh = await openExclusive(tmpOf(names[i] as string));
          try {
            await fh.writeFile(data);
          } finally {
            await fh.close();
          }
        });
        for (const r of written) if (r.status === 'rejected') throw r.reason;
        for (const name of names) {
          await fsp.rename(tmpOf(name), path.join(dir, name));
          renamed.push(name);
        }
        fsyncDir(dir);
      } catch (e) {
        throw withCleanupFailures(e, cleanup());
      }
      return names;
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

    removeAll(names) {
      return unlinkEach(names.filter((n) => BLOB_NAME.test(n)).map((n) => path.join(dir, n)));
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
