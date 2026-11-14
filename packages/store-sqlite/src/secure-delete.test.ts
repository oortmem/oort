/**
 * `forget` leaves no copy in the file (CON-140). SQLite normally leaves deleted rows in free
 * pages, so the store runs with `PRAGMA secure_delete`; the lexical index removes a row's terms
 * itself (FTS5's `secure-delete`, CON-159); and `forget` truncates the WAL.
 * Each test scans the raw bytes of `oort.sqlite` (and its `-wal`) for a marker and its vector.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { forgetMemory, type MemoryStore } from '@oortmem/core';
import { makeMemory, TG } from '@oortmem/core/store-conformance';
import * as sqliteVec from 'sqlite-vec';
import {
  openSqliteStore,
  sqliteEraseState,
  sqliteVectorIndex,
  vacuumSqliteStore,
  BIT_TABLE,
  FTS_VALUES_TABLE,
  WRITER_GUARD,
} from './index.js';

const DIM = 64;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-secure-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A vector no other memory has: its bytes are what the scan looks for. */
const MARKED = Int8Array.from({ length: DIM }, (_, i) => ((i * 37 + 11) % 251) - 125 || 7);
const plain = (i: number): Int8Array =>
  Int8Array.from({ length: DIM }, (_, j) => ((i * 13 + j * 5) % 200) - 100 || 1);

/**
 * A marker with a prefix no other term shares, so FTS5 stores it whole; and a value (it holds a
 * digit), as a forgotten port, path or version would be (`distinctiveTokens`).
 */
const MARKER = 'zqvmarker7forgotten';
/** Long enough to spill into an overflow page, which is freed whole on delete. */
const LONG = `${MARKER} ${'padding words that fill the row '.repeat(200)}`;

/** Every file the store keeps beside its database, as one buffer. */
function bytesOf(dbPath: string): Buffer {
  return Buffer.concat(
    ['', '-wal']
      .map((s) => `${dbPath}${s}`)
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f)),
  );
}

async function openAt(
  index: 'int8' | 'binary' | 'rabitq',
): Promise<{ store: MemoryStore; dbPath: string }> {
  const dir = fs.mkdtempSync(path.join(root, `${index}-`));
  const dbPath = path.join(dir, 'oort.sqlite');
  const store = await openSqliteStore({
    path: dbPath,
    coldDir: path.join(dir, 'cold'),
    dimension: DIM,
    vectorIndex: index,
    binaryAutoThreshold: 0,
    log: () => {},
  });
  // Neighbours on the same pages, so the marked row is not alone in its page.
  await store.upsertMany(
    TG,
    Array.from({ length: 30 }, (_, i) =>
      makeMemory({ id: `n${i}`, text: `neighbour ${i} about ports`, embedding: plain(i) }),
    ),
  );
  return { store, dbPath };
}

/** A checkpoint from another connection, as a later open or backup would see the file. */
function checkpoint(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.pragma('wal_checkpoint(TRUNCATE)');
  raw.close();
}

