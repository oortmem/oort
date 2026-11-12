/**
 * Schema version 5 (CON-17): the binary vector index. `test/fixtures/schema4` was written by the
 * 0.8.0 store (schema version 4), and `expected.json` is what it read back: every record, the
 * dense hits for six query vectors, a lexical query and a cold copy.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { localGrant, nodeGrant, type Hit, type Memory } from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  makeMemory,
  spatialConformance,
  storeConformance,
  TG,
} from '@oortmem/core/store-conformance';
import { binaryCode } from './binary.js';
import {
  BIT_TABLE,
  downgradeSqliteStore,
  listBackups,
  openSqliteStore,
  reembedSqliteStore,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  sqliteVectorIndex,
  StoreMigrationRequiredError,
  WRITER_GUARD,
  type SqliteStoreOptions,
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE4 = path.join(HERE, '../test/fixtures/schema4');
const DIM = 8;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-binary-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

interface Expected4 {
  list: (Memory & { embedding: number[] | null })[];
  dense: { v: number[]; hits: Hit[] }[];
  lexical: Hit[];
  cold: unknown;
}
const expected4 = JSON.parse(
  fs.readFileSync(path.join(FIXTURE4, 'expected.json'), 'utf8'),
) as Expected4;

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

interface Paths {
  dir: string;
  dbPath: string;
  coldDir: string;
}

function copy4(): Paths {
  const dir = fs.mkdtempSync(path.join(root, 'store4-'));
  fs.cpSync(FIXTURE4, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'expected.json'));
  return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}

/** The copies an open or a downgrade left beside the store (`oort.sqlite.pre-*`). */
function copies(s: Paths): string[] {
  return fs.readdirSync(s.dir).filter((f) => f.startsWith('oort.sqlite.pre-'));
}

function fresh(): Paths {
  const dir = fs.mkdtempSync(path.join(root, 'fresh-'));
  return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}

const optsFor = (s: Paths, extra: Partial<SqliteStoreOptions> = {}): SqliteStoreOptions => ({
  path: s.dbPath,
  coldDir: s.coldDir,
  dimension: DIM,
  now: () => new Date('2026-11-01T00:00:00.000Z'),
  log: () => {},
  ...extra,
});

const render = (m: Memory | null) =>
  m === null ? null : { ...m, embedding: m.embedding === undefined ? null : [...m.embedding] };

/** A raw connection, as an older Oort or a tool would open the file: no writer guard. */
function raw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

