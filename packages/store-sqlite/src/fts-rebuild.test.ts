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

/** A child process that holds the store's write lock for `ms`, then commits and exits. */
async function holdWriteLock(dbPath: string, ms: number): Promise<{ done: Promise<void> }> {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require('better-sqlite3'); const db = new D(process.argv[1]);
       db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
       db.exec('COMMIT'); db.close();`,
      dbPath,
      String(ms),
    ],
    { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (b: Buffer) => b.toString().includes('locked') && resolve());
    child.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return { done: new Promise((resolve) => child.on('exit', () => resolve())) };
}

/** Puts a marker row in the lexical index; a rebuild drops it, anything else keeps it. */
function mark(dbPath: string): () => boolean {
  const db = raw(dbPath);
  try {
    db.prepare(
      `INSERT INTO ${ftsName(db)} (rowid, text, stub, entities) VALUES (-99, 'zzmarker', '', '')`,
    ).run();
  } finally {
    db.close();
  }
  return () => {
    const d = raw(dbPath);
    try {
      const t = ftsName(d);
      return d.prepare(`SELECT rowid FROM ${t} WHERE ${t} MATCH 'zzmarker'`).all().length > 0;
    } finally {
      d.close();
    }
  };
}

function setMeta(dbPath: string, key: string, value: string): void {
  const db = raw(dbPath);
  try {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
  } finally {
    db.close();
  }
}

const getMeta = (dbPath: string, key: string): string | undefined => {
  const db = raw(dbPath);
  try {
    return db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(key)
      ?.value;
  } finally {
    db.close();
  }
};

describe('rebuild cost (CON-110 review)', () => {
  it('fts-rebuild.says-it-is-rebuilding', async () => {
    const s = copy3();
    const lines: string[] = [];
    await (await openSqliteStore({ ...optsFor(s), log: (m) => lines.push(m) })).close();
    expect(lines).toContain('Rebuilding the search index (10 memories)…');
    lines.length = 0;
    await (await openSqliteStore({ ...optsFor(s), log: (m) => lines.push(m) })).close();
    expect(lines.filter((l) => l.startsWith('Rebuilding'))).toEqual([]);
  });

  it('fts-rebuild.a-migrating-open-waits-for-the-write-lock', async () => {
    const s = copy3();
    // Another process (a drain, say) holds the lock past the caller's short busy timeout.
    const lock = await holdWriteLock(s.dbPath, 1500);
    const store = await openSqliteStore({ ...optsFor(s), busyTimeoutMs: 100 });
    await store.close();
    await lock.done;
    expect(sqliteSchemaVersion(s.dbPath)).toBe(4);
  });

  it('fts-rebuild.icu-rebuild-only-for-a-new-major-with-segmented-text', async () => {
    const icu = process.versions.icu ?? '';
    const major = Number(icu.split('.')[0]);
    // With Thai in the store: an older major rebuilds; the same major does not.
    const thai = copy3();
    await (await openSqliteStore(optsFor(thai))).close();
    setMeta(thai.dbPath, 'lexical_icu', `${major}.0`);
    const sameMajor = mark(thai.dbPath);
    await (await openSqliteStore(optsFor(thai))).close();
    expect(sameMajor(), 'same ICU major: no rebuild').toBe(true);
    setMeta(thai.dbPath, 'lexical_icu', `${major - 1}.9`);
    const olderMajor = mark(thai.dbPath);
    await (await openSqliteStore(optsFor(thai))).close();
    expect(olderMajor(), 'older ICU major with Thai: rebuilt').toBe(false);
    expect(getMeta(thai.dbPath, 'lexical_icu')).toBe(icu);
    // A recorded version that is not a number is unknown: recorded again, never a rebuild.
    setMeta(thai.dbPath, 'lexical_icu', 'unknown-build');
    const nonNumeric = mark(thai.dbPath);
    await (await openSqliteStore(optsFor(thai))).close();
    expect(nonNumeric(), 'non-numeric ICU: no rebuild').toBe(true);
    expect(getMeta(thai.dbPath, 'lexical_icu')).toBe(icu);

    // Without any Thai, Lao, Khmer or Myanmar text, a new ICU changes nothing: no rebuild.
    const dir = fs.mkdtempSync(path.join(root, 'english-'));
    const en = { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
    await (await openSqliteStore(optsFor(en))).close();
    setMeta(en.dbPath, 'lexical_icu', `${major - 1}.9`);
    const english = mark(en.dbPath);
    await (await openSqliteStore(optsFor(en))).close();
    expect(english(), 'no segmented text: no rebuild').toBe(true);
    expect(getMeta(en.dbPath, 'lexical_icu')).toBe(icu);
  });
});

describe('the ICU guard with an unknown runtime ICU', () => {
  it('fts-rebuild.unknown-runtime-icu-never-rebuilds-and-warns-for-segmented-text', async () => {
    const { applySchema } = await import('./schema.js');
    const s = copy3();
    await (await openSqliteStore(optsFor(s))).close();
    setMeta(s.dbPath, 'lexical_icu', '1.0');
    for (const icu of ['', 'not-a-version']) {
      const marked = mark(s.dbPath);
      const db = raw(s.dbPath);
      const lines: string[] = [];
      try {
        applySchema(db, DIM, { icu, log: (m) => lines.push(m) });
      } finally {
        db.close();
      }
      expect(marked(), `runtime ICU ${JSON.stringify(icu)}: no rebuild`).toBe(true);
      expect(lines.join('\n')).toMatch(/reports no usable ICU version/);
      expect(getMeta(s.dbPath, 'lexical_icu')).toBe('1.0');
    }
  });
});
