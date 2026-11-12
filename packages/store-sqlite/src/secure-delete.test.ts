/**
 * `forget` leaves no copy in the file (CON-140). SQLite normally leaves deleted rows in free
 * pages, and FTS5 keeps a deleted row's terms in its segments until they merge, so the store runs
 * with `PRAGMA secure_delete`, and `forget` merges the lexical index and truncates the WAL.
 * Each test scans the raw bytes of `oort.sqlite` (and its `-wal`) for a marker and its vector.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { forgetMemory, type MemoryStore } from '@oortmem/core';
import { makeMemory, TG } from '@oortmem/core/store-conformance';
import { openSqliteStore, sqliteVectorIndex } from './index.js';

const DIM = 64;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-secure-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A vector no other memory has: its bytes are what the scan looks for. */
const MARKED = Int8Array.from({ length: DIM }, (_, i) => ((i * 37 + 11) % 251) - 125 || 7);
const plain = (i: number): Int8Array =>
  Int8Array.from({ length: DIM }, (_, j) => ((i * 13 + j * 5) % 200) - 100 || 1);

/** A marker with a prefix no other term shares, so FTS5 stores it whole. */
const MARKER = 'zqvmarkerforgotten';
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

async function openAt(index: 'int8' | 'binary'): Promise<{ store: MemoryStore; dbPath: string }> {
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

for (const index of ['int8', 'binary'] as const) {
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
          rewriteWithout: async (m) => ({
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
