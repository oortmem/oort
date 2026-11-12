/**
 * The one-time erase of text deleted before this version (CON-140). Oort 0.9.0 and older ran
 * without `secure_delete`, so a forgotten or rewritten memory's text can still sit in a free page
 * of `oort.sqlite`, and the lexical index keeps a deleted row's terms until its segments merge.
 * A store gets one pass: zero vectors (CON-141) deleted, the lexical index merged, then `VACUUM`,
 * which rewrites the file from its live rows only, and the WAL truncated. `meta` records it.
 *
 * A store created by this version needs none and is recorded at once. An open that may migrate
 * runs the pass on a store up to `ERASE_AUTO_MAX_BYTES`; a larger one waits for `eraseOldText:
 * 'now'` (`oort doctor --vacuum`), so no MCP server or command stalls on a big file unasked. An
 * open that may not migrate (a hook) never runs it.
 */
import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { BIT_TABLE, FTS_TABLE, hasBinaryIndex } from './schema.js';

/** Where `meta` records the pass (an ISO time). */
export const ERASED_KEY = 'old_text_erased';

/** An open runs the pass by itself on a store file up to this size (32 MiB; under a second). */
export const ERASE_AUTO_MAX_BYTES = 32 * 1024 * 1024;

const exists = (db: Database.Database, name: string): boolean =>
  db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;

/** True when the store has had the pass (or was created by a version that needs none). */
export function oldTextErased(db: Database.Database): boolean {
  if (!exists(db, 'meta')) return false;
  return db.prepare('SELECT 1 FROM meta WHERE key = ?').get(ERASED_KEY) !== undefined;
}

/** Records the pass as done, without running it: for a store this version created. */
export function markOldTextErased(db: Database.Database, at: Date): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(ERASED_KEY, at.toISOString());
}

/** How many stored vectors are all zeros (they match nothing; CON-141). */
export function zeroVectorCount(db: Database.Database, dimension: number): number {
  if (!exists(db, 'memories_vec')) return 0;
  const n = db
    .prepare<[number], { n: number }>(
      'SELECT count(*) AS n FROM memories_vec WHERE embedding = zeroblob(?)',
    )
    .get(dimension);
  return n?.n ?? 0;
}

/**
 * Runs the pass: deletes zero vectors, merges the lexical index, `VACUUM`s, truncates the WAL
 * and records it. False, recording nothing, when another connection holds the database (`VACUUM`
 * cannot run) or is mid-read (the checkpoint cannot finish); the next open that may migrate
 * tries again.
 */
export function eraseOldText(db: Database.Database, dimension: number, at: Date): boolean {
  db.transaction(() => {
    const zero = db
      .prepare<[number], { id: string }>(
        'SELECT id FROM memories_vec WHERE embedding = zeroblob(?)',
      )
      .all(dimension)
      .map((r) => r.id);
    const del = db.prepare('DELETE FROM memories_vec WHERE id = ?');
    const delBit = hasBinaryIndex(db) ? db.prepare(`DELETE FROM ${BIT_TABLE} WHERE id = ?`) : null;
    for (const id of zero) {
      del.run(id);
      delBit?.run(id);
    }
    if (exists(db, FTS_TABLE))
      db.prepare(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('optimize')`).run();
  }).immediate();
  try {
    db.exec('VACUUM');
  } catch {
    return false;
  }
  // The rewrite is in the WAL until a checkpoint copies it back; a reader mid-read keeps that
  // from finishing, and the main file still holds the old pages. Pending then: the next open
  // retries.
  const r = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
  if (r[0]?.busy !== 0) return false;
  markOldTextErased(db, at);
  return true;
}

/** The size of the store's file and its WAL, in bytes. */
export function storeBytes(dbPath: string): number {
  let n = 0;
  for (const suffix of ['', '-wal']) {
    try {
      n += fs.statSync(`${dbPath}${suffix}`).size;
    } catch {
      // No WAL yet.
    }
  }
  return n;
}
