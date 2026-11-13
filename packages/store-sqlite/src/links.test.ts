/**
 * Memory relationships in the SQLite store (CON-148): `linksConformance` over the store's own
 * rows, and schema version 8 (the link tables, the entity index and episode positions,
 * backfilled from a version 7 store in one transaction).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { forgetMemory, type LinksProbe, type MemoryStore } from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  linksConformance,
  memoryAt,
  nodesGrant,
  TG,
} from '@oortmem/core/store-conformance';
import {
  downgradeSqliteStore,
  listBackups,
  openSqliteStore,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
  WRITER_GUARD,
} from './index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-links-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

interface Paths {
  dir: string;
  dbPath: string;
  coldDir: string;
}
function fresh(): Paths {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}
const optsFor = (s: Paths, extra: Record<string, unknown> = {}) => ({
  path: s.dbPath,
  coldDir: s.coldDir,
  dimension: CONFORMANCE_DIMENSION,
  log: () => {},
  ...extra,
});

/** A raw connection, as an older Oort or a tool would open the file: no writer guard. */
function raw(dbPath: string, readonly = false): Database.Database {
  const db = new Database(dbPath, { readonly });
  sqliteVec.load(db);
  return db;
}

/** Reads a store's link, entity and episode rows from its file. */
function probeFile(dbPath: string): LinksProbe {
  const read = <T>(sql: string): T[] => {
    const db = raw(dbPath, true);
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  return {
    async entities() {
      return read<{ id: string; entity: string }>(
        `SELECT m.id AS id, e.entity_key AS entity FROM memory_entities e
         JOIN memories m ON m.rid = e.memory_rid ORDER BY m.rid, e.entity_key`,
      );
    },
    async links() {
      return read<{ kind: string; a: string; b: string; assertedBy: 'user' | 'agent' | null }>(
        `SELECT l.kind AS kind, a.id AS a, b.id AS b, l.asserted_by AS assertedBy
         FROM memory_links l JOIN memories a ON a.rid = l.a_rid JOIN memories b ON b.rid = l.b_rid
         ORDER BY l.created_at, l.kind, l.a_rid, l.b_rid`,
      );
    },
    async episodes() {
      return read<{ id: string; session: string; seq: number }>(
        `SELECT id, session_id AS session, episode_seq AS seq FROM memories
         WHERE session_id IS NOT NULL ORDER BY rid`,
      );
    },
    async orphans() {
      return (
        read<{ n: number }>(
          `SELECT (SELECT count(*) FROM memory_entities WHERE memory_rid NOT IN (SELECT rid FROM memories))
                + (SELECT count(*) FROM memory_links
                   WHERE a_rid NOT IN (SELECT rid FROM memories) OR b_rid NOT IN (SELECT rid FROM memories))
             AS n`,
        )[0]?.n ?? 0
      );
    },
  };
}

const paths = new WeakMap<MemoryStore, string>();
linksConformance(
  'sqlite',
  async () => {
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    paths.set(store, s.dbPath);
    return store;
  },
  (store) => probeFile(paths.get(store)!),
);

const planet = { level: 'user', orgId: 'local', customerId: 'self' } as const;
const me = { agentId: 'claude-code' };
const src = (sessionId?: string, turnRef?: string) => ({
  harness: 'test',
  ...(sessionId !== undefined && { sessionId }),
  ...(turnRef !== undefined && { turnRef }),
  decisions: [],
});

/** A version 8 store with memories that fill every index: entities, sessions, an expired one. */
async function seeded(): Promise<Paths> {
  const s = fresh();
  const store = await openSqliteStore(optsFor(s));
  const t = (n: number) => `2026-11-0${n}T00:00:00.000Z`;
  try {
    await store.upsertMany(TG, [
      memoryAt('m1', planet, me, {
        entities: ['Payments DB', 'checkout'],
        source: src('s1', 't1'),
        createdAt: t(1),
      }),
      memoryAt('m2', planet, me, {
        entities: ['payments db'],
        source: src('s1', 't1'),
        createdAt: t(2),
      }),
      memoryAt('m3', planet, me, {
        entities: ['ＡＰＩ'],
        source: src('s1', 't2'),
        createdAt: t(3),
      }),
      memoryAt('m4', planet, me, { entities: ['x', 'port'], source: src('s2'), createdAt: t(4) }),
      memoryAt('m5', planet, me, {
        entities: ['port'],
        expiredAt: t(5),
        endReason: 'expired',
        createdAt: t(5),
      }),
    ]);
  } finally {
    await store.close();
  }
  return s;
}

async function snapshot(s: Paths) {
  const p = probeFile(s.dbPath);
  return { entities: await p.entities(), episodes: await p.episodes(), links: await p.links() };
}

const tableNames = (dbPath: string): string[] => {
  const db = raw(dbPath, true);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('nodes', 'memory_entities', 'memory_links')",
        )
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
  } finally {
    db.close();
  }
};
const episodeColumns = (dbPath: string): string[] => {
  const db = raw(dbPath, true);
  try {
    return (
      db.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[]
    )
      .map((c) => c.name)
      .filter((n) => n === 'session_id' || n === 'episode_seq');
  } finally {
    db.close();
  }
};
const guardFunctions = (dbPath: string): string[] => {
  const db = raw(dbPath, true);
  try {
    return (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memories_writer_guard_%' ORDER BY name",
        )
        .all() as { sql: string }[]
    ).map((t) => /SELECT (\w+)\(\)/.exec(t.sql)?.[1] ?? '');
  } finally {
    db.close();
  }
};