for (const index of ['int8', 'binary', 'rabitq'] as const) {
  describe(`forget leaves no copy in the file, ${index} index (CON-140)`, () => {
    it('secure-delete.forget-erases-text-and-vector-bytes', async () => {
      const { store, dbPath } = await openAt(index);
      expect(sqliteVectorIndex(dbPath)?.index).toBe(index);
      await store.upsert(
        TG,
        makeMemory({
          id: 'secret',
          text: LONG,
          stub: `${MARKER} stub`,
          entities: [MARKER],
          embedding: MARKED,
        }),
      );
      checkpoint(dbPath);
      const vecBytes = Buffer.from(MARKED.buffer, MARKED.byteOffset, MARKED.byteLength);
      // The scan sees both while the memory exists.
      expect(bytesOf(dbPath).includes(MARKER)).toBe(true);
      expect(bytesOf(dbPath).includes(vecBytes)).toBe(true);

      await store.forget(TG, 'secret');
      checkpoint(dbPath);
      const after = bytesOf(dbPath);
      expect(after.includes(MARKER)).toBe(false);
      expect(after.includes(vecBytes)).toBe(false);
      // The neighbours are untouched.
      expect((await store.lexical(TG, 'neighbour', 50)).length).toBe(30);
      expect((await store.dense(TG, plain(3), 1))[0]?.id).toBe('n3');
      await store.close();
    });

    it('secure-delete.forget-also-purges-text-a-rewrite-replaced', async () => {
      // CON-144 rewrites a successor, then forgets the memory it restated.
      const { store, dbPath } = await openAt(index);
      await store.upsert(TG, makeMemory({ id: 'a', text: `the port is ${MARKER}` }));
      await store.upsert(
        TG,
        makeMemory({ id: 'b', text: `port changed from ${MARKER} to 8080`, embedding: MARKED }),
      );
      checkpoint(dbPath);
      expect(bytesOf(dbPath).includes(MARKER)).toBe(true);
      await store.upsert(
        TG,
        makeMemory({ id: 'b', text: 'the port is 8080', embedding: plain(99) }),
      );
      await store.forget(TG, 'a');
      checkpoint(dbPath);
      expect(bytesOf(dbPath).includes(MARKER)).toBe(false);
      expect(bytesOf(dbPath).includes(Buffer.from(MARKED.buffer))).toBe(false);
      expect((await store.lexical(TG, '8080', 5)).map((h) => h.id)).toEqual(['b']);
      await store.close();
    });

    it('secure-delete.forget-truncates-the-wal', async () => {
      const { store, dbPath } = await openAt(index);
      await store.upsert(TG, makeMemory({ id: 'secret', text: LONG, embedding: MARKED }));
      await store.forget(TG, 'secret');
      // No checkpoint from outside: forget itself leaves no frame holding the old pages.
      expect(bytesOf(dbPath).includes(MARKER)).toBe(false);
      await store.close();
    });
  });
}

describe('forgetting a memory a later one restated (CON-144)', () => {
  it('secure-delete.no-row-index-or-byte-keeps-the-forgotten-value', async () => {
    const { store, dbPath } = await openAt('binary');
    const old = new Date(Date.UTC(2026, 9, 1)).toISOString();
    const later = new Date(Date.UTC(2026, 9, 2)).toISOString();
    await store.upsertMany(TG, [
      makeMemory({
        id: 'a',
        text: `The dev server runs on port ${MARKER}.`,
        createdAt: old,
        supersededBy: 'b',
        embedding: plain(50),
      }),
      makeMemory({
        id: 'b',
        text: `The dev server port changed from ${MARKER} to 8080.`,
        stub: `dev server port ${MARKER} 8080`,
        entities: [MARKER, '8080'],
        createdAt: later,
        supersedes: 'a',
        embedding: MARKED,
      }),
    ]);
    checkpoint(dbPath);
    expect(bytesOf(dbPath).includes(MARKER)).toBe(true);
    const r = await forgetMemory(
      {
        store,
        write: {
          write: () => Promise.reject(new Error('not used')),
          rewriteCurrent: async (m) => ({
            text: 'The dev server port is 8080.',
            stub: 'dev server port 8080',
            entities: m.entities.filter((e) => e !== MARKER),
            type: m.type,
          }),
        },
        embed: { dimension: DIM, embed: async (t) => t.map(() => plain(51)) },
      },
      TG,
      'a',
    );
    expect(r.rewritten.map((x) => x.id)).toEqual(['b']);
    expect(await store.lexical(TG, MARKER, 10)).toEqual([]);
    expect((await store.lexical(TG, '8080', 10)).map((h) => h.id)).toEqual(['b']);
    checkpoint(dbPath);
    expect(bytesOf(dbPath).includes(MARKER)).toBe(false);
    expect(bytesOf(dbPath).includes(Buffer.from(MARKED.buffer))).toBe(false);
    await store.close();
  });
});

/**
 * A store as Oort 0.9.0 left it (no `secure_delete`): a forgotten memory's text in a free page
 * and in the lexical index's segments, a zero vector, and no record of the erase. Its schema is
 * the current one, so that a hook can open it; the lexical index's own `secure-delete` is off for
 * the delete, which then leaves a tombstone holding the terms, as 0.9.0's index did.
 */
