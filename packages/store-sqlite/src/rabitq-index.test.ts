/**
 * The RaBitQ index in the SQLite store (CON-25, schema version 7): the conformance suites against
 * both engines, every write path, other handles' writes and forgets, the spatial filter, the
 * `vectorIndex` choices, reembedding, and the migration from version 6 and back.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeGrant, type Hit } from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  grantFor,
  makeMemory,
  spatialConformance,
  storeConformance,
  TG,
} from '@oortmem/core/store-conformance';
import {
  BIT_TABLE,
  downgradeSqliteStore,
  listBackups,
  loadNativeRabitq,
  openSqliteStore,
  reembedSqliteStore,
  RQ_GONE_TABLE,
  RQ_META_TABLE,
  RQ_TABLE,
  RQ_VEC_TABLE,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  sqliteVectorIndex,
  StoreMigrationRequiredError,
  type DenseStats,
  type SqliteStoreOptions,
} from './index.js';
import { rabitqEncode, rotatedCentroid } from './rabitq.js';
import { RabitqReader } from './rabitq-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE4 = path.join(HERE, '../test/fixtures/schema4');
const HAS_NATIVE = 'module' in loadNativeRabitq();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-rabitq-index-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

interface Paths {
  dir: string;
  dbPath: string;
  coldDir: string;
}
function fresh(): Paths {
  const dir = fs.mkdtempSync(path.join(root, 'fresh-'));
  return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}
const copies = (s: Paths) => fs.readdirSync(s.dir).filter((f) => f.startsWith('oort.sqlite.pre-'));

/** A raw connection, as an older Oort or a tool would open the file: no writer guard. */
function raw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

const tables = (dbPath: string): string[] => {
  const db = raw(dbPath);
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memories_%'")
        .all() as { name: string }[]
    )
      .map((t) => t.name)
      .filter((n) => n.startsWith('memories_rq') || n === BIT_TABLE)
      .sort();
  } finally {
    db.close();
  }
};
const RQ_TABLES = [RQ_TABLE, RQ_GONE_TABLE, RQ_META_TABLE, RQ_VEC_TABLE].sort();

for (const engine of ['native', 'typescript'] as const) {
  if (engine === 'native' && !HAS_NATIVE && process.env['OORT_REQUIRE_NATIVE'] !== '1') continue;
  const open = () => {
    const s = fresh();
    return openSqliteStore({
      path: s.dbPath,
      coldDir: s.coldDir,
      dimension: CONFORMANCE_DIMENSION,
      vectorIndex: 'rabitq',
      rabitqEngine: engine,
    });
  };
  storeConformance(`sqlite (rabitq index, ${engine})`, open);
  spatialConformance(`sqlite (rabitq index, ${engine})`, open);
}

