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
import {
  nodeGrant,
  type Grant,
  type GrantProjects,
  type Memory,
  type Principal,
} from '@oortmem/core';
import { memoryAt, nodesGrant } from '@oortmem/core/store-conformance';
import {
  downgradeSqliteStore,
  listBackups,
  openSqliteStore,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
} from './index.js';

/**
 * Floats rounded to 12 significant digits for golden comparisons: Math.log/exp differ in the last
 * bit between platforms (macOS arm64 vs Linux x64), so exact float equality is not portable.
 * Ids, order, tiers, strings and integers still compare exactly.
 */
function portable<T>(v: T): T {
  if (typeof v === 'number') return (Number.isInteger(v) ? v : Number(v.toPrecision(12))) as T;
  if (Array.isArray(v)) return v.map(portable) as T;
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, portable(x)])) as T;
  }
  return v;
}

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

/**
 * The grant 0.2.1 read with: the principal's Planet, memories its own agent wrote. Since CON-62 the
 * local grants also read the Planet's other authors; this proves the stored data is unchanged.
 */
function preLevel(p: Principal, projectIds: GrantProjects): Grant {
  return nodeGrant({
    principal: p,
    read: [
      {
        node: { level: 'user', orgId: p.orgId, customerId: p.customerId },
        projectIds,
        authorAgentId: p.agentId,
      },
    ],
  });
}

