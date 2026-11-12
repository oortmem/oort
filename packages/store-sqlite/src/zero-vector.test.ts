/**
 * An all-zero vector has no direction (CON-141). `vec_distance_cosine` returns NaN for it, SQLite
 * reads NaN as NULL, and `1 - NULL` used to rank it first with score 1. So a zero embedding is
 * not kept, and a zero query vector matches nothing; recall then answers from the lexical search.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { recall, resolveConfig, type MemoryStore } from '@oortmem/core';
import { makeMemory, TG } from '@oortmem/core/store-conformance';
import { BIT_TABLE, openSqliteStore, sqliteVectorIndex } from './index.js';

const DIM = 8;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-zero-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const config = resolveConfig(root, { OORT_HOME: path.join(root, 'home') });

/** A spread of non-zero vectors, none of them parallel to the query below. */
const normal = (i: number): Int8Array =>
  Int8Array.from({ length: DIM }, (_, j) => ((i * 7 + j * 13) % 50) - 20 || 1);
const QUERY = Int8Array.from([5, 3, -2, 7, 1, 9, -4, 2]);

const open = (dbPath: string, index: 'int8' | 'binary'): Promise<MemoryStore> =>
  openSqliteStore({
    path: dbPath,
    coldDir: path.join(path.dirname(dbPath), 'cold'),
    dimension: DIM,
    vectorIndex: index,
    binaryAutoThreshold: 0,
    log: () => {},
  });

async function seeded(index: 'int8' | 'binary'): Promise<{ store: MemoryStore; dbPath: string }> {
  const dir = fs.mkdtempSync(path.join(root, `${index}-`));
  const dbPath = path.join(dir, 'oort.sqlite');
  const store = await open(dbPath, index);
  const ms = [
    makeMemory({
      id: 'zero',
      text: 'the zero vector memory about ports',
      embedding: new Int8Array(DIM),
    }),
  ];
  for (let i = 0; i < 20; i++) {
    ms.push(makeMemory({ id: `m${i}`, text: `memory about topic${i}`, embedding: normal(i) }));
  }
  await store.upsertMany(TG, ms);
  return { store, dbPath };
}

for (const index of ['int8', 'binary'] as const) {
  describe(`zero vectors, ${index} index (CON-141)`, () => {
    it('zero.stored-vector-never-matches', async () => {
      const { store, dbPath } = await seeded(index);
      expect(sqliteVectorIndex(dbPath)?.index).toBe(index);
      const hits = await store.dense(TG, QUERY, 10);
      expect(hits).toHaveLength(10);
      expect(hits.map((h) => h.id)).not.toContain('zero');
      for (const h of hits) expect(h.score).toBeLessThan(1);
      // Kept as a memory without a vector: lexical search still finds it.
      expect((await store.get(TG, 'zero'))?.embedding).toBeUndefined();
      expect((await store.lexical(TG, 'zero vector', 5)).map((h) => h.id)).toContain('zero');
      await store.close();
    });

    it('zero.query-vector-returns-no-dense-hits', async () => {
      const { store } = await seeded(index);
      expect(await store.dense(TG, new Int8Array(DIM), 10)).toEqual([]);
      await store.close();
    });

    it('zero.recall-falls-back-to-lexical', async () => {
      const { store } = await seeded(index);
      const embed = {
        dimension: DIM,
        embed: async (texts: string[]) => texts.map(() => new Int8Array(DIM)),
      };
      const r = await recall({ text: 'topic7', grant: TG }, { store, embed, config });
      expect(r.memories.map((m) => m.id)).toContain('m7');
      expect(r.memories.map((m) => m.id)).toEqual(['m7']);
      await store.close();
    });

    it('zero.vector-an-older-version-stored-scores-nothing', async () => {
      const { store, dbPath } = await seeded(index);
      await store.close();
      // 0.9.0 kept zero vectors: put one back underneath the store.
      const raw = new Database(dbPath);
      sqliteVec.load(raw);
      const zero = Buffer.from(new Int8Array(DIM).buffer);
      const row = raw
        .prepare('SELECT node_key, project_key, author_key, tier FROM memories_vec WHERE id = ?')
        .get('m0') as Record<string, string>;
      raw.prepare('DELETE FROM memories_vec WHERE id = ?').run('m0');
      raw
        .prepare(
          `INSERT INTO memories_vec (id, embedding, node_key, project_key, author_key, tier)
           VALUES ('m0', vec_int8(?), ?, ?, ?, ?)`,
        )
        .run(zero, row['node_key'], row['project_key'], row['author_key'], row['tier']);
      if (index === 'binary') {
        raw.prepare(`UPDATE ${BIT_TABLE} SET rescore = ? WHERE id = ?`).run(zero, 'm0');
      }
      raw.close();
      const reopened = await open(dbPath, index);
      const hits = await reopened.dense(TG, QUERY, 10);
      expect(hits.map((h) => h.id)).not.toContain('m0');
      for (const h of hits) expect(h.score).toBeLessThan(1);
      await reopened.close();
    });
  });
}
