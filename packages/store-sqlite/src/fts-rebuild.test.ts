/**
 * The lexical index rebuild of schema version 4 (tokeniser v2, CON-110), on copies of the real
 * version 3 store in `test/fixtures/schema3`: what the rebuild leaves behind, and how it behaves
 * under load, interruption and concurrency.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { tokenizeLexicalV1 } from '@oortmem/core';
import { openSqliteStore, sqliteSchemaVersion } from './index.js';

const FIXTURE3 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/schema3',
);
const DIM = 8;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-fts-rebuild-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

export function copy3(): { dir: string; dbPath: string; coldDir: string } {
  const dir = fs.mkdtempSync(path.join(root, 'store3-'));
  fs.cpSync(FIXTURE3, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'expected.json'));
  return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}

const optsFor = (s: { dbPath: string; coldDir: string }) => ({
  path: s.dbPath,
  coldDir: s.coldDir,
  dimension: DIM,
  now: () => new Date('2026-11-01T00:00:00.000Z'),
  log: () => {},
});

function raw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

/** The lexical index's table: `memories_fts` (versions 1 to 3) or its version 4 successor. */
function ftsName(db: Database.Database): string {
  const row = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%fts5%' ORDER BY name`,
    )
    .get();
  if (row === undefined) throw new Error('no FTS table');
  return row.name;
}

/** SQLite varints, as FTS5 writes them in its averages record. */
function varints(buf: Buffer): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < buf.length) {
    let v = 0;
    for (let k = 0; k < 9 && i < buf.length; k++) {
      const c = buf[i++] as number;
      if (k === 8) {
        v = v * 256 + c;
        break;
      }
      v = v * 128 + (c & 0x7f);
      if ((c & 0x80) === 0) break;
    }
    out.push(v);
  }
  return out;
}

/** FTS5's row count (BM25's N) from the averages record, and the index's size in bytes. */
function ftsStats(dbPath: string): { rows: number; memories: number; bytes: number } {
  const db = raw(dbPath);
  try {
    const t = ftsName(db);
    const avg = db.prepare<[], { block: Buffer }>(`SELECT block FROM ${t}_data WHERE id = 1`).get();
    const bytes = db
      .prepare<[], { n: number }>(`SELECT coalesce(sum(length(block)), 0) AS n FROM ${t}_data`)
      .get()?.n;
    const memories = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM memories').get()?.n;
    return {
      rows: avg === undefined ? 0 : (varints(avg.block)[0] ?? 0),
      memories: memories ?? 0,
      bytes: bytes ?? 0,
    };
  } finally {
    db.close();
  }
}

/**
 * Rewrites every FTS row of a version 3 store `times` times, as tier changes and updates do.
 * A contentless-delete index never subtracts a deleted row from its totals, so this is the
 * history a long-lived store carries.
 */
function rewriteHistory(dbPath: string, times: number): void {
  const db = raw(dbPath);
  try {
    const rows = db
      .prepare<[], { rid: number; tier: string; text: string; stub: string; entities: string }>(
        'SELECT rid, tier, text, stub, entities FROM memories',
      )
      .all();
    const del = db.prepare<[number]>('DELETE FROM memories_fts WHERE rowid = ?');
    const ins = db.prepare<[number, string, string, string]>(
      'INSERT INTO memories_fts (rowid, text, stub, entities) VALUES (?, ?, ?, ?)',
    );
    const v1 = (s: string) => tokenizeLexicalV1(s).join(' ');
    db.transaction(() => {
      for (let i = 0; i < times; i++) {
        for (const r of rows) {
          del.run(r.rid);
          ins.run(
            r.rid,
            r.tier === 'cold' ? '' : v1(r.text),
            v1(r.stub),
            v1((JSON.parse(r.entities) as string[]).join(' ')),
          );
        }
      }
    })();
  } finally {
    db.close();
  }
}

describe('lexical index rebuild (schema version 4)', () => {
  it('fts-rebuild.starts-from-the-live-rows', async () => {
    const s = copy3();
    rewriteHistory(s.dbPath, 50);
    const before = ftsStats(s.dbPath);
    expect(before.rows).toBeGreaterThan(before.memories * 50);
    await (await openSqliteStore(optsFor(s))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(4);
    const after = ftsStats(s.dbPath);
    // BM25's row count is the live rows: no history carried over, nothing to grow with it.
    expect(after.rows).toBe(after.memories);
    expect(after.bytes).toBeLessThan(before.bytes);
    // Optimised: one segment, as small as a fresh index of the same rows.
    const fresh = copy3();
    await (await openSqliteStore(optsFor(fresh))).close();
    expect(after.bytes).toBe(ftsStats(fresh.dbPath).bytes);
  });
});
