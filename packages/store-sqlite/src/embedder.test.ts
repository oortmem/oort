import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TG, makeMemory, seedCold, vec } from '@oortmem/core/store-conformance';
import {
  openSqliteStore,
  readEmbedderBinding,
  reembedSqliteStore,
  writeEmbedderBinding,
} from './index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-store-embedder-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function opts() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  return {
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: 4,
    log: () => {},
  };
}

/** A fake "new model": the vector is [len, 1, 0, 0] scaled into int8. */
const embedNew = async (texts: string[]): Promise<Int8Array[]> =>
  texts.map((t) => vec(Math.min(127, t.length), 1, 0, 0));

describe('embedder binding', () => {
  it('store.binding-null-until-written', async () => {
    const o = opts();
    expect(readEmbedderBinding(o.path)).toEqual({ model: null, hasMemories: false });
    const store = await openSqliteStore(o);
    expect(readEmbedderBinding(o.path)).toEqual({ model: null, hasMemories: false });
    await store.upsert(TG, makeMemory({ id: 'a', embedding: vec(1, 0, 0, 0) }));
    expect(readEmbedderBinding(o.path)).toEqual({ model: null, hasMemories: true });
    writeEmbedderBinding(o.path, 'local/tiny');
    expect(readEmbedderBinding(o.path)).toEqual({ model: 'local/tiny', hasMemories: true });
    await store.close();
    // The binding survives a reopen; it is not part of the dimension check.
    const again = await openSqliteStore(o);
    expect(readEmbedderBinding(o.path).model).toBe('local/tiny');
    await again.close();
  });
});

describe('reembedSqliteStore', () => {
  it('store.reembed-replaces-live-and-cold-vectors-and-binds', async () => {
    const o = opts();
    const store = await openSqliteStore(o);
    await store.upsert(TG, makeMemory({ id: 'a', text: 'alpha', embedding: vec(0, 0, 9, 0) }));
    await store.upsert(TG, makeMemory({ id: 'b', text: 'bravo two', embedding: vec(0, 0, 0, 9) }));
    await store.upsert(TG, makeMemory({ id: 'plain', text: 'no vector' }));
    await seedCold(
      store,
      makeMemory({ id: 'c', text: 'charlie cold', embedding: vec(0, 9, 9, 0) }),
    );
    const coldBefore = fs.readdirSync(o.coldDir).filter((f) => f.endsWith('.zst'));
    writeEmbedderBinding(o.path, 'voyage/voyage-3.5-lite');

    const progress: number[] = [];
    const r = await reembedSqliteStore({
      ...o,
      model: 'local/tiny',
      embed: embedNew,
      batchSize: 1,
      onProgress: (p) => progress.push(p.done),
    });
    expect(r).toEqual({ live: 2, cold: 1, withoutVector: 1 });
    expect(progress).toEqual([1, 2, 3]);
    expect(readEmbedderBinding(o.path).model).toBe('local/tiny');

    expect(Array.from((await store.get(TG, 'a'))!.embedding!)).toEqual([5, 1, 0, 0]);
    expect(Array.from((await store.get(TG, 'b'))!.embedding!)).toEqual([9, 1, 0, 0]);
    expect((await store.get(TG, 'plain'))!.embedding).toBeUndefined();
    // The cold copy carries the new vector (a new blob; the old one is gone).
    expect(Array.from((await store.coldGet(TG, 'c'))!.embedding!)).toEqual([12, 1, 0, 0]);
    const coldAfter = fs.readdirSync(o.coldDir).filter((f) => f.endsWith('.zst'));
    expect(coldAfter).toHaveLength(1);
    expect(coldAfter[0]).not.toBe(coldBefore[0]);
    // Dense search runs on the new vectors.
    const hits = await store.dense(TG, vec(9, 1, 0, 0), 2);
    expect(hits[0]!.id).toBe('b');
    await store.close();
  });

  it('store.reembed-failure-keeps-the-old-binding', async () => {
    const o = opts();
    const store = await openSqliteStore(o);
    await store.upsert(TG, makeMemory({ id: 'a', embedding: vec(1, 0, 0, 0) }));
    await store.upsert(TG, makeMemory({ id: 'b', embedding: vec(1, 0, 0, 0) }));
    writeEmbedderBinding(o.path, 'voyage/voyage-3.5-lite');
    let calls = 0;
    await expect(
      reembedSqliteStore({
        ...o,
        model: 'local/tiny',
        batchSize: 1,
        embed: async (t) => {
          if (++calls === 2) throw new Error('model crashed');
          return embedNew(t);
        },
      }),
    ).rejects.toThrow('model crashed');
    expect(readEmbedderBinding(o.path).model).toBe('voyage/voyage-3.5-lite');
    await expect(
      reembedSqliteStore({ ...o, model: 'local/tiny', embed: async (t) => t.map(() => vec(1, 2)) }),
    ).rejects.toThrow(/2 dimensions, store dimension is 4/);
    expect(readEmbedderBinding(o.path).model).toBe('voyage/voyage-3.5-lite');
    await store.close();
  });
});
