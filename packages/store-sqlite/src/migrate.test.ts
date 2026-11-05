/**
 * Schema version 1 to 2 (levels, CON-61) on a real Phase 1 store:
 * `test/fixtures/phase1` was written by the 0.2.1 store (schema version 1),
 * and `expected.json` is what the 0.2.1 store read back from it: every record,
 * cold copy, lexical and dense result and cursor, for three principals.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { localGrant, principalGrant, type Memory, type Principal } from '@oortmem/core';
import { memoryAt, nodesGrant } from '@oortmem/core/store-conformance';
import { backupPathFor, downgradeSqliteStore, openSqliteStore } from './index.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/phase1');
const DIM = 8;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-migrate-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

interface Expected {
  coldIds: string[];
  queries: string[];
  principals: {
    principal: Principal;
    list: unknown[];
    current: string[];
    cold: Record<string, unknown>;
    lexical: Record<string, unknown>;
    dense: { v: number[]; hits: unknown }[];
    narrowLexical: unknown;
    narrowDense: unknown;
    cursor: string | null;
  }[];
}

const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8'),
) as Expected;

/** A private copy of the Phase 1 store (database and cold blobs). */
function copyFixture(): { dir: string; dbPath: string; coldDir: string } {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
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

const render = (m: Memory | null) =>
  m === null ? null : { ...m, embedding: m.embedding === undefined ? null : [...m.embedding] };

/** Everything the 0.2.1 store read back, read again through the current store. */
async function readBack(s: { dbPath: string; coldDir: string }): Promise<Expected> {
  const store = await openSqliteStore(optsFor(s));
  try {
    const principals: Expected['principals'] = [];
    for (const { principal: p } of expected.principals) {
      const g = principalGrant(p);
      const cold: Record<string, unknown> = {};
      for (const id of expected.coldIds) {
        const c = await store.coldGet(g, id);
        if (c !== null) cold[id] = render(c);
      }
      const lexical: Record<string, unknown> = {};
      for (const q of expected.queries) lexical[q] = await store.lexical(g, q, 50);
      const dense: Expected['principals'][number]['dense'] = [];
      for (let k = 0; k < 4; k++) {
        const v = Int8Array.from({ length: DIM }, (_, j) => ((j * 37 + k * 11) % 200) - 100);
        dense.push({ v: [...v], hits: await store.dense(g, v, 10) });
      }
      const narrow = localGrant({ ...p, projectIds: ['oort-1a2b3c4d', null] });
      principals.push({
        principal: p,
        list: (await store.list(g, { validOnly: false })).map(render),
        current: (await store.list(g)).map((m) => m.id),
        cold,
        lexical,
        dense,
        narrowLexical: await store.lexical(narrow, 'orbit comet nebula', 50),
        narrowDense: await store.dense(narrow, Int8Array.from(dense[0]!.v), 10),
        cursor: await store.getCursor(
          g,
          p.agentId === 'default' ? 'claude-code:s9' : 'claude-code:s1',
        ),
      });
    }
    return { coldIds: expected.coldIds, queries: expected.queries, principals };
  } finally {
    await store.close();
  }
}

function raw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

const version = (db: Database.Database) =>
  (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
    .value;

function hashDir(dir: string): string {
  const h = createHash('sha256');
  for (const f of fs.readdirSync(dir).sort())
    h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

/** The logical content of a version 1 database: rows, vectors, cursors, cold index, FTS hits. */
function v1Content(dbPath: string): unknown {
  const db = raw(dbPath);
  try {
    expect(version(db)).toBe('1');
    return {
      columns: db
        .prepare('SELECT name, type, "notnull" FROM pragma_table_info(\'memories\')')
        .all(),
      memories: db.prepare('SELECT * FROM memories ORDER BY rid').all(),
      vec: db
        .prepare(
          'SELECT id, hex(embedding) AS e, scope_key, project_key, tier FROM memories_vec ORDER BY id',
        )
        .all(),
      cursors: db.prepare('SELECT * FROM cursors ORDER BY key').all(),
      cold: db.prepare('SELECT * FROM cold_index ORDER BY id').all(),
      fts: db
        .prepare(
          "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'orbit OR token7' ORDER BY rowid",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

describe('schema migration 1 to 2', () => {
  it('migrate.phase1-store-reads-back-identically', async () => {
    const s = copyFixture();
    const blobs = hashDir(s.coldDir);
    const got = await readBack(s);
    expect(got).toEqual(expected);
    expect(hashDir(s.coldDir), 'cold blobs are untouched').toBe(blobs);
    const db = raw(s.dbPath);
    try {
      expect(version(db)).toBe('2');
      const rows = db
        .prepare('SELECT level, agent_id, hive_id, run_id, author_agent_id FROM memories')
        .all() as { level: string; agent_id: null; author_agent_id: string }[];
      expect(rows).toHaveLength(48);
      expect(new Set(rows.map((r) => r.level))).toEqual(new Set(['user']));
      expect(rows.every((r) => r.agent_id === null)).toBe(true);
      expect(new Set(rows.map((r) => r.author_agent_id))).toEqual(
        new Set(['claude-code', 'other-agent', 'default']),
      );
    } finally {
      db.close();
    }
  });

  it('migrate.copies-the-store-first', async () => {
    const s = copyFixture();
    const before = v1Content(s.dbPath);
    await (await openSqliteStore(optsFor(s))).close();
    const backup = backupPathFor(s.dbPath);
    expect(backup).toBe(`${s.dbPath}.pre-v2`);
    if (process.platform !== 'win32') expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(v1Content(backup)).toEqual(before);
    // A later open finds version 2 and leaves the copy alone.
    const mtime = fs.statSync(backup).mtimeMs;
    await (await openSqliteStore(optsFor(s))).close();
    expect(fs.statSync(backup).mtimeMs).toBe(mtime);
  });

  it('migrate.down-and-up-again', async () => {
    const s = copyFixture();
    const original = v1Content(s.dbPath);
    await (await openSqliteStore(optsFor(s))).close();
    downgradeSqliteStore({ path: s.dbPath });
    expect(v1Content(s.dbPath)).toEqual(original);
    downgradeSqliteStore({ path: s.dbPath }); // already version 1: nothing to do
    expect(await readBack(s)).toEqual(expected);
  });

  it('migrate.down-refuses-memories-version-1-cannot-hold', async () => {
    const s = copyFixture();
    const hive = { level: 'hive', orgId: 'org:acme', hiveId: 'checkout' } as const;
    const store = await openSqliteStore(optsFor(s));
    await store.upsert(nodesGrant(hive), memoryAt('hive-1', hive, { agentId: 'claude-code' }));
    await store.close();
    expect(() => downgradeSqliteStore({ path: s.dbPath })).toThrow(/not plain Planet memories/);
    const db = raw(s.dbPath);
    try {
      expect(version(db)).toBe('2');
    } finally {
      db.close();
    }
    // bm25 scores count the new row's words; everything else reads back exactly.
    const pick = (x: Expected) =>
      x.principals.map(({ list, current, cold, dense, cursor }) => ({
        list,
        current,
        cold,
        dense,
        cursor,
      }));
    expect(pick(await readBack(s))).toEqual(pick(expected));
  });

  it('migrate.check-constraint-enforces-levels', async () => {
    const s = copyFixture();
    await (await openSqliteStore(optsFor(s))).close();
    const db = raw(s.dbPath);
    try {
      const body = `'semantic', 't', 's', '[]', 0.5, 0, 'warm', '{}', '2026-01-01', NULL, NULL, NULL,
        NULL, NULL, NULL, '{}', '2026-01-01', '2026-01-01'`;
      const insert = (id: string, address: string) =>
        db.exec(`INSERT INTO memories (id, level, org_id, customer_id, agent_id, hive_id, run_id,
          project_id, scope_extra, author_agent_id, author_account_ref, provenance, type, text,
          stub, entities, salience, pinned, tier, access_log, valid_from, valid_to, expired_at,
          end_reason, last_confirmed_at, supersedes, superseded_by, source, created_at, updated_at)
          VALUES ('${id}', ${address}, NULL, NULL, 'a', NULL, NULL, ${body})`);
      // level, org, customer, agent, hive, run
      const illegal = [
        `'user', 'o', NULL, NULL, NULL, NULL`,
        `'user', 'o', 'c', 'a', NULL, NULL`,
        `'hive', 'o', 'c', NULL, 'h', NULL`,
        `'hive', 'o', NULL, NULL, NULL, NULL`,
        `'agent', 'o', 'c', 'a', NULL, NULL`,
        `'agent-user', 'o', NULL, 'a', NULL, NULL`,
        `'run', 'o', NULL, 'a', NULL, NULL`,
        `'team', 'o', 'c', NULL, NULL, NULL`,
        `'user', '', 'c', NULL, NULL, NULL`,
      ];
      for (const [i, a] of illegal.entries()) {
        expect(() => insert(`bad-${i}`, a), a).toThrow(/CHECK constraint failed/);
      }
      const legal = [
        `'user', 'o', 'c', NULL, NULL, NULL`,
        `'agent', 'o', NULL, 'a', NULL, NULL`,
        `'agent-user', 'o', 'c', 'a', NULL, NULL`,
        `'run', 'o', NULL, 'a', NULL, 'r'`,
        `'run', 'o', 'c', 'a', NULL, 'r'`,
        `'hive', 'o', NULL, NULL, 'root', NULL`,
      ];
      for (const [i, a] of legal.entries()) expect(() => insert(`ok-${i}`, a), a).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('migrate.new-store-starts-at-version-2', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'fresh-'));
    const s = { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
    await (await openSqliteStore(optsFor(s))).close();
    const db = raw(s.dbPath);
    try {
      expect(version(db)).toBe('2');
    } finally {
      db.close();
    }
    expect(fs.existsSync(backupPathFor(s.dbPath))).toBe(false);
  });
});