async function asOld(index: 'int8' | 'binary'): Promise<string> {
  const { store, dbPath } = await openAt(index);
  await store.upsert(TG, makeMemory({ id: 'secret', text: LONG, embedding: plain(90) }));
  await store.close();
  const raw = new Database(dbPath);
  sqliteVec.load(raw);
  raw.function(WRITER_GUARD, { deterministic: true }, () => 1);
  raw.pragma('secure_delete = OFF');
  const { rid } = raw.prepare("SELECT rid FROM memories WHERE id = 'secret'").get() as {
    rid: number;
  };
  // 0.9.0's forget: the row, its lexical entry (a tombstone) and its vector, nothing merged.
  raw.prepare("DELETE FROM memories WHERE id = 'secret'").run();
  const indexed = raw
    .prepare(`SELECT text, stub, entities FROM ${FTS_VALUES_TABLE} WHERE rid = ?`)
    .get(rid) as { text: string; stub: string; entities: string };
  raw.exec("INSERT INTO memories_fts2 (memories_fts2, rank) VALUES ('secure-delete', 0)");
  raw
    .prepare(
      `INSERT INTO memories_fts2 (memories_fts2, rowid, text, stub, entities)
       VALUES ('delete', ?, ?, ?, ?)`,
    )
    .run(rid, indexed.text, indexed.stub, indexed.entities);
  raw.exec("INSERT INTO memories_fts2 (memories_fts2, rank) VALUES ('secure-delete', 1)");
  raw.prepare(`DELETE FROM ${FTS_VALUES_TABLE} WHERE rid = ?`).run(rid);
  raw.prepare("DELETE FROM memories_vec WHERE id = 'secret'").run();
  if (index === 'binary') raw.prepare(`DELETE FROM ${BIT_TABLE} WHERE id = 'secret'`).run();
  // 0.9.0 also kept an all-zero vector.
  const row = raw
    .prepare("SELECT node_key, project_key, author_key, tier FROM memories_vec WHERE id = 'n0'")
    .get() as Record<string, string>;
  raw.prepare("DELETE FROM memories_vec WHERE id = 'n0'").run();
  raw
    .prepare(
      `INSERT INTO memories_vec (id, embedding, node_key, project_key, author_key, tier)
       VALUES ('n0', vec_int8(?), ?, ?, ?, ?)`,
    )
    .run(Buffer.alloc(DIM), row['node_key'], row['project_key'], row['author_key'], row['tier']);
  raw.prepare("DELETE FROM meta WHERE key = 'old_text_erased'").run();
  raw.pragma('wal_checkpoint(TRUNCATE)');
  raw.close();
  return dbPath;
}

const reopen = (dbPath: string, more: { migrate?: boolean; eraseOldText?: 'now' } = {}) =>
  openSqliteStore({
    path: dbPath,
    coldDir: path.join(path.dirname(dbPath), 'cold'),
    dimension: DIM,
    vectorIndex: 'binary',
    binaryAutoThreshold: 0,
    log: () => {},
    ...more,
  });

