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
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
  WRITER_GUARD,
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

/**
 * Lexical hits without their scores, in rank order. Opening an older store rebuilds its lexical
 * index (schema version 4, CON-110), and the rebuild corrects BM25's statistics: an old index also
 * counted every row ever rewritten. Scores change once, and so can the order, which each fixture
 * pins where it changed (`at4`). Every other field still compares exactly.
 */
function scoreless<T>(v: T): T {
  const isHit = (x: unknown): x is { id: string; tier: string } =>
    x !== null && typeof x === 'object' && Object.keys(x).sort().join() === 'id,score,tier';
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every(isHit)) return v.map((h) => ({ id: h.id, tier: h.tier })) as T;
    return v.map(scoreless) as T;
  }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scoreless(x)])) as T;
  }
  return v;
}

/** The ICU major version the store records (CON-110): two Node versions on one major agree. */
const ICU_MAJOR = (process.versions.icu ?? '').split('.')[0] ?? '';

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
    // The phase1 fixture's lexical order is unchanged by the rebuild; only scores move.
    expect(portable(scoreless(got))).toEqual(portable(scoreless(expected)));
    expect(hashDir(s.coldDir), 'cold blobs are untouched').toBe(blobs);
    const db = raw(s.dbPath);
    try {
      expect(version(db)).toBe(String(SCHEMA_VERSION));
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
    expect(portable(scoreless(await readBack(s)))).toEqual(portable(scoreless(expected)));
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
      expect(version(db)).toBe(String(SCHEMA_VERSION));
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
    db.function(WRITER_GUARD, () => 1); // a version 5 writer: past the guard, at the CHECK
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

  it('migrate.new-store-starts-at-the-current-version', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'fresh-'));
    const s = { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
    await (await openSqliteStore(optsFor(s))).close();
    const db = raw(s.dbPath);
    try {
      expect(version(db)).toBe(String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
    expect(listBackups(s.dbPath, 'pre-v2')).toEqual([]);
  });
});

/**
 * Schema version 2 to 3 (judgment memory, CON-71) on a real version 2 store:
 * `test/fixtures/schema2` was written by the schema version 2 store, and its `expected.json` is
 * what that store read back: every record, the current ids, lexical and dense hits, a cold copy
 * and a cursor, over a Planet and a Star.
 */