const hashFile = (p: string): string =>
  createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function hashDir(dir: string): string {
  const h = createHash('sha256');
  for (const f of fs.readdirSync(dir).sort())
    h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

/** Every int8 vector and the binary index, read without opening the store. */
function vectors(dbPath: string) {
  const db = raw(dbPath);
  try {
    const int8 = db.prepare('SELECT id, hex(embedding) AS e FROM memories_vec ORDER BY id').all();
    const hasBit =
      db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(BIT_TABLE) !== undefined;
    const bit = hasBit
      ? (db
          .prepare(
            `SELECT id, hex(embedding) AS code, hex(rescore) AS rescore, node_key, project_key,
                    author_key FROM ${BIT_TABLE} ORDER BY id`,
          )
          .all() as {
          id: string;
          code: string;
          rescore: string;
          node_key: string;
          project_key: string;
          author_key: string;
        }[])
      : undefined;
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    return { int8: int8 as { id: string; e: string }[], bit, triggers };
  } finally {
    db.close();
  }
}

/** The searchable (non-cold) vectors of the fixture, as the binary index must hold them. */
function expectedBinaryRows(): { id: string; code: string; rescore: string }[] {
  return expected4.list
    .filter((m) => m.embedding !== null && m.tier !== 'cold')
    .map((m) => {
      const v = Int8Array.from(m.embedding!);
      return {
        id: m.id,
        code: binaryCode(v).toString('hex').toUpperCase(),
        rescore: Buffer.from(v.buffer).toString('hex').toUpperCase(),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function readBack(s: Paths, extra: Partial<SqliteStoreOptions> = {}) {
  const store = await openSqliteStore(optsFor(s, extra));
  try {
    const dense: { v: number[]; hits: Hit[] }[] = [];
    for (const d of expected4.dense) {
      dense.push({ v: d.v, hits: await store.dense(g4, Int8Array.from(d.v), 10) });
    }
    return {
      list: (await store.list(g4, { validOnly: false })).map(render),
      dense,
      lexical: (await store.lexical(g4, 'queue shard drains', 10)).map((h) => h.id),
      cold: render(await store.coldGet(g4, 'v4-23')),
    };
  } finally {
    await store.close();
  }
}

/**
 * A copy of the fixture as Oort 0.9 before the binary index leaves it: schema version 5 (spatial
 * memory), with no copies beside it. `placed` adds one memory with a place, as a store that uses
 * spatial memory has.
 */
async function copy5(placed = false): Promise<Paths> {
  const s = copy4();
  const store = await openSqliteStore(optsFor(s));
  if (placed) {
    await store.upsert(
      g4,
      makeMemory({
        id: 'placed',
        text: 'the toolbox is on shelf B3',
        stub: 'toolbox on B3',
        embedding: Int8Array.from([5, 5, 5, 5, 5, 5, 5, 5]),
        place: { nodeId: 'site:hq/room:B/shelf:B3', mapId: 'hq', pose: { x: 1, y: 2 } },
      }),
    );
  }
  await store.close();
  downgradeSqliteStore({ path: s.dbPath, to: 5 });
  for (const f of copies(s)) fs.rmSync(path.join(s.dir, f));
  expect(sqliteSchemaVersion(s.dbPath)).toBe(5);
  return s;
}

/** The place columns `memories` has (version 5 and later have both). */
function placeColumns(dbPath: string): string[] {
  const db = raw(dbPath);
  try {
    return (
      db.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[]
    )
      .map((c) => c.name)
      .filter((n) => n.startsWith('place'));
  } finally {
    db.close();
  }
}

const GUARD_TRIGGERS = [
  'memories_writer_guard_delete',
  'memories_writer_guard_insert',
  'memories_writer_guard_update',
];

describe('schema migration 5 to 6', () => {
  it('migrate.v4-store-reads-back-identically-at-the-current-version', async () => {
    const s = copy4();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(4);
    const before = vectors(s.dbPath);
    expect(before.bit).toBeUndefined();
    const blobs = hashDir(s.coldDir);
    const got = await readBack(s);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(got.list).toEqual(expected4.list);
    expect(got.dense).toEqual(expected4.dense);
    expect(got.lexical).toEqual(expected4.lexical.map((h) => h.id));
    expect(got.cold).toEqual(expected4.cold);
    const after = vectors(s.dbPath);
    expect(after.int8, 'int8 vectors are untouched').toEqual(before.int8);
    // A small store under `auto` gets no binary index: nothing to build, nothing to scan twice.
    expect(after.bit).toBeUndefined();
    expect(after.triggers).toEqual(GUARD_TRIGGERS);
    expect(placeColumns(s.dbPath)).toEqual(['place', 'place_node']);
    expect(hashDir(s.coldDir), 'cold blobs are untouched').toBe(blobs);
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'int8', vectors: 33 });
  });

  it('migrate.v4-takes-only-the-spatial-copy', async () => {
    // Version 4 goes up through 5 to 6 in one transaction: the one copy is spatial memory's
    // `pre-v5`, of the version 4 store. Version 6 adds none.
    const s = copy4();
    await (await openSqliteStore(optsFor(s))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    const pre5 = listBackups(s.dbPath, 'pre-v5');
    expect(pre5).toHaveLength(1);
    expect(sqliteSchemaVersion(pre5[0]!)).toBe(4);
    expect(copies(s)).toEqual([path.basename(pre5[0]!)]);
  });

  it('migrate.v5-takes-no-copy-and-migrates-once', async () => {
    // Additive (triggers and an optional index) and reversible without loss (downgrade to 5):
    // no plaintext copy of every memory that forget would never reach.
    const s = await copy5(true);
    expect(vectors(s.dbPath).triggers).toEqual([]);
    await (await openSqliteStore(optsFor(s))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(vectors(s.dbPath).triggers).toEqual(GUARD_TRIGGERS);
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).close();
    expect(vectors(s.dbPath).bit).toHaveLength(34);
    expect(copies(s)).toEqual([]);
  });

  it('migrate.v5-spatial-store-keeps-its-places-at-the-current-version', async () => {
    const s = await copy5(true);
    const store = await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }));
    try {
      expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
      expect((await store.get(g4, 'placed'))?.place).toEqual({
        nodeId: 'site:hq/room:B/shelf:B3',
        mapId: 'hq',
        pose: { x: 1, y: 2 },
      });
      const v = Int8Array.from([5, 5, 5, 5, 5, 5, 5, 5]);
      const near = { near: { mapId: 'hq', pose: { x: 1, y: 2 }, radius: 0.5 } };
      expect((await store.dense(g4, v, 10, { spatial: near })).map((h) => h.id)).toEqual([
        'placed',
      ]);
      expect(
        (await store.dense(g4, v, 10, { spatial: { within: 'room:B' } })).map((h) => h.id),
      ).toEqual(['placed']);
      expect((await store.lexical(g4, 'toolbox', 10, { spatial: near })).map((h) => h.id)).toEqual([
        'placed',
      ]);
    } finally {
      await store.close();
    }
  });

  it('migrate.v4-open-that-may-not-migrate-changes-nothing', async () => {
    const s = copy4();
    const before = hashFile(s.dbPath);
    const err = await openSqliteStore(optsFor(s, { migrate: false, vectorIndex: 'binary' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(4);
    expect(hashFile(s.dbPath)).toBe(before);
    expect(copies(s)).toEqual([]);
  });

  it('migrate.v5-open-that-may-not-migrate-changes-nothing', async () => {
    const s = await copy5(true);
    const before = hashFile(s.dbPath);
    const err = await openSqliteStore(optsFor(s, { migrate: false, vectorIndex: 'binary' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(5);
    expect(hashFile(s.dbPath)).toBe(before);
    expect(copies(s)).toEqual([]);
  });

  it('migrate.an-open-that-may-not-migrate-never-builds-or-drops-the-index', async () => {
    // The hooks open this way: an index wanted by config waits for the next oort command.
    const s = copy4();
    await (await openSqliteStore(optsFor(s))).close();
    await (await openSqliteStore(optsFor(s, { migrate: false, vectorIndex: 'binary' }))).close();
    expect(vectors(s.dbPath).bit).toBeUndefined();
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).close();
    await (await openSqliteStore(optsFor(s, { migrate: false, vectorIndex: 'int8' }))).close();
    expect(vectors(s.dbPath).bit).toHaveLength(33);
  });

  it('migrate.binary-index-built-from-the-int8-vectors', async () => {
    const s = copy4();
    const before = vectors(s.dbPath);
    const notices: string[] = [];
    const got = await readBack(s, { vectorIndex: 'binary', log: (m) => notices.push(m) });
    expect(notices).toContain('Building the binary vector index (33 vectors)…');
    const after = vectors(s.dbPath);
    expect(after.int8, 'int8 vectors are untouched').toEqual(before.int8);
    expect(after.bit?.map(({ id, code, rescore }) => ({ id, code, rescore }))).toEqual(
      expectedBinaryRows(),
    );
    // Partition and filter columns are copied from the int8 index.
    const star = after.bit?.find((r) => r.id === 'v4-star');
    expect(star?.node_key).toBe('["agent","local","claude-code"]');
    expect(after.bit?.find((r) => r.id === 'v4-proj')?.project_key).toBe('p:oort-1a2b3c4d');
    // The fixture is small, so every candidate is rescored: the same hits, scores and order.
    expect(got.dense).toEqual(expected4.dense);
    expect(got.list).toEqual(expected4.list);
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'binary', vectors: 33 });
  });

  it('migrate.interrupted-build-leaves-the-v5-store-as-it-was', async () => {
    const s = await copy5(true);
    const before = vectors(s.dbPath);
    // A child process opens the store and is killed (SIGKILL) inside the migration's
    // transaction, as the binary index build starts: a crash, not a clean failure.
    const child = spawn(
      process.execPath,
      [path.join(HERE, '../test/crash-open.mjs'), s.dbPath, s.coldDir, String(DIM)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const signal = await new Promise<NodeJS.Signals | null>((r) =>
      child.on('exit', (_code, sig) => r(sig)),
    );
    expect(signal).toBe('SIGKILL');
    expect(out).toContain('building');
    expect(sqliteSchemaVersion(s.dbPath)).toBe(5);
    const db = raw(s.dbPath);
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
    const after = vectors(s.dbPath);
    expect(after.bit).toBeUndefined();
    expect(after.triggers).toEqual([]);
    expect(after.int8).toEqual(before.int8);
    expect(placeColumns(s.dbPath)).toEqual(['place', 'place_node']);
    expect(copies(s)).toEqual([]);
    // The next open migrates as if nothing had happened.
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(vectors(s.dbPath).bit).toHaveLength(34);
    expect(copies(s)).toEqual([]);
  });

  it('migrate.newer-schema-is-refused-unchanged', async () => {
    const s = copy4();
    await (await openSqliteStore(optsFor(s))).close();
    const db = raw(s.dbPath);
    db.function(WRITER_GUARD, () => 1);
    db.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run();
    db.close();
    const before = hashFile(s.dbPath);
    await expect(openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).rejects.toThrow(
      /schema version 8 is not supported \(expected 7\)/,
    );
    expect(hashFile(s.dbPath)).toBe(before);
  });

  it('migrate.writers-that-predate-v6-fail-loudly', async () => {
    // An Oort process started before the upgrade (an MCP server) keeps its connection: its next
    // write must fail, not leave the binary index without the row it wrote.
    const s = copy4();
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).close();
    const before = vectors(s.dbPath);
    const db = raw(s.dbPath);
    try {
      expect(() =>
        db.prepare("UPDATE memories SET salience = 0.9 WHERE id = 'v4-01'").run(),
      ).toThrow(/no such function: oort_writer_v7/);
      expect(() => db.prepare("DELETE FROM memories WHERE id = 'v4-01'").run()).toThrow(
        /no such function: oort_writer_v7/,
      );
      // Reads still work: an older reader sees the same int8 vectors.
      expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 37 });
    } finally {
      db.close();
    }
    expect(vectors(s.dbPath)).toEqual(before);
  });

  it('migrate.v6-down-to-5-and-up-again', async () => {
    const s = await copy5(true);
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).close();
    expect(vectors(s.dbPath).bit).toHaveLength(34);
    // Places are kept: version 5 holds them.
    downgradeSqliteStore({ path: s.dbPath, to: 5 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(5);
    const downCopies = listBackups(s.dbPath, 'pre-downgrade');
    expect(downCopies).toHaveLength(1);
    // The copy is the store as it was, binary index included; it is the only copy.
    expect(sqliteSchemaVersion(downCopies[0]!)).toBe(SCHEMA_VERSION);
    expect(vectors(downCopies[0]!).bit).toHaveLength(34);
    expect(copies(s)).toEqual([path.basename(downCopies[0]!)]);
    const down = vectors(s.dbPath);
    expect(down.bit).toBeUndefined();
    expect(down.triggers).toEqual([]);
    expect(placeColumns(s.dbPath)).toEqual(['place', 'place_node']);
    // What a version 5 build reads and writes: raw writes work again.
    const db = raw(s.dbPath);
    try {
      db.prepare("UPDATE memories SET salience = salience WHERE id = 'v4-01'").run();
      expect(db.prepare("SELECT place_node FROM memories WHERE id = 'placed'").get()).toEqual({
        place_node: 'site:hq/room:B/shelf:B3',
      });
    } finally {
      db.close();
    }
    downgradeSqliteStore({ path: s.dbPath, to: 5 }); // already version 5: nothing to do
    expect(listBackups(s.dbPath, 'pre-downgrade')).toHaveLength(1);
    const store = await openSqliteStore(optsFor(s));
    try {
      expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
      expect((await store.get(g4, 'placed'))?.place?.nodeId).toBe('site:hq/room:B/shelf:B3');
    } finally {
      await store.close();
    }
    expect(copies(s)).toEqual([path.basename(downCopies[0]!)]);
  });

  it('migrate.v6-down-to-4-drops-the-guard-the-index-and-the-places', async () => {
    const s = copy4();
    await (await openSqliteStore(optsFor(s, { vectorIndex: 'binary' }))).close();
    downgradeSqliteStore({ path: s.dbPath, to: 4 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(4);
    const down = vectors(s.dbPath);
    expect(down.bit).toBeUndefined();
    expect(down.triggers).toEqual([]);
    expect(placeColumns(s.dbPath)).toEqual([]);
    const again = await readBack(s);
    expect(again.dense).toEqual(expected4.dense);
    expect(again.list).toEqual(expected4.list);
  });

  it('migrate.new-store-starts-at-the-current-version', async () => {
    const s = fresh();
    await (await openSqliteStore(optsFor(s))).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    expect(vectors(s.dbPath).triggers).toEqual(GUARD_TRIGGERS);
    expect(vectors(s.dbPath).bit).toBeUndefined();
    expect(placeColumns(s.dbPath)).toEqual(['place', 'place_node']);
  });
});

storeConformance('sqlite (binary index)', () => {
  const s = fresh();
  return openSqliteStore({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: CONFORMANCE_DIMENSION,
    vectorIndex: 'binary',
  });
});

spatialConformance('sqlite (binary index)', () => {
  const s = fresh();
  return openSqliteStore({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: CONFORMANCE_DIMENSION,
    vectorIndex: 'binary',
  });
});

describe('binary index', () => {
  const D = 64;
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 255) - 127;
  };
  const randomVec = (next: () => number) => Int8Array.from({ length: D }, next);
  const optsD = (s: Paths, extra: Partial<SqliteStoreOptions> = {}): SqliteStoreOptions => ({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: D,
    log: () => {},
    ...extra,
  });

  /** The ids, codes and rescoring vectors in the binary index. */
  const indexed = (s: Paths) =>
    Object.fromEntries((vectors(s.dbPath).bit ?? []).map((r) => [r.id, [r.code, r.rescore]]));
  const entry = (v: Int8Array) => [
    binaryCode(v).toString('hex').toUpperCase(),
    Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex').toUpperCase(),
  ];

  it('binary.every-write-keeps-the-index-in-step', async () => {
    const s = fresh();
    const next = rng(3);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'binary' }));
    const [a, b, c] = [randomVec(next), randomVec(next), randomVec(next)];
    await store.upsertMany(TG, [
      makeMemory({ id: 'a', embedding: a }),
      makeMemory({ id: 'b', embedding: b }),
      makeMemory({ id: 'bare' }),
    ]);
    expect(indexed(s)).toEqual({ a: entry(a), b: entry(b) });
    await store.upsert(TG, makeMemory({ id: 'a', embedding: c })); // a new embedding
    expect(indexed(s)).toEqual({ a: entry(c), b: entry(b) });
    expect(await store.setTier(TG, 'b', 'cold')).toBe(true); // cold: never searched
    expect(indexed(s)).toEqual({ a: entry(c) });
    expect(await store.setTier(TG, 'b', 'warm')).toBe(true); // back from the int8 vector
    expect(indexed(s)).toEqual({ a: entry(c), b: entry(b) });
    const snap = (await store.get(TG, 'b'))!;
    expect((await store.coldPut(TG, snap)).skipped).toEqual([]);
    expect(indexed(s)).toEqual({ a: entry(c) });
    const blob = (await store.coldGet(TG, 'b'))!;
    await store.upsert(TG, { ...blob, tier: 'warm' }); // hydrated
    expect(indexed(s)).toEqual({ a: entry(c), b: entry(b) });
    await store.forget(TG, 'a');
    expect(indexed(s)).toEqual({ b: entry(b) });
    await store.close();
  });

  it('binary.dense-scores-are-the-int8-scores', async () => {
    const s = fresh();
    const next = rng(11);
    const ms = Array.from({ length: 400 }, (_, i) =>
      makeMemory({ id: `m${String(i).padStart(3, '0')}`, embedding: randomVec(next) }),
    );
    const int8 = await openSqliteStore(optsD(s));
    await int8.upsertMany(TG, ms);
    const queries = Array.from({ length: 20 }, () => randomVec(next));
    const exact: Hit[][] = [];
    for (const q of queries) exact.push(await int8.dense(TG, q, 10));
    const exactAll = await Promise.all(queries.map((q) => int8.dense(TG, q, 400)));
    await int8.close();
    const bin = await openSqliteStore(optsD(s, { vectorIndex: 'binary' }));
    let found = 0;
    for (const [i, q] of queries.entries()) {
      const hits = await bin.dense(TG, q, 10);
      expect(hits).toHaveLength(10);
      // Every score is the int8 cosine of that memory, exactly as the int8 index reports it.
      const score = new Map(exactAll[i]!.map((h) => [h.id, h.score]));
      for (const h of hits) expect(h.score).toBe(score.get(h.id));
      // Best first, ties by recency then id, as the int8 index orders them.
      for (let j = 1; j < hits.length; j++) {
        expect(hits[j - 1]!.score).toBeGreaterThanOrEqual(hits[j]!.score);
      }
      const want = new Set(exact[i]!.map((h) => h.id));
      found += hits.filter((h) => want.has(h.id)).length;
      // Asking for every vector rescores them all: exactly the int8 answer.
      expect(await bin.dense(TG, q, 100)).toEqual(exactAll[i]!.slice(0, 100));
    }
    // Random 64-dimensional vectors are the hard case for 1-bit codes; 10x oversampling still
    // finds most of the true top 10.
    expect(found / (10 * queries.length)).toBeGreaterThan(0.6);
    await bin.close();
  });

  it('binary.auto-builds-above-the-threshold-and-int8-drops-it', async () => {
    const s = fresh();
    const next = rng(5);
    const seed = async (n: number, from = 0) => {
      const store = await openSqliteStore(optsD(s, { binaryAutoThreshold: 10 }));
      await store.upsertMany(
        TG,
        Array.from({ length: n }, (_, i) =>
          makeMemory({ id: `a${from + i}`, embedding: randomVec(next) }),
        ),
      );
      await store.close();
    };
    await seed(9);
    expect(vectors(s.dbPath).bit).toBeUndefined();
    await seed(1, 9); // 10 vectors: built on the next open that may migrate
    expect(vectors(s.dbPath).bit).toBeUndefined();
    await (await openSqliteStore(optsD(s, { binaryAutoThreshold: 10, migrate: false }))).close();
    expect(vectors(s.dbPath).bit, 'an open that may not migrate never builds').toBeUndefined();
    await (await openSqliteStore(optsD(s, { binaryAutoThreshold: 10 }))).close();
    expect(vectors(s.dbPath).bit).toHaveLength(10);
    // `auto` never drops it again, even below the threshold.
    const store = await openSqliteStore(optsD(s, { binaryAutoThreshold: 100 }));
    await store.forget(TG, 'a0');
    await store.close();
    await (await openSqliteStore(optsD(s, { binaryAutoThreshold: 100 }))).close();
    expect(vectors(s.dbPath).bit).toHaveLength(9);
    // An explicit `int8` drops it.
    await (await openSqliteStore(optsD(s, { vectorIndex: 'int8' }))).close();
    expect(vectors(s.dbPath).bit).toBeUndefined();
    expect(sqliteVectorIndex(s.dbPath)).toEqual({ index: 'int8', vectors: 9 });
  });

  it('binary.a-handle-opened-before-the-build-keeps-the-index-in-step', async () => {
    const s = fresh();
    const next = rng(9);
    const first = await openSqliteStore(optsD(s));
    await first.upsert(TG, makeMemory({ id: 'old', embedding: randomVec(next) }));
    // Another process builds the index while this handle is open.
    await (await openSqliteStore(optsD(s, { vectorIndex: 'binary' }))).close();
    const v = randomVec(next);
    await first.upsert(TG, makeMemory({ id: 'new', embedding: v }));
    expect(Object.keys(indexed(s)).sort()).toEqual(['new', 'old']);
    expect(indexed(s)['new']).toEqual(entry(v));
    expect((await first.dense(TG, v, 1))[0]?.id).toBe('new');
    // And when another process drops it, the handle searches the int8 index again.
    await (await openSqliteStore(optsD(s, { vectorIndex: 'int8' }))).close();
    expect((await first.dense(TG, v, 1))[0]?.id).toBe('new');
    await first.upsert(TG, makeMemory({ id: 'after', embedding: randomVec(next) }));
    await first.close();
  });

  it('binary.near-and-within-exclude-out-of-area-rows-before-k', async () => {
    // 60 memories elsewhere hold the query's own vector; the 3 in the area are farther from it.
    // The binary path takes its 10 × k candidates after the spatial filter, as the int8 path
    // takes k: filtered afterwards, every candidate would be out of area and nothing found.
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
    const results = async (vectorIndex: 'binary' | 'int8') => {
      const s = fresh();
      const store = await openSqliteStore(optsD(s, { vectorIndex }));
      try {
        await store.upsertMany(TG, ms);
        await store.close();
        const again = await openSqliteStore(optsD(s, { vectorIndex }));
        try {
          expect(sqliteVectorIndex(s.dbPath)?.index).toBe(vectorIndex);
          const near = { near: { mapId: 'hq', pose: { x: 0, y: 0 }, radius: 1 } };
          const within = { within: 'room:A' };
          return {
            near: await again.dense(TG, q, 2, { spatial: near }),
            within: await again.dense(TG, q, 2, { spatial: within }),
            both: await again.dense(TG, q, 50, { spatial: { ...near, ...within } }),
            unfiltered: (await again.dense(TG, q, 2)).map((h) => h.id),
          };
        } finally {
          await again.close();
        }
      } finally {
        await store.close().catch(() => {});
      }
    };
    const binary = await results('binary');
    for (const hits of [binary.near, binary.within, binary.both]) {
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.id.startsWith('in-'))).toBe(true);
    }
    expect(binary.near).toHaveLength(2);
    expect(binary.within).toHaveLength(2);
    expect(binary.both.map((h) => h.id).sort()).toEqual(['in-0', 'in-1', 'in-2']);
    // Without a filter the crowd wins, so the filter is what keeps it out.
    expect(binary.unfiltered.every((id) => !id.startsWith('in-'))).toBe(true);
    // Few enough rows that every candidate is rescored: the int8 path's hits and scores exactly.
    const int8 = await results('int8');
    expect(binary.near).toEqual(int8.near);
    expect(binary.within).toEqual(int8.within);
    expect(binary.both).toEqual(int8.both);
  });

  it('binary.reembed-rewrites-the-index', async () => {
    const s = fresh();
    const next = rng(13);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'binary' }));
    await store.upsertMany(TG, [
      makeMemory({ id: 'r1', text: 'one', embedding: randomVec(next) }),
      makeMemory({ id: 'r2', text: 'two', embedding: randomVec(next) }),
    ]);
    expect(await store.setTier(TG, 'r2', 'cold')).toBe(true);
    await store.close();
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
    // r2 is cold: its int8 vector is rewritten, and it stays out of the binary index.
    expect(indexed(s)).toEqual({ r1: entry(fresh1) });
    const again = await openSqliteStore(optsD(s));
    expect(
      (
        await again.dense(
          localGrant({
            orgId: 'local',
            customerId: 'self',
            agentId: 'claude-code',
            projectIds: [null],
          }),
          fresh1,
          1,
        )
      )[0]?.id,
    ).toBe('r1');
    await again.close();
  });

  it('binary.an-index-built-during-a-reembed-gets-the-new-vectors', async () => {
    // Another process (an MCP server) builds the index between two of reembed's batches: the
    // batches after it must write the new model's vectors into it too.
    const s = fresh();
    const next = rng(29);
    const store = await openSqliteStore(optsD(s, { vectorIndex: 'int8' }));
    const ids = ['b1', 'b2', 'b3', 'b4'];
    await store.upsertMany(
      TG,
      ids.map((id) => makeMemory({ id, text: id, embedding: randomVec(next) })),
    );
    await store.close();
    const newer = Object.fromEntries(ids.map((id) => [id, randomVec(next)]));
    let built = false;
    await reembedSqliteStore({
      path: s.dbPath,
      coldDir: s.coldDir,
      dimension: D,
      model: 'test/model',
      batchSize: 2,
      embed: async (texts) => {
        if (texts[0] === 'b3' && !built) {
          built = true;
          await (await openSqliteStore(optsD(s, { vectorIndex: 'binary' }))).close();
        }
        return texts.map((t) => newer[t]!);
      },
      log: () => {},
    });
    expect(built).toBe(true);
    expect(indexed(s)).toEqual(Object.fromEntries(ids.map((id) => [id, entry(newer[id]!)])));
  });
});
