import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * The copies a store takes of its database before changing its schema:
 * `pre-v2` before migrating a version 1 store, `pre-v3` before migrating a
 * version 2 store, `pre-v4` before migrating a version 3 store, `pre-v5` before migrating a
 * version 4 store, `pre-downgrade` before taking a
 * store back to an older version.
 */
export type BackupKind = 'pre-v2' | 'pre-v3' | 'pre-v4' | 'pre-v5' | 'pre-downgrade';

/** How many of the newest copies of each kind are kept. */
export const BACKUPS_KEPT = 3;

/** `20261105T131500123Z`: UTC, sortable as text. */
function stamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, '');
}

/** The copies of `kind` next to `dbPath`, oldest first (their names sort by time). */
export function listBackups(dbPath: string, kind: BackupKind): string[] {
  const dir = path.dirname(path.resolve(dbPath));
  const prefix = `${path.basename(dbPath)}.${kind}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(
      (n) => n.startsWith(prefix) && /^\d{8}T\d{9}Z(-[0-9a-f]+)?$/.test(n.slice(prefix.length)),
    )
    .sort()
    .map((n) => path.join(dir, n));
}

function fsyncPath(p: string, flags: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, flags);
    fs.fsyncSync(fd);
  } catch (e) {
    // Directories cannot be opened or synced on Windows; the rename is still atomic there.
    if (!(process.platform === 'win32' && flags === 'r')) throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const memoryCount = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;

/**
 * Copies the open database `db` (at `dbPath`) to a new, uniquely named,
 * owner-only file `<dbPath>.<kind>.<UTC time>`, and returns its path. The
 * copy is taken with `VACUUM INTO` (a consistent snapshot that includes
 * whatever is still in the WAL), written to a randomly named temporary file,
 * fsynced, opened again to check it holds as many memories as the store,
 * and only then renamed into place (the directory is fsynced around the
 * rename). The temporary file is always removed. Throws, leaving no new
 * file behind, when any step fails.
 *
 * Afterwards only the `BACKUPS_KEPT` newest copies of `kind` stay, plus,
 * for a migration, the oldest one (the copy of the store before it first migrated).
 * Must run outside a transaction.
 */
export function backupDatabase(db: Database.Database, dbPath: string, kind: BackupKind): string {
  const file = path.resolve(dbPath);
  const dir = path.dirname(file);
  let target = `${file}.${kind}.${stamp(new Date())}`;
  if (fs.existsSync(target)) target = `${target}-${randomBytes(4).toString('hex')}`;
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${kind}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.chmodSync(tmp, 0o600);
    fsyncPath(tmp, 'r+');
    const want = memoryCount(db);
    const copy = new Database(tmp, { readonly: true, fileMustExist: true });
    let got: number;
    try {
      got = memoryCount(copy);
    } finally {
      copy.close();
    }
    if (got !== want) throw new Error(`the copy holds ${got} memories, the store ${want}`);
    fsyncPath(dir, 'r');
    fs.renameSync(tmp, target);
    fsyncPath(dir, 'r');
  } catch (e) {
    throw new Error(
      `sqlite store: could not copy ${file} to ${target} before ${kind === 'pre-downgrade' ? 'downgrading' : 'migrating'} it (${(e as Error).message}); nothing was changed`,
      { cause: e },
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  prune(file, kind);
  return target;
}

/** A temporary copy older than this is one a killed process left; a live copy is never this old. */
export const STALE_COPY_MS = 3600_000;

/**
 * Removes the temporary copies (and their rollback journals) that a process killed during
 * `backupDatabase` left next to `dbPath`, once they are over an hour old: `VACUUM INTO` writes
 * `.<name>.<kind>.<16 hex>.tmp`, and the rename into place never happened. Best effort; returns
 * how many were removed.
 */
export function sweepStaleCopies(dbPath: string, now = Date.now()): number {
  const file = path.resolve(dbPath);
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^\\.${base}\\.(?:pre-v\\d+|pre-downgrade)\\.[0-9a-f]{16}\\.tmp(?:-journal|-wal|-shm)?$`,
  );
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    if (!pattern.test(n)) continue;
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs < STALE_COPY_MS) continue;
      fs.rmSync(p, { force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
  return removed;
}

/** Removes all but the newest copies of `kind` (and the oldest migration copy). Best effort. */
function prune(dbPath: string, kind: BackupKind): void {
  const all = listBackups(dbPath, kind);
  const keep = new Set(all.slice(-BACKUPS_KEPT));
  if (kind !== 'pre-downgrade' && all[0] !== undefined) keep.add(all[0]);
  for (const f of all) {
    if (!keep.has(f)) fs.rmSync(f, { force: true });
  }
}