describe('schema migration 2 to 3', () => {
  const FIXTURE2 = path.join(path.dirname(FIXTURE), 'schema2');
  const expected2 = JSON.parse(fs.readFileSync(path.join(FIXTURE2, 'expected.json'), 'utf8')) as {
    list: unknown[];
    current: string[];
    lexical: unknown;
    dense: unknown;
    cold: unknown;
    cursor: string | null;
  };
  const g2 = nodeGrant({
    principal: { orgId: 'local', customerId: 'self', agentId: 'cursor' },
    read: [
      { node: { level: 'user', orgId: 'local', customerId: 'self' }, projectIds: 'all' },
      { node: { level: 'agent', orgId: 'local', agentId: 'cursor' }, projectIds: 'all' },
    ],
  });
  const vec = (k: number) =>
    Int8Array.from({ length: DIM }, (_, j) => ((j * 29 + k * 13) % 200) - 100);

  /**
   * What the schema version 2 store reads back after the version 4 rebuild. The lexical query
   * `auth service port staging` ranked the two auth-service memories (`auth`, `service`, `port`)
   * ahead of the cold staging note (entity `staging`) under the old index's statistics, which
   * still counted rewritten rows; with the corrected counts the rarer `staging` weighs more, and
   * the cold note ranks first. A one-time change from correcting the statistics, pinned here.
   */
  const at4 = (e: typeof expected2) => ({
    ...scoreless(e),
    lexical: [
      { id: 'v2-e', tier: 'cold' },
      { id: 'v2-b', tier: 'warm' },
      { id: 'v2-a', tier: 'warm' },
    ],
  });

  function copy2(): { dir: string; dbPath: string; coldDir: string } {
    const dir = fs.mkdtempSync(path.join(root, 'store2-'));
    fs.cpSync(FIXTURE2, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'expected.json'));
    return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
  }

  const columns = (dbPath: string): string[] => {
    const db = raw(dbPath);
    try {
      return (
        db.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[]
      ).map((c) => c.name);
    } finally {
      db.close();
    }
  };

  async function readBack2(s: { dbPath: string; coldDir: string }) {
    const store = await openSqliteStore(optsFor(s));
    try {
      return {
        list: (await store.list(g2, { validOnly: false })).map(render),
        current: (await store.list(g2)).map((m) => m.id),
        lexical: await store.lexical(g2, 'auth service port staging', 10),
        dense: await store.dense(g2, vec(2), 10),
        cold: render(await store.coldGet(g2, 'v2-e')),
        cursor: await store.getCursor(g2, 'claude-code:s1'),
      };
    } finally {
      await store.close();
    }
  }

  const judgmentMemory = (id: string): Memory => ({
    id,
    scope: { orgId: 'local', customerId: 'self', agentId: 'cursor' },
    type: 'judgment',
    text: 'Judgment by ada (content): rejected "Post claims a cure". Reason: No cited source.',
    stub: 'rejected: Post claims a cure',
    entities: ['content', 'no-source'],
    salience: 0.8,
    pinned: true,
    tier: 'hot',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: '2026-10-20T00:00:00.000Z',
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'cli', decisions: [] },
    judgment: {
      subject: { summary: 'Post claims a cure', ref: 'https://example.test/p/1' },
      verdict: 'rejected',
      verdicts: ['approved', 'rejected'],
      reason: 'No cited source.',
      criteria: ['no-source'],
      domain: 'content',
      by: 'ada',
      decidedAt: '2026-10-20T00:00:00.000Z',
      via: 'cli',
    },
    embedding: vec(7),
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  });

  it('migrate.v2-store-reads-back-identically-at-v3', async () => {
    const s = copy2();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(2);
    expect(columns(s.dbPath)).not.toContain('judgment');
    const blobs = hashDir(s.coldDir);
    expect(portable(scoreless(await readBack2(s)))).toEqual(portable(at4(expected2)));
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(columns(s.dbPath)).toContain('judgment');
    expect(hashDir(s.coldDir), 'cold blobs are untouched').toBe(blobs);
  });

  it('migrate.v2-copies-the-store-first', async () => {
    const s = copy2();
    await (await openSqliteStore(optsFor(s))).close();
    const backups = listBackups(s.dbPath, 'pre-v3');
    expect(backups).toHaveLength(1);
    const backup = backups[0]!;
    expect(path.basename(backup)).toMatch(/^oort\.sqlite\.pre-v3\.\d{8}T\d{9}Z$/);
    if (process.platform !== 'win32') expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(sqliteSchemaVersion(backup)).toBe(2);
    expect(listBackups(s.dbPath, 'pre-v2')).toEqual([]);
    // A later open finds version 3: nothing to migrate, no new copy.
    await (await openSqliteStore(optsFor(s))).close();
    expect(listBackups(s.dbPath, 'pre-v3')).toEqual([backup]);
  });

  it('migrate.v2-open-that-may-not-migrate-changes-nothing', async () => {
    const s = copy2();
    const before = fs.readFileSync(s.dbPath);
    const err = await openSqliteStore({ ...optsFor(s), migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(2);
    expect(fs.readFileSync(s.dbPath).equals(before)).toBe(true);
    expect(listBackups(s.dbPath, 'pre-v3')).toEqual([]);
  });

  it('migrate.v3-keeps-a-judgment-and-refuses-to-go-down-with-it', async () => {
    const s = copy2();
    const store = await openSqliteStore(optsFor(s));
    const j = judgmentMemory('j-1');
    await store.upsert(g2, j);
    expect(render(await store.get(g2, 'j-1'))).toEqual(render(j));
    await store.close();
    expect(() => downgradeSqliteStore({ path: s.dbPath, to: 2 })).toThrow(/judgment/);
    expect(() => downgradeSqliteStore({ path: s.dbPath })).toThrow(/not plain Planet memories/);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(listBackups(s.dbPath, 'pre-downgrade')).toEqual([]);
  });

  it('migrate.v3-down-to-2-and-up-again', async () => {
    const s = copy2();
    await (await openSqliteStore(optsFor(s))).close();
    downgradeSqliteStore({ path: s.dbPath, to: 2 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(2);
    expect(columns(s.dbPath)).not.toContain('judgment');
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    downgradeSqliteStore({ path: s.dbPath, to: 2 }); // already version 2: nothing to do
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    expect(portable(scoreless(await readBack2(s)))).toEqual(portable(at4(expected2)));
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
  });
});

/**
 * Schema version 3 to 4 (tokeniser v2, CON-110) on a real version 3 store:
 * `test/fixtures/schema3` was written by the schema version 3 store (Oort at 70e1917), with
 * memories in English, Chinese, Japanese, Korean, Thai, Hindi and Spanish, a cold Japanese memory
 * and a judgment. Its `expected.json` is what that store read back: every record, and the lexical
 * hits for English and non-English queries under tokeniser v1.
 */
describe('schema migration 3 to 4', () => {
  const FIXTURE3 = path.join(path.dirname(FIXTURE), 'schema3');
  const expected3 = JSON.parse(fs.readFileSync(path.join(FIXTURE3, 'expected.json'), 'utf8')) as {
    list: unknown[];
    lexical: Record<string, { id: string; score: number; tier: string }[]>;
  };
  const g3 = nodeGrant({
    principal: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    read: [{ node: { level: 'user', orgId: 'local', customerId: 'self' }, projectIds: 'all' }],
  });
  const ENGLISH = ['auth service port staging', 'billing webhooks retries'];

  function copy3(): { dir: string; dbPath: string; coldDir: string } {
    const dir = fs.mkdtempSync(path.join(root, 'store3-'));
    fs.cpSync(FIXTURE3, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'expected.json'));
    return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
  }

  /** The FTS declaration, the lexical meta keys and every vector, read without migrating. */
  function inspect(dbPath: string) {
    const db = raw(dbPath);
    try {
      // Versions 1 to 3 name the index memories_fts; version 4 names it memories_fts2.
      const sql = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name IN ('memories_fts', 'memories_fts2') ORDER BY name DESC",
          )
          .get() as { sql: string }
      ).sql;
      const meta = Object.fromEntries(
        (
          db.prepare("SELECT key, value FROM meta WHERE key LIKE 'lexical%'").all() as {
            key: string;
            value: string;
          }[]
        ).map((r) => [r.key, r.value]),
      );
      const vec = db.prepare('SELECT id, hex(embedding) AS e FROM memories_vec ORDER BY id').all();
      return { sql, meta, vec };
    } finally {
      db.close();
    }
  }

  async function lexical(s: { dbPath: string; coldDir: string }, queries: string[]) {
    const store = await openSqliteStore(optsFor(s));
    try {
      const out: Record<string, { id: string; score: number; tier: string }[]> = {};
      for (const q of queries) out[q] = await store.lexical(g3, q, 10);
      return { out, list: (await store.list(g3, { validOnly: false })).map(render) };
    } finally {
      await store.close();
    }
  }

  it('migrate.v3-store-reads-back-identically-at-v4', async () => {
    const s = copy3();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(3);
    const before = inspect(s.dbPath);
    expect(before.sql).not.toContain('categories');
    expect(before.meta).toEqual({});
    const blobs = hashDir(s.coldDir);
    const { out, list } = await lexical(s, ENGLISH);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    // Every record, the judgment and the cold memory included, reads back as version 3 wrote it.
    expect(portable(list)).toEqual(portable(expected3.list));
    // English queries find the same memories in the same order. Their scores move a little here
    // because this store's other-language rows now have more tokens (bigrams), which changes
    // BM25's average lengths; in an English-only store they stay exact (the recall golden).
    const order = (hits: { id: string; tier: string }[] | undefined) =>
      hits?.map((h) => [h.id, h.tier]);
    for (const q of ENGLISH) expect(order(out[q])).toEqual(order(expected3.lexical[q]));
    const after = inspect(s.dbPath);
    expect(after.sql).toContain(`categories 'L* N* Co M*'`);
    expect(after.meta).toEqual({ lexical_version: '2', lexical_icu: ICU_MAJOR });
    expect(after.vec, 'vectors are untouched').toEqual(before.vec);
    expect(hashDir(s.coldDir), 'cold blobs are untouched').toBe(blobs);
  });

  it('migrate.v4-finds-cjk-thai-indic-and-unaccented-words', async () => {
    const s = copy3();
    const ids = async (q: string) => (await lexical(s, [q])).out[q]?.map((h) => h.id);
    // Version 3 found none of these (`expected.json`); version 4 finds each.
    for (const q of [
      '认证 端口',
      '認証サービスのポート',
      '서비스',
      'autenticacion',
      '請求サービス',
    ]) {
      expect(expected3.lexical[q], q).toEqual([]);
    }
    expect(await ids('认证 端口')).toEqual(['zh-1']);
    expect((await ids('認証サービスのポート'))?.[0]).toBe('ja-1');
    expect(await ids('서비스')).toEqual(['ko-1']);
    expect(await ids('พอร์ต')).toEqual(['th-1']);
    expect(await ids('सेवा')).toEqual(['hi-1']);
    expect(await ids('autenticacion')).toEqual(['es-1']);
    expect(await ids('autenticación')).toEqual(['es-1']);
    // The cold memory matches through its stub only, as before; ja-1 shares サー ービ ビス.
    expect(await ids('請求サービス')).toEqual(['ja-cold', 'ja-1']);
    expect(await ids('毎週')).toEqual([]); // only in the cold text
    // A port next to CJK text is its own token now.
    expect(new Set(await ids('8080'))).toEqual(
      new Set(['en-1', 'zh-1', 'ja-1', 'ko-1', 'th-1', 'hi-1']),
    );
  });

  it('migrate.v3-copies-the-store-first-and-migrates-once', async () => {
    const s = copy3();
    await (await openSqliteStore(optsFor(s))).close();
    const backups = listBackups(s.dbPath, 'pre-v4');
    expect(backups).toHaveLength(1);
    const backup = backups[0]!;
    expect(path.basename(backup)).toMatch(/^oort\.sqlite\.pre-v4\.\d{8}T\d{9}Z$/);
    if (process.platform !== 'win32') expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(sqliteSchemaVersion(backup)).toBe(3);
    expect(listBackups(s.dbPath, 'pre-v3')).toEqual([]);
    // A later open finds version 4: nothing to migrate, no new copy, the same index.
    const first = await lexical(s, ENGLISH);
    await (await openSqliteStore(optsFor(s))).close();
    expect(listBackups(s.dbPath, 'pre-v4')).toEqual([backup]);
    expect(portable((await lexical(s, ENGLISH)).out)).toEqual(portable(first.out));
  });

  it('migrate.v3-open-that-may-not-migrate-changes-nothing', async () => {
    const s = copy3();
    const before = fs.readFileSync(s.dbPath);
    const err = await openSqliteStore({ ...optsFor(s), migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(3);
    expect(fs.readFileSync(s.dbPath).equals(before)).toBe(true);
    expect(listBackups(s.dbPath, 'pre-v4')).toEqual([]);
  });

  it('migrate.v4-rebuilds-when-the-index-is-stale', async () => {
    const s = copy3();
    const first = await lexical(s, [...ENGLISH, '认证 端口', 'พอร์ต']);
    const setMeta = (key: string, value: string) => {
      const db = raw(s.dbPath);
      try {
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
      } finally {
        db.close();
      }
    };
    // Built with an older ICU: rebuilt, recording this one, with the same hits and scores.
    setMeta('lexical_icu', '1.0');
    const again = await lexical(s, [...ENGLISH, '认证 端口', 'พอร์ต']);
    expect(portable(again.out)).toEqual(portable(first.out));
    expect(inspect(s.dbPath).meta['lexical_icu']).toBe(ICU_MAJOR);
    // Built with a newer ICU (another Node on this machine): left alone, no rebuild back and forth.
    setMeta('lexical_icu', '999.0');
    await (await openSqliteStore(optsFor(s))).close();
    expect(inspect(s.dbPath).meta['lexical_icu']).toBe('999.0');
    // A hook's open (migrate: false) never rebuilds.
    setMeta('lexical_version', '1');
    await (await openSqliteStore({ ...optsFor(s), migrate: false })).close();
    expect(inspect(s.dbPath).meta['lexical_version']).toBe('1');
    await (await openSqliteStore(optsFor(s))).close();
    expect(inspect(s.dbPath).meta['lexical_version']).toBe('2');
  });

  it('migrate.v4-down-to-3-and-up-again', async () => {
    const s = copy3();
    const at4 = await lexical(s, [...ENGLISH, '认证 端口']);
    downgradeSqliteStore({ path: s.dbPath, to: 3 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(3);
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    const down = inspect(s.dbPath);
    expect(down.sql).not.toContain('categories');
    expect(down.meta).toEqual({});
    downgradeSqliteStore({ path: s.dbPath, to: 3 }); // already version 3: nothing to do
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    // Version 3's index is tokeniser v1's again: what Oort before 0.6.x reads. Opening migrates
    // it straight back up, with the same hits and scores.
    const db = raw(s.dbPath);
    try {
      const hit = db
        .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH \'"认证"\'')
        .all();
      expect(hit).toEqual([]);
    } finally {
      db.close();
    }
    expect(portable((await lexical(s, [...ENGLISH, '认证 端口'])).out)).toEqual(portable(at4.out));
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
  });

  it('migrate.new-store-starts-at-v4-with-tokeniser-v2', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'store4-'));
    const s = { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
    await (await openSqliteStore(optsFor(s))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    const fresh = inspect(s.dbPath);
    expect(fresh.sql).toContain(`categories 'L* N* Co M*'`);
    expect(fresh.meta).toEqual({ lexical_version: '2', lexical_icu: ICU_MAJOR });
  });
});