describe('a store upgraded from 0.9.0 (CON-140)', () => {
  it('secure-delete.an-old-store-holds-deleted-text-until-the-one-time-erase', async () => {
    const dbPath = await asOld('binary');
    expect(bytesOf(dbPath).includes(MARKER)).toBe(true);
    expect(sqliteEraseState(dbPath)).toMatchObject({ erased: false, zeroVectors: 1 });

    // A hook's open (no migrations) never runs it.
    const hook = await reopen(dbPath, { migrate: false });
    await hook.close();
    expect(bytesOf(dbPath).includes(MARKER)).toBe(true);
    expect(sqliteEraseState(dbPath)?.erased).toBe(false);

    // The first open that may migrate does, once: a small store needs under a second.
    const store = await reopen(dbPath);
    expect(bytesOf(dbPath).includes(MARKER)).toBe(false);
    expect(sqliteEraseState(dbPath)).toMatchObject({ erased: true, zeroVectors: 0 });
    expect((await store.list(TG, { validOnly: false })).length).toBe(30);
    // The zero vector is gone; the memory stays, found by its words.
    expect((await store.dense(TG, plain(1), 40)).map((h) => h.id)).not.toContain('n0');
    expect((await store.lexical(TG, 'neighbour', 40)).map((h) => h.id)).toContain('n0');
    await store.close();
  });

  it('secure-delete.a-reader-mid-read-leaves-the-erase-pending', async () => {
    const dbPath = await asOld('int8');
    // Another process in the middle of a read: the checkpoint cannot copy the rewrite back.
    const reader = new Database(dbPath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM memories').get();
    const logged: string[] = [];
    const store = await openSqliteStore({
      path: dbPath,
      coldDir: path.join(path.dirname(dbPath), 'cold'),
      dimension: DIM,
      vectorIndex: 'int8',
      busyTimeoutMs: 50,
      log: (m) => logged.push(m),
    });
    await store.close();
    expect(sqliteEraseState(dbPath)?.erased).toBe(false);
    expect(logged.join('\n')).toContain('stays until the next open');
    reader.exec('COMMIT');
    reader.close();
    // The next open finishes it.
    const again = await reopen(dbPath);
    await again.close();
    expect(sqliteEraseState(dbPath)?.erased).toBe(true);
    expect(bytesOf(dbPath).includes(MARKER)).toBe(false);
  });

  it('secure-delete.vacuum-runs-the-erase-on-request', async () => {
    const dbPath = await asOld('int8');
    expect(vacuumSqliteStore({ path: dbPath })).toBe(true);
    expect(bytesOf(dbPath).includes(MARKER)).toBe(false);
    expect(sqliteEraseState(dbPath)?.erased).toBe(true);
  });

  it('secure-delete.vacuum-also-removes-zero-vectors-stored-after-the-erase', async () => {
    const dbPath = await asOld('int8');
    const store = await reopen(dbPath);
    await store.close();
    expect(sqliteEraseState(dbPath)).toMatchObject({ erased: true, zeroVectors: 0 });
    // An older oort still running elsewhere stores another one.
    const raw = new Database(dbPath);
    sqliteVec.load(raw);
    const row = raw
      .prepare("SELECT node_key, project_key, author_key, tier FROM memories_vec WHERE id = 'n1'")
      .get() as Record<string, string>;
    raw.prepare("DELETE FROM memories_vec WHERE id = 'n1'").run();
    raw
      .prepare(
        `INSERT INTO memories_vec (id, embedding, node_key, project_key, author_key, tier)
         VALUES ('n1', vec_int8(?), ?, ?, ?, ?)`,
      )
      .run(Buffer.alloc(DIM), row['node_key'], row['project_key'], row['author_key'], row['tier']);
    raw.close();
    expect(sqliteEraseState(dbPath)?.zeroVectors).toBe(1);
    expect(vacuumSqliteStore({ path: dbPath })).toBe(true);
    expect(sqliteEraseState(dbPath)?.zeroVectors).toBe(0);
  });

  it('secure-delete.a-new-store-needs-no-erase', async () => {
    const { store, dbPath } = await openAt('int8');
    await store.close();
    expect(sqliteEraseState(dbPath)).toMatchObject({ erased: true, zeroVectors: 0 });
  });

  it('secure-delete.forget-says-when-a-reader-keeps-the-wal', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'busy-'));
    const dbPath = path.join(dir, 'oort.sqlite');
    const logged: string[] = [];
    const store = await openSqliteStore({
      path: dbPath,
      coldDir: path.join(dir, 'cold'),
      dimension: DIM,
      log: (m) => logged.push(m),
    });
    await store.upsert(TG, makeMemory({ id: 'secret', text: LONG, embedding: MARKED }));
    // Another process in the middle of a read (the MCP server answering a recall).
    const reader = new Database(dbPath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM memories').get();
    await store.forget(TG, 'secret');
    expect(logged.join('\n')).toContain('write-ahead log keeps the old pages');
    expect(logged.join('\n')).not.toContain(MARKER);
    reader.exec('COMMIT');
    reader.close();
    await store.forget(TG, 'none');
    await store.close();
  });
});
