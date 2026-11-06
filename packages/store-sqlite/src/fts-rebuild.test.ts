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
import { localGrant, tokenizeLexicalV1 } from '@oortmem/core';
import {
  FTS_TOKENIZE,
  openSqliteStore,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
} from './index.js';

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

describe('older Oort processes and the version 4 index (CON-110 review)', () => {
  it('fts-rebuild.an-old-process-cannot-write-the-old-index-name', async () => {
    const s = copy3();
    // A 0.5.x or 0.6.0 MCP server or daemon, already running against the version 3 store, with
    // its FTS statement prepared.
    const old = raw(s.dbPath);
    const write = old.prepare(
      'INSERT INTO memories_fts (rowid, text, stub, entities) VALUES (?, ?, ?, ?)',
    );
    try {
      await (await openSqliteStore(optsFor(s))).close();
      // After the migration its writes fail loudly instead of indexing tokeniser v1's tokens
      // into the version 2 index, where no query would find them.
      expect(() => write.run(9999, '认证服务使用端口8080', '', '')).toThrow(
        /no such table: memories_fts/,
      );
    } finally {
      old.close();
    }
    const db = raw(s.dbPath);
    try {
      expect(ftsName(db)).toBe('memories_fts2');
    } finally {
      db.close();
    }
  });

  it('fts-rebuild.down-to-3-renames-the-index-back', async () => {
    const { downgradeSqliteStore } = await import('./index.js');
    const s = copy3();
    await (await openSqliteStore(optsFor(s))).close();
    downgradeSqliteStore({ path: s.dbPath, to: 3 });
    const db = raw(s.dbPath);
    try {
      expect(ftsName(db)).toBe('memories_fts');
      const names = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE name LIKE 'memories_fts%'",
        )
        .all()
        .map((r) => r.name);
      expect(names.some((n) => n.startsWith('memories_fts2'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

it('fts-rebuild.a-version-4-index-under-the-old-name-is-rebuilt', async () => {
  const s = copy3();
  await (await openSqliteStore(optsFor(s))).close();
  const db = raw(s.dbPath);
  try {
    db.exec('ALTER TABLE memories_fts2 RENAME TO memories_fts');
  } finally {
    db.close();
  }
  const lines: string[] = [];
  const store = await openSqliteStore({ ...optsFor(s), log: (m) => lines.push(m) });
  try {
    expect(lines).toContain('Rebuilding the search index (10 memories)…');
    expect(
      (
        await store.lexical(
          localGrant({
            orgId: 'local',
            customerId: 'self',
            agentId: 'claude-code',
            projectIds: [null],
          }),
          '认证 端口',
          10,
        )
      ).map((h) => h.id),
    ).toEqual(['zh-1']);
  } finally {
    await store.close();
  }
  const d = raw(s.dbPath);
  try {
    expect(ftsName(d)).toBe('memories_fts2');
  } finally {
    d.close();
  }
});

it('fts-rebuild.sweeps-copies-a-killed-backup-left-behind', async () => {
  const s = copy3();
  const dir = path.dirname(s.dbPath);
  // What a VACUUM INTO killed mid-copy leaves: the temporary copy and its rollback journal.
  const old = [
    `.oort.sqlite.pre-v4.0123456789abcdef.tmp`,
    `.oort.sqlite.pre-v4.0123456789abcdef.tmp-journal`,
    `.oort.sqlite.pre-downgrade.fedcba9876543210.tmp`,
  ].map((n) => path.join(dir, n));
  const recent = path.join(dir, '.oort.sqlite.pre-v4.00112233445566ff.tmp');
  const unrelated = path.join(dir, '.oort.sqlite.notes.tmp');
  const hourAgo = (Date.now() - 2 * 3600_000) / 1000;
  for (const f of [...old, recent, unrelated]) fs.writeFileSync(f, 'partial copy');
  for (const f of [...old, unrelated]) fs.utimesSync(f, hourAgo, hourAgo);
  await (await openSqliteStore(optsFor(s))).close();
  for (const f of old) expect(fs.existsSync(f), path.basename(f)).toBe(false);
  // A copy still being written by another process (under an hour old) is left alone, and so is
  // any file that is not one of the store's temporary copies.
  expect(fs.existsSync(recent)).toBe(true);
  expect(fs.existsSync(unrelated)).toBe(true);
});

describe('a hook opens a store whose index needs repair first (CON-110 re-review)', () => {
  const g = localGrant({
    orgId: 'local',
    customerId: 'self',
    agentId: 'claude-code',
    projectIds: [null],
  });

  /** A version 4 store as the pre-rename build left it: the v2 index still named memories_fts. */
  async function preRename(): Promise<{ dbPath: string; coldDir: string }> {
    const s = copy3();
    await (await openSqliteStore(optsFor(s))).close();
    const db = raw(s.dbPath);
    try {
      db.exec('ALTER TABLE memories_fts2 RENAME TO memories_fts');
    } finally {
      db.close();
    }
    return s;
  }

  const tables = (dbPath: string): string[] => {
    const db = raw(dbPath);
    try {
      return db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE name IN ('memories_fts', 'memories_fts2') ORDER BY name",
        )
        .all()
        .map((r) => r.name);
    } finally {
      db.close();
    }
  };

  it('fts-rebuild.hook-first-then-cli-keeps-search', async () => {
    const s = await preRename();
    // The hook (migrate: false) refuses, changing nothing: it must not create an empty index.
    const err = await openSqliteStore({ ...optsFor(s), migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).message).toMatch(/search index/);
    expect(tables(s.dbPath)).toEqual(['memories_fts']);
    // The next command rebuilds the index, and search works.
    const store = await openSqliteStore(optsFor(s));
    try {
      expect((await store.lexical(g, '认证 端口', 10)).map((h) => h.id)).toEqual(['zh-1']);
      expect((await store.lexical(g, 'auth service port staging', 10)).length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
    expect(tables(s.dbPath)).toEqual(['memories_fts2']);
  });

  it('fts-rebuild.an-empty-index-beside-memories-is-rebuilt', async () => {
    // What the earlier bug left: both tables, the new one empty. A hook refuses; a command repairs.
    const s = await preRename();
    const db = raw(s.dbPath);
    try {
      db.exec(`CREATE VIRTUAL TABLE memories_fts2 USING fts5(text, stub, entities,
        content = '', contentless_delete = 1, tokenize = "${FTS_TOKENIZE}")`);
    } finally {
      db.close();
    }
    await expect(openSqliteStore({ ...optsFor(s), migrate: false })).rejects.toBeInstanceOf(
      StoreMigrationRequiredError,
    );
    const store = await openSqliteStore(optsFor(s));
    try {
      expect((await store.lexical(g, '认证 端口', 10)).map((h) => h.id)).toEqual(['zh-1']);
    } finally {
      await store.close();
    }
    expect(tables(s.dbPath)).toEqual(['memories_fts2']);
    // And with only the empty new table (old one dropped): still rebuilt.
    const t = await preRename();
    const d = raw(t.dbPath);
    try {
      d.exec('DROP TABLE memories_fts');
      d.exec(`CREATE VIRTUAL TABLE memories_fts2 USING fts5(text, stub, entities,
        content = '', contentless_delete = 1, tokenize = "${FTS_TOKENIZE}")`);
    } finally {
      d.close();
    }
    const again = await openSqliteStore(optsFor(t));
    try {
      expect((await again.lexical(g, '认证 端口', 10)).map((h) => h.id)).toEqual(['zh-1']);
    } finally {
      await again.close();
    }
  });
});