describe('rabitq index', () => {
  const D = 64;
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 255) - 127;
  };
  const randomVec = (next: () => number) => Int8Array.from({ length: D }, next);
  /** Clustered vectors: the realistic case, where the bounds prune most of the store. */
  const clustered = (next: () => number, centres: Int8Array[]) => {
    const c = centres[Math.abs(next()) % centres.length]!;
    return Int8Array.from(c, (x) => Math.max(-127, Math.min(127, x + Math.round(next() / 3))));
  };
  const optsD = (s: Paths, extra: Partial<SqliteStoreOptions> = {}): SqliteStoreOptions => ({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: D,
    log: () => {},
    ...extra,
  });

  /** id -> [code, factors, int8 vector] in the index, read without opening the store. */
  function indexed(s: Paths): Record<string, string[]> {
    const db = raw(s.dbPath);
    try {
      const rows = db
        .prepare(
          `SELECT m.id AS id, hex(q.code) AS code, hex(q.factors) AS factors, hex(v.embedding) AS e
           FROM ${RQ_TABLE} q JOIN memories m ON m.rid = q.rid
           LEFT JOIN ${RQ_VEC_TABLE} v ON v.rid = q.rid ORDER BY m.id`,
        )
        .all() as { id: string; code: string; factors: string; e: string }[];
      const orphans = db
        .prepare(
          `SELECT count(*) AS n FROM ${RQ_VEC_TABLE} v WHERE NOT EXISTS
             (SELECT 1 FROM ${RQ_TABLE} q WHERE q.rid = v.rid)`,
        )
        .get() as { n: number };
      expect(orphans.n, 'a rescoring vector without its code').toBe(0);
      return Object.fromEntries(rows.map((r) => [r.id, [r.code, r.factors, r.e]]));
    } finally {
      db.close();
    }
  }
  /** What the index must hold for `v`, with the centroid the store's build recorded. */
  function entry(s: Paths, v: Int8Array): string[] {
    const db = raw(s.dbPath);
    let centroid: Float64Array | undefined;
    try {
      const row = db
        .prepare(`SELECT value FROM ${RQ_META_TABLE} WHERE key = 'centroid'`)
        .get() as { value: Buffer } | undefined;
      if (row !== undefined) {
        const b = Buffer.from(row.value);
        centroid = new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
      }
    } finally {
      db.close();
    }
    const e = rabitqEncode(v, rotatedCentroid(centroid, D));
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
    return [
      hex(e.code),
      hex(new Uint8Array(e.factors.buffer)),
      hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
    ];
  }

  it('rabitq.every-write-keeps-the-index-in-step', async () => {
    const s = fresh();
    const next = rng(3);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }));
    const [a, b, c] = [randomVec(next), randomVec(next), randomVec(next)];
    await store.upsertMany(TG, [
      makeMemory({ id: 'a', embedding: a }),
      makeMemory({ id: 'b', embedding: b }),
      makeMemory({ id: 'bare' }),
    ]);
    expect(indexed(s)).toEqual({ a: entry(s, a), b: entry(s, b) });
    await store.upsert(TG, makeMemory({ id: 'a', embedding: c })); // a new embedding
    expect(indexed(s)).toEqual({ a: entry(s, c), b: entry(s, b) });
    await store.upsert(TG, makeMemory({ id: 'a' })); // the embedding removed
    expect(indexed(s)).toEqual({ b: entry(s, b) });
    await store.upsert(TG, makeMemory({ id: 'a', embedding: c }));
    expect(await store.setTier(TG, 'b', 'cold')).toBe(true); // cold: never searched
    expect(indexed(s)).toEqual({ a: entry(s, c) });
    expect(await store.setTier(TG, 'b', 'warm')).toBe(true); // back from the int8 vector
    expect(indexed(s)).toEqual({ a: entry(s, c), b: entry(s, b) });
    const snap = (await store.get(TG, 'b'))!;
    expect((await store.coldPut(TG, snap)).skipped).toEqual([]);
    expect(indexed(s)).toEqual({ a: entry(s, c) });
    const blob = (await store.coldGet(TG, 'b'))!;
    await store.upsert(TG, { ...blob, tier: 'warm' }); // hydrated
    expect(indexed(s)).toEqual({ a: entry(s, c), b: entry(s, b) });
    await store.forget(TG, 'a');
    expect(indexed(s)).toEqual({ b: entry(s, b) });
    expect((await store.dense(TG, b, 5)).map((h) => h.id)).toEqual(['b']);
    await store.close();
  });

  it('rabitq.dense-scores-are-the-int8-scores-and-the-top-10-is-found', async () => {
    const s = fresh();
    const next = rng(11);
    const centres = Array.from({ length: 20 }, () => randomVec(next));
    const ms = Array.from({ length: 2000 }, (_, i) =>
      makeMemory({ id: `m${String(i).padStart(4, '0')}`, embedding: clustered(next, centres) }),
    );
    const int8 = await openSqliteStore(optsD(s));
    await int8.upsertMany(TG, ms);
    const queries = Array.from({ length: 20 }, () => clustered(next, centres));
    const exact: Hit[][] = [];
    for (const q of queries) exact.push(await int8.dense(TG, q, 2000));
    await int8.close();
    const stats: DenseStats[] = [];
    const rq = await openSqliteStore(
      optsD(s, { vectorIndex: 'rabitq', onDenseStats: (x) => stats.push(x) }),
    );
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'rabitq', vectors: 2000 });
    let found = 0;
    for (const [i, q] of queries.entries()) {
      const hits = await rq.dense(TG, q, 50);
      expect(hits).toHaveLength(50);
      const score = new Map(exact[i]!.map((h) => [h.id, h.score]));
      for (const h of hits) expect(h.score).toBe(score.get(h.id));
      for (let j = 1; j < hits.length; j++) {
        expect(hits[j - 1]!.score).toBeGreaterThanOrEqual(hits[j]!.score);
      }
      const want = new Set(exact[i]!.slice(0, 10).map((h) => h.id));
      found += hits.slice(0, 10).filter((h) => want.has(h.id)).length;
    }
    expect(found / (10 * queries.length)).toBeGreaterThanOrEqual(0.995);
    // Bounded rescoring: far fewer int8 reads than the binary path's 10 x k (500).
    expect(stats.every((x) => x.index === 'rabitq')).toBe(true);
    const reads = stats.reduce((n, x) => n + x.reads, 0) / queries.length;
    expect(reads).toBeGreaterThanOrEqual(50);
    expect(reads).toBeLessThan(250);
    await rq.close();
  });

  it.runIf(HAS_NATIVE)('rabitq.the-typescript-engine-returns-the-native-hits', async () => {
    const s = fresh();
    const next = rng(17);
    const centres = Array.from({ length: 8 }, () => randomVec(next));
    const w = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }));
    await w.upsertMany(
      TG,
      Array.from({ length: 600 }, (_, i) =>
        makeMemory({ id: `t${i}`, embedding: clustered(next, centres) }),
      ),
    );
    await w.close();
    const nat = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq', rabitqEngine: 'native' }));
    const ts = await openSqliteStore(
      optsD(s, { vectorIndex: 'rabitq', rabitqEngine: 'typescript' }),
    );
    for (let i = 0; i < 10; i++) {
      const q = clustered(next, centres);
      expect(await ts.dense(TG, q, 20)).toEqual(await nat.dense(TG, q, 20));
    }
    await nat.close();
    await ts.close();
  });

  it('rabitq.another-handle-takes-writes-and-forgets-before-its-next-search', async () => {
    const s = fresh();
    const next = rng(23);
    const a = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }));
    const b = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq', migrate: false }));
    const v1 = randomVec(next);
    await a.upsert(TG, makeMemory({ id: 'one', embedding: v1 }));
    expect((await b.dense(TG, v1, 1))[0]?.id).toBe('one'); // b loads its engine
    const v2 = randomVec(next);
    await a.upsert(TG, makeMemory({ id: 'two', embedding: v2 }));
    expect((await b.dense(TG, v2, 1))[0]?.id).toBe('two'); // b applies the change
    await a.forget(TG, 'two');
    expect((await b.dense(TG, v2, 5)).map((h) => h.id)).toEqual(['one']);
    // A rebuild elsewhere (another generation) reloads b's engine whole.
    await a.close();
    await (await openSqliteStore(optsD(s, { vectorIndex: 'int8' }))).close();
    await (await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }))).close();
    expect((await b.dense(TG, v1, 1))[0]?.id).toBe('one');
    await b.close();
  });

  it('rabitq.forget-leaves-no-code-vector-or-id-and-the-engine-drops-it', async () => {
    const s = fresh();
    const next = rng(31);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }));
    const vs = Array.from({ length: 5 }, () => randomVec(next));
    await store.upsertMany(
      TG,
      vs.map((v, i) => makeMemory({ id: `secret-${i}`, text: `secret ${i}`, embedding: v })),
    );
    // Another process's engine (a reader on its own connection), loaded before the forget.
    const db = raw(s.dbPath);
    const reader = new RabitqReader(db, D, 'auto', () => {});
    db.transaction(() => reader.refresh())();
    expect(reader.stats().vectors).toBe(5);
    const ridOf = (db.prepare("SELECT rid FROM memories WHERE id = 'secret-2'").get() as {
      rid: number;
    }).rid;
    await store.forget(TG, 'secret-2');
    for (const t of [RQ_TABLE, RQ_VEC_TABLE]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE rid = ?`).get(ridOf)).toEqual({
        n: 0,
      });
    }
    // What remains of it is its row number in the removal log: no id, no code, no text.
    const cols = (db.prepare(`SELECT name FROM pragma_table_info('${RQ_GONE_TABLE}')`).all() as {
      name: string;
    }[]).map((c) => c.name);
    expect(cols).toEqual(['seq', 'rid']);
    expect(db.prepare(`SELECT rid FROM ${RQ_GONE_TABLE}`).all()).toEqual([{ rid: ridOf }]);
    db.transaction(() => reader.refresh())();
    expect(reader.stats().vectors).toBe(4);
    // A reader further behind than the log reaches reloads whole, and still drops it.
    const late = new RabitqReader(db, D, 'typescript', () => {});
    db.prepare(`UPDATE ${RQ_META_TABLE} SET value = 1000000 WHERE key = 'floor'`).run();
    db.transaction(() => late.refresh())();
    expect(late.stats().vectors).toBe(4);
    reader.release();
    late.release();
    expect(reader.stats().vectors).toBe(0);
    db.close();
    await store.close();
  });

  it('rabitq.vector-index-choices-build-drop-and-keep', async () => {
    const s = fresh();
    const next = rng(5);
    const seed = await openSqliteStore(optsD(s, { vectorIndex: 'int8' }));
    await seed.upsertMany(
      TG,
      Array.from({ length: 12 }, (_, i) => makeMemory({ id: `c${i}`, embedding: randomVec(next) })),
    );
    await seed.close();
    expect(tables(s.dbPath)).toEqual([]);
    const reopen = async (extra: Partial<SqliteStoreOptions>) =>
      (await openSqliteStore(optsD(s, extra))).close();
    await reopen({ vectorIndex: 'rabitq', migrate: false });
    expect(tables(s.dbPath), 'an open that may not migrate never builds').toEqual([]);
    await reopen({ vectorIndex: 'binary' });
    expect(tables(s.dbPath)).toEqual([BIT_TABLE]);
    await reopen({ vectorIndex: 'rabitq' }); // one index at most: the binary one goes
    expect(tables(s.dbPath)).toEqual(RQ_TABLES);
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'rabitq', vectors: 12 });
    await reopen({ vectorIndex: 'auto', binaryAutoThreshold: 0 }); // auto keeps it, builds none
    expect(tables(s.dbPath)).toEqual(RQ_TABLES);
    await reopen({ vectorIndex: 'int8', migrate: false });
    expect(tables(s.dbPath), 'an open that may not migrate never drops').toEqual(RQ_TABLES);
    await reopen({ vectorIndex: 'binary' });
    expect(tables(s.dbPath)).toEqual([BIT_TABLE]);
    await reopen({ vectorIndex: 'rabitq' });
    await reopen({ vectorIndex: 'int8' });
    expect(tables(s.dbPath)).toEqual([]);
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'int8', vectors: 12 });
    await expect(openSqliteStore(optsD(s, { vectorIndex: 'float' as 'int8' }))).rejects.toThrow(
      /vectorIndex must be auto, int8, binary or rabitq/,
    );
  });

  it('rabitq.a-handle-opened-before-the-build-keeps-the-index-in-step', async () => {
    const s = fresh();
    const next = rng(9);
    const first = await openSqliteStore(optsD(s));
    await first.upsert(TG, makeMemory({ id: 'old', embedding: randomVec(next) }));
    await (await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }))).close();
    const v = randomVec(next);
    await first.upsert(TG, makeMemory({ id: 'new', embedding: v }));
    expect(Object.keys(indexed(s)).sort()).toEqual(['new', 'old']);
    expect(indexed(s)['new']).toEqual(entry(s, v));
    expect((await first.dense(TG, v, 1))[0]?.id).toBe('new');
    // Dropped elsewhere: the handle releases its engine and scans int8 again.
    await (await openSqliteStore(optsD(s, { vectorIndex: 'int8' }))).close();
    expect((await first.dense(TG, v, 1))[0]?.id).toBe('new');
    await first.upsert(TG, makeMemory({ id: 'after', embedding: randomVec(next) }));
    await first.close();
  });

  it('rabitq.near-and-within-exclude-out-of-area-rows-before-k', async () => {
    const next = rng(11);
    const q = randomVec(next);
    const here = [randomVec(next), randomVec(next), randomVec(next)];
    const area = { nodeId: 'site:hq/room:A', mapId: 'hq', pose: { x: 0, y: 0 } };
    const elsewhere = { nodeId: 'site:hq/room:Z', mapId: 'hq', pose: { x: 100, y: 0 } };
    const ms = [
      ...here.map((v, i) =>
        makeMemory({ id: `in-${i}`, embedding: v, place: { ...area, pose: { x: i * 0.1, y: 0 } } }),
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        makeMemory({ id: `out-${i}`, embedding: q, place: elsewhere }),
      ),
      ...Array.from({ length: 5 }, (_, i) => makeMemory({ id: `bare-${i}`, embedding: q })),
    ];
    const results = async (vectorIndex: 'rabitq' | 'int8') => {
      const s = fresh();
      const store = await openSqliteStore(optsD(s, { vectorIndex }));
      await store.upsertMany(TG, ms);
      try {
        const near = { near: { mapId: 'hq', pose: { x: 0, y: 0 }, radius: 1 } };
        const within = { within: 'room:A' };
        return {
          near: await store.dense(TG, q, 2, { spatial: near }),
          within: await store.dense(TG, q, 2, { spatial: within }),
          both: await store.dense(TG, q, 50, { spatial: { ...near, ...within } }),
          unfiltered: (await store.dense(TG, q, 2)).map((h) => h.id),
        };
      } finally {
        await store.close();
      }
    };
    const rq = await results('rabitq');
    for (const hits of [rq.near, rq.within, rq.both]) {
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.id.startsWith('in-'))).toBe(true);
    }
    expect(rq.both.map((h) => h.id).sort()).toEqual(['in-0', 'in-1', 'in-2']);
    expect(rq.unfiltered.every((id) => !id.startsWith('in-'))).toBe(true);
    const int8 = await results('int8');
    expect(rq.near).toEqual(int8.near);
    expect(rq.within).toEqual(int8.within);
    expect(rq.both).toEqual(int8.both);
  });

  it('rabitq.grants-and-projects-filter-before-k', async () => {
    // Another end user's memories, and another project's, hold the query's own vector; they must
    // never crowd out, or show up among, this grant's hits.
    const s = fresh();
    const next = rng(41);
    const q = randomVec(next);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }));
    const base = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
    const theirs = { ...base, customerId: 'someone-else' };
    await store.upsertMany(
      grantFor(theirs),
      Array.from({ length: 80 }, (_, i) =>
        makeMemory({ id: `theirs-${i}`, embedding: q, scope: theirs }),
      ),
    );
    const other = { ...base, projectId: 'other' };
    await store.upsertMany(
      grantFor(other),
      Array.from({ length: 80 }, (_, i) =>
        makeMemory({ id: `other-${i}`, embedding: q, scope: other }),
      ),
    );
    const mine = { ...base };
    await store.upsertMany(grantFor(mine), [
      makeMemory({ id: 'm1', embedding: randomVec(next), scope: mine }),
      makeMemory({ id: 'm2', embedding: randomVec(next), scope: mine }),
    ]);
    expect((await store.dense(grantFor(mine), q, 2)).map((h) => h.id).sort()).toEqual([
      'm1',
      'm2',
    ]);
    expect((await store.dense(grantFor(other), q, 100)).map((h) => h.id)).toHaveLength(80);
    await store.close();
  });

  it('rabitq.reembed-rewrites-the-index', async () => {
    const s = fresh();
    const next = rng(13);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'rabitq' }));
    await store.upsertMany(TG, [
      makeMemory({ id: 'r1', text: 'one', embedding: randomVec(next) }),
      makeMemory({ id: 'r2', text: 'two', embedding: randomVec(next) }),
    ]);
    expect(await store.setTier(TG, 'r2', 'cold')).toBe(true);
    // This handle keeps its engine across the reembed; it must see the new vectors.
    expect(await store.dense(TG, randomVec(next), 1)).toHaveLength(1);
    const fresh1 = randomVec(next);
    const fresh2 = randomVec(next);
    await reembedSqliteStore({
      path: s.dbPath,
      coldDir: s.coldDir,
      dimension: D,
      model: 'test/model',
      embed: async (texts) => texts.map((t) => (t === 'one' ? fresh1 : fresh2)),
      log: () => {},
    });
    expect(indexed(s)).toEqual({ r1: entry(s, fresh1) });
    const hits = await store.dense(TG, fresh1, 1);
    expect(hits[0]?.id).toBe('r1');
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    await store.close();
  });
});

describe('schema migration 6 to 7', () => {
  const DIM = 8;
  const g4 = nodeGrant({
    principal: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    read: [
      { node: { level: 'user', orgId: 'local', customerId: 'self' }, projectIds: 'all' },
      { node: { level: 'agent', orgId: 'local', agentId: 'claude-code' }, projectIds: 'all' },
    ],
    write: [
      { node: { level: 'user', orgId: 'local', customerId: 'self' }, projectIds: 'all' },
      { node: { level: 'agent', orgId: 'local', agentId: 'claude-code' }, projectIds: 'all' },
    ],
  });
  const optsFor = (s: Paths, extra: Partial<SqliteStoreOptions> = {}): SqliteStoreOptions => ({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: DIM,
    now: () => new Date('2026-11-01T00:00:00.000Z'),
    log: () => {},
    ...extra,
  });
  /** The schema 4 fixture as Oort 0.9 (schema version 6) leaves it, optionally with its binary index. */
  async function copy6(vectorIndex: 'binary' | 'int8' = 'int8'): Promise<Paths> {
    const dir = fs.mkdtempSync(path.join(root, 'store6-'));
    fs.cpSync(FIXTURE4, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'expected.json'));
    const s = { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
    await (await openSqliteStore(optsFor(s, { vectorIndex }))).close();
    downgradeSqliteStore({ path: s.dbPath, to: 6 });
    for (const f of copies(s)) fs.rmSync(path.join(s.dir, f));
    expect(sqliteSchemaVersion(s.dbPath)).toBe(6);
    return s;
  }
  const guardFunctions = (dbPath: string): string[] => {
    const db = raw(dbPath);
    try {
      return (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all() as { sql: string }[]
      ).map((t) => /SELECT (oort_writer_v\d+)\(\)/.exec(t.sql)?.[1] ?? '?');
    } finally {
      db.close();
    }
  };
  async function readBack(s: Paths, extra: Partial<SqliteStoreOptions> = {}) {
    const store = await openSqliteStore(optsFor(s, extra));
    try {
      return {
        list: (await store.list(g4, { validOnly: false, embeddings: false })).map((m) => m.id),
        dense: await store.dense(g4, Int8Array.from([10, -3, 7, 0, 22, -9, 4, 1]), 10),
      };
    } finally {
      await store.close();
    }
  }

  it('migrate.v6-to-v7-takes-no-copy-and-swaps-the-guard', async () => {
    const s = await copy6('binary');
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v6'));
    const before = await readBack(await copy6('int8'));
    expect(await readBack(s)).toEqual(before); // `auto` keeps the binary index
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(copies(s)).toEqual([]);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v7'));
    expect(tables(s.dbPath)).toEqual([BIT_TABLE]);
    // A version 6 writer still running fails loudly, changing nothing.
    const db = raw(s.dbPath);
    db.function('oort_writer_v6', () => 1);
    try {
      expect(() =>
        db.prepare("UPDATE memories SET salience = 0.9 WHERE id = 'v4-01'").run(),
      ).toThrow(/no such function: oort_writer_v7/);
    } finally {
      db.close();
    }
    // Asking for the RaBitQ index: built from the int8 vectors, same hits for this tiny store.
    expect(await readBack(s, { vectorIndex: 'rabitq' })).toEqual(before);
    expect(tables(s.dbPath)).toEqual(RQ_TABLES);
  });

  it('migrate.v6-open-that-may-not-migrate-changes-nothing', async () => {
    const s = await copy6();
    const before = fs.readFileSync(s.dbPath);
    await expect(openSqliteStore(optsFor(s, { migrate: false }))).rejects.toBeInstanceOf(
      StoreMigrationRequiredError,
    );
    expect(fs.readFileSync(s.dbPath).equals(before)).toBe(true);
  });

  it('migrate.interrupted-rabitq-build-leaves-the-v6-store-as-it-was', async () => {
    const s = await copy6();
    const child = spawn(
      process.execPath,
      [path.join(HERE, '../test/crash-open.mjs'), s.dbPath, s.coldDir, String(DIM), 'rabitq'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const signal = await new Promise<NodeJS.Signals | null>((r) =>
      child.on('exit', (_code, sig) => r(sig)),
    );
    expect(signal).toBe('SIGKILL');
    expect(out).toContain('building');
    expect(sqliteSchemaVersion(s.dbPath)).toBe(6);
    const db = raw(s.dbPath);
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
    expect(tables(s.dbPath)).toEqual([]);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v6'));
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'rabitq' }))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'rabitq', vectors: 33 });
  });

  it('migrate.v7-down-to-6-drops-the-rabitq-index-and-up-again', async () => {
    const s = await copy6();
    const before = await readBack(s, { vectorIndex: 'rabitq' });
    downgradeSqliteStore({ path: s.dbPath, to: 6 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(6);
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    expect(tables(s.dbPath)).toEqual([]);
    expect(guardFunctions(s.dbPath)).toEqual(Array(3).fill('oort_writer_v6'));
    // What a version 6 build writes through: its guard function.
    const db = raw(s.dbPath);
    db.function('oort_writer_v6', () => 1);
    try {
      db.prepare("UPDATE memories SET salience = salience WHERE id = 'v4-01'").run();
    } finally {
      db.close();
    }
    expect(await readBack(s, { vectorIndex: 'rabitq' })).toEqual(before);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    // Down to 5 from 7 in one step.
    downgradeSqliteStore({ path: s.dbPath, to: 5 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(5);
    expect(guardFunctions(s.dbPath)).toEqual([]);
    expect(tables(s.dbPath)).toEqual([]);
  });
});