/** Everything the 0.2.1 store read back, read again through the current store. */
async function readBack(s: { dbPath: string; coldDir: string }): Promise<Expected> {
  const store = await openSqliteStore(optsFor(s));
  try {
    const principals: Expected['principals'] = [];
    for (const { principal: p } of expected.principals) {
      const g = preLevel(p, 'all');
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
      const narrow = preLevel(p, ['oort-1a2b3c4d', null]);
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
    expect(portable(got)).toEqual(portable(expected));
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
    const backups = listBackups(s.dbPath, 'pre-v2');
    expect(backups).toHaveLength(1);
    const backup = backups[0]!;
    expect(path.basename(backup)).toMatch(/^oort\.sqlite\.pre-v2\.\d{8}T\d{9}Z$/);
    if (process.platform !== 'win32') expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(v1Content(backup)).toEqual(before);
    // A later open finds version 2: nothing to migrate, no new copy.
    await (await openSqliteStore(optsFor(s))).close();
    expect(listBackups(s.dbPath, 'pre-v2')).toEqual([backup]);
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('migrate.every-migration-takes-a-fresh-copy', async () => {
    const s = copyFixture();
    await (await openSqliteStore(optsFor(s))).close();
    downgradeSqliteStore({ path: s.dbPath });
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    // Version 1 again, and changed since the first copy.
    const db = raw(s.dbPath);
    db.exec("DELETE FROM memories WHERE id = 'p1-47'");
    db.close();
    const now = v1Content(s.dbPath);
    await (await openSqliteStore(optsFor(s))).close();
    const copies = listBackups(s.dbPath, 'pre-v2');
    expect(copies).toHaveLength(2);
    expect(v1Content(copies[1]!)).toEqual(now);
  });

  it('migrate.keeps-the-newest-copies-and-the-original', async () => {
    const s = copyFixture();
    for (let i = 0; i < 5; i++) {
      await (await openSqliteStore(optsFor(s))).close();
      downgradeSqliteStore({ path: s.dbPath });
    }
    const v2 = listBackups(s.dbPath, 'pre-v2');
    const down = listBackups(s.dbPath, 'pre-downgrade');
    expect(v2).toHaveLength(4); // the original and the three newest
    expect(down).toHaveLength(3);
    expect(v1Content(v2[0]!)).toEqual(v1Content(path.join(FIXTURE, 'oort.sqlite')));
  });

  it('migrate.copy-includes-the-wal-and-ignores-stale-temp-files', async () => {
    const s = copyFixture();
    // Another connection's write still in the WAL (no checkpoint while it stays open).
    const other = raw(s.dbPath);
    other.pragma('journal_mode = WAL');
    other.pragma('wal_autocheckpoint = 0');
    other.exec(`INSERT INTO memories (id, org_id, customer_id, agent_id, project_id, scope_extra, type,
      text, stub, entities, salience, pinned, tier, access_log, valid_from, valid_to, expired_at,
      end_reason, last_confirmed_at, supersedes, superseded_by, source, created_at, updated_at)
      SELECT 'in-wal', org_id, customer_id, agent_id, project_id, scope_extra, type, text, stub,
        entities, salience, pinned, tier, access_log, valid_from, valid_to, expired_at, end_reason,
        last_confirmed_at, supersedes, superseded_by, source, created_at, updated_at
      FROM memories WHERE id = 'p1-00'`);
    // A temp file a crashed copy left under this process id: never in the way.
    const stale = `${s.dbPath}.pre-v2.${process.pid}.tmp`;
    fs.writeFileSync(stale, 'stale');
    try {
      await (await openSqliteStore(optsFor(s))).close();
    } finally {
      other.close();
    }
    const [copy] = listBackups(s.dbPath, 'pre-v2');
    const c = new Database(copy!, { readonly: true });
    try {
      expect((c.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(49);
    } finally {
      c.close();
    }
    expect(fs.readFileSync(stale, 'utf8')).toBe('stale');
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([path.basename(stale)]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'migrate.failed-copy-changes-nothing',
    async () => {
      const s = copyFixture();
      const keep = raw(s.dbPath); // keeps the -wal and -shm files, so a read-only directory still opens
      keep.pragma('journal_mode = WAL');
      fs.chmodSync(s.dir, 0o500);
      try {
        await expect(openSqliteStore(optsFor(s))).rejects.toThrow(
          /could not copy .* before migrating it .*nothing was changed/,
        );
      } finally {
        fs.chmodSync(s.dir, 0o700);
        keep.close();
      }
      expect(sqliteSchemaVersion(s.dbPath)).toBe(1);
      expect(listBackups(s.dbPath, 'pre-v2')).toEqual([]);
      expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('migrate.an-open-that-may-not-migrate-changes-nothing', async () => {
    const s = copyFixture();
    const before = fs.readFileSync(s.dbPath);
    const err = await openSqliteStore({ ...optsFor(s), migrate: false }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect(fs.readFileSync(s.dbPath).equals(before)).toBe(true);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(1);
    expect(listBackups(s.dbPath, 'pre-v2')).toEqual([]);
    // Once migrated, it opens with migrate: false.
    await (await openSqliteStore(optsFor(s))).close();
    await (await openSqliteStore({ ...optsFor(s), migrate: false })).close();
  });

  it('migrate.empty-ids-are-refused-with-a-count', async () => {
    const s = copyFixture();
    const db = raw(s.dbPath);
    db.exec("UPDATE memories SET customer_id = '' WHERE id = 'p1-01'");
    db.exec("UPDATE memories SET agent_id = '' WHERE id = 'p1-02'");
    db.close();
    await expect(openSqliteStore(optsFor(s))).rejects.toThrow(
      /2 memories have an empty org, customer or agent id.*nothing was changed/,
    );
    expect(sqliteSchemaVersion(s.dbPath)).toBe(1);
    expect(listBackups(s.dbPath, 'pre-v2')).toEqual([]);
  });

  it('migrate.down-and-up-again', async () => {
    const s = copyFixture();
    const original = v1Content(s.dbPath);
    await (await openSqliteStore(optsFor(s))).close();
    downgradeSqliteStore({ path: s.dbPath });
    expect(v1Content(s.dbPath)).toEqual(original);
    downgradeSqliteStore({ path: s.dbPath }); // already version 1: nothing to do
    expect(portable(await readBack(s))).toEqual(portable(expected));
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
    expect(listBackups(s.dbPath, 'pre-v2')).toEqual([]);
  });
});