describe('schema version 8: links', () => {
  it('links.new-store-starts-at-v8-with-the-link-tables', async () => {
    const s = fresh();
    await (await openSqliteStore(optsFor(s))).close();
    expect(SCHEMA_VERSION).toBe(8);
    expect(WRITER_GUARD).toBe('oort_writer_v8');
    expect(sqliteSchemaVersion(s.dbPath)).toBe(8);
    expect(tableNames(s.dbPath)).toEqual(['memory_entities', 'memory_links', 'nodes']);
    expect(episodeColumns(s.dbPath)).toEqual(['session_id', 'episode_seq']);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v8'));
  });

  it('links.upsert-keeps-the-row-id', async () => {
    // An `INSERT OR REPLACE` would delete the row and cascade every link away.
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    try {
      await store.upsert(TG, memoryAt('a', planet, me));
      await store.upsert(TG, memoryAt('b', planet, me));
      await store.link!(TG, 'a', 'b', { assertedBy: 'user' });
      const rid = () => {
        const db = raw(s.dbPath, true);
        try {
          return (db.prepare("SELECT rid FROM memories WHERE id = 'a'").get() as { rid: number })
            .rid;
        } finally {
          db.close();
        }
      };
      const before = rid();
      await store.upsert(TG, memoryAt('a', planet, me, { text: 'rewritten' }));
      expect(rid()).toBe(before);
      expect((await store.linksOf!(TG, 'a'))?.links.map((l) => l.id)).toEqual(['b']);
    } finally {
      await store.close();
    }
  });

  it('links.v7-to-v8-backfills-every-index-in-one-open-without-a-copy', async () => {
    const s = await seeded();
    const want = await snapshot(s);
    // What the seeded store holds, written at version 8.
    expect(want.entities).toEqual([
      { id: 'm1', entity: 'checkout' },
      { id: 'm1', entity: 'payments db' },
      { id: 'm2', entity: 'payments db' },
      { id: 'm3', entity: 'api' },
      { id: 'm4', entity: 'port' },
    ]);
    expect(want.episodes).toEqual([
      { id: 'm1', session: 's1', seq: 1 },
      { id: 'm2', session: 's1', seq: 1 },
      { id: 'm3', session: 's1', seq: 2 },
      { id: 'm4', session: 's2', seq: 1 },
    ]);
    downgradeSqliteStore({ path: s.dbPath, to: 7 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(7);
    expect(tableNames(s.dbPath)).toEqual([]);
    expect(episodeColumns(s.dbPath)).toEqual([]);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v7'));
    for (const f of fs.readdirSync(s.dir)) {
      if (f.includes('.pre-')) fs.rmSync(path.join(s.dir, f));
    }
    await (await openSqliteStore(optsFor(s))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(8);
    expect(await snapshot(s)).toEqual(want);
    expect(fs.readdirSync(s.dir).filter((f) => f.includes('.pre-'))).toEqual([]);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v8'));
  });

  it('links.v7-to-v8-is-one-transaction', async () => {
    const s = await seeded();
    downgradeSqliteStore({ path: s.dbPath, to: 7 });
    // A table in the way: the migration fails part-way and must leave version 7 exactly.
    const db = raw(s.dbPath);
    db.exec('CREATE TABLE memory_links (x INTEGER)');
    db.close();
    await expect(openSqliteStore(optsFor(s))).rejects.toThrow(/memory_links/);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(7);
    expect(episodeColumns(s.dbPath)).toEqual([]);
    expect(tableNames(s.dbPath)).toEqual(['memory_links']);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v7'));
  });

  it('links.v7-open-that-may-not-migrate-changes-nothing', async () => {
    const s = await seeded();
    downgradeSqliteStore({ path: s.dbPath, to: 7 });
    const before = fs.readFileSync(s.dbPath);
    const err = await openSqliteStore(optsFor(s, { migrate: false })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(7);
    expect(fs.readFileSync(s.dbPath).equals(before)).toBe(true);
  });

  it('links.a-v7-writer-fails-on-a-v8-store', async () => {
    const s = await seeded();
    const db = raw(s.dbPath);
    db.function('oort_writer_v7', () => 1);
    try {
      expect(() => db.prepare("UPDATE memories SET salience = 0.9 WHERE id = 'm1'").run()).toThrow(
        /no such function: oort_writer_v8/,
      );
      expect(() => db.prepare("DELETE FROM memories WHERE id = 'm1'").run()).toThrow(
        /no such function: oort_writer_v8/,
      );
    } finally {
      db.close();
    }
  });

  it('links.downgrade-refuses-while-explicit-distilled-or-blocked-rows-exist', async () => {
    const s = await seeded();
    const store = await openSqliteStore(optsFor(s));
    await store.link!(TG, 'm1', 'm2', { assertedBy: 'user' });
    await store.unlink!(TG, 'm3', 'm4', { assertedBy: 'agent' });
    await store.close();
    expect(() => downgradeSqliteStore({ path: s.dbPath, to: 7 })).toThrow(
      /2 links \(explicit, distilledFrom or blocked\)/,
    );
    expect(() => downgradeSqliteStore({ path: s.dbPath, to: 1 })).toThrow(/2 links/);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(8);
    expect(listBackups(s.dbPath, 'pre-downgrade')).toEqual([]);
    // A distilledFrom row (written by consolidation, CON-152) refuses too.
    const again = await openSqliteStore(optsFor(s));
    await again.unlink!(TG, 'm1', 'm2', { assertedBy: 'user' }); // removes; m1, m2 share an entity: blocked
    await again.link!(TG, 'm1', 'm2', { assertedBy: 'user' }); // unblocked, linked
    await again.unlink!(TG, 'm1', 'm2', { assertedBy: 'user' }); // removed, blocked again
    await again.close();
    const db = raw(s.dbPath);
    const rid = (id: string) =>
      (db.prepare('SELECT rid FROM memories WHERE id = ?').get(id) as { rid: number }).rid;
    db.prepare("DELETE FROM memory_links WHERE kind = 'blocked'").run();
    db.prepare(
      `INSERT INTO memory_links (kind, node_id, a_rid, b_rid, created_at)
       VALUES ('distilledFrom', (SELECT min(node_id) FROM nodes), ?, ?, '2026-11-12T00:00:00.000Z')`,
    ).run(rid('m1'), rid('m3'));
    db.close();
    expect(() => downgradeSqliteStore({ path: s.dbPath, to: 7 })).toThrow(/1 link /);
    // recalledWith rows are learned again: dropped, not refused.
    const db2 = raw(s.dbPath);
    db2.prepare("UPDATE memory_links SET kind = 'recalledWith' WHERE kind = 'distilledFrom'").run();
    db2.close();
    downgradeSqliteStore({ path: s.dbPath, to: 7 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(7);
    expect(tableNames(s.dbPath)).toEqual([]);
  });

  it('links.hive-pairs-and-cross-node-pairs-store-nothing', async () => {
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    const hive = { level: 'hive', orgId: 'local', hiveId: 'team' } as const;
    const star = { level: 'agent', orgId: 'local', agentId: 'claude-code' } as const;
    const g = nodesGrant(planet, hive, star);
    try {
      await store.upsertMany(g, [
        memoryAt('h1', hive, me, { entities: ['payments db'], source: src('s1') }),
        memoryAt('h2', hive, me, { entities: ['payments db'], source: src('s1') }),
        memoryAt('p', planet, me),
        memoryAt('s', star, me),
      ]);
      expect(await store.link!(g, 'h1', 'h2', { assertedBy: 'user' })).toBeNull();
      expect(await store.unlink!(g, 'h1', 'h2', { assertedBy: 'user' })).toBeNull();
      expect(await store.link!(g, 'p', 's', { assertedBy: 'user' })).toBeNull();
      const p = probeFile(s.dbPath);
      expect(await p.links()).toEqual([]);
      expect(await p.entities()).toEqual([]);
      expect(await p.episodes()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('links.forget-composes-with-the-successor-rewrite', async () => {
    // Forgetting A rewrites B, which restated it (CON-144): B is rewritten in place and keeps its
    // own links; every row of A goes with it, in the same transaction as its delete.
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    const day = (n: number) => `2026-11-0${n}T00:00:00.000Z`;
    try {
      await store.upsertMany(TG, [
        memoryAt('a', planet, me, {
          text: 'The dev server runs on port 3000.',
          entities: ['dev server', '3000'],
          createdAt: day(1),
          validTo: day(2),
          expiredAt: day(2),
          endReason: 'superseded',
          supersededBy: 'b',
        }),
        memoryAt('b', planet, me, {
          text: 'The dev server port changed from 3000 to 8080.',
          entities: ['dev server', '3000', '8080'],
          createdAt: day(2),
          supersedes: 'a',
        }),
        memoryAt('c', planet, me, { entities: ['dev server'] }),
      ]);
      await store.link!(TG, 'b', 'c', { assertedBy: 'user' });
      await store.link!(TG, 'a', 'c', { assertedBy: 'agent' });
      await store.unlink!(TG, 'a', 'b', { assertedBy: 'user' });
      const r = await forgetMemory(
        {
          store,
          write: {
            write: async () => {
              throw new Error('unused');
            },
            rewriteCurrent: async (m) => ({
              text: 'The dev server runs on port 8080.',
              stub: m.stub,
              entities: ['dev server', '8080'],
              type: m.type,
            }),
          },
        },
        TG,
        'a',
      );
      expect(r.rewritten.map((x) => x.id)).toEqual(['b']);
      const p = probeFile(s.dbPath);
      expect(await p.links()).toEqual([{ kind: 'explicit', a: 'b', b: 'c', assertedBy: 'user' }]);
      expect(await p.entities()).toEqual([
        { id: 'b', entity: '8080' },
        { id: 'b', entity: 'dev server' },
        { id: 'c', entity: 'dev server' },
      ]);
      expect(await p.orphans()).toBe(0);
      expect((await store.linksOf!(TG, 'b'))?.links.map((l) => l.id)).toEqual(['c']);
    } finally {
      await store.close();
    }
  });
});
