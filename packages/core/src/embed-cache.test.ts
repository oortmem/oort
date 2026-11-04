import { describe, expect, it } from 'vitest';
import type { Embedder } from './adapters.js';
import { cachingEmbedder, memoryEmbeddingCache, queryCacheKey } from './embed-cache.js';

function counting(): Embedder & { calls: string[][] } {
  const e = {
    calls: [] as string[][],
    dimension: 4,
    async embed(texts: string[]) {
      e.calls.push(texts);
      return texts.map((t) => Int8Array.from([t.length, 1, 2, 3]));
    },
  };
  return e;
}

describe('query embedding cache', () => {
  it('cache.key-normalises-case-and-whitespace-and-includes-model-and-dimension', async () => {
    const a = await queryCacheKey('voyage-3.5-lite', 512, '  Which  PORT does auth use? ');
    const b = await queryCacheKey('voyage-3.5-lite', 512, 'which port does auth use?');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await queryCacheKey('voyage-3.5', 512, 'which port does auth use?')).not.toBe(a);
    expect(await queryCacheKey('voyage-3.5-lite', 1024, 'which port does auth use?')).not.toBe(a);
  });

  it('cache.second-identical-query-skips-the-embedder', async () => {
    const inner = counting();
    const e = cachingEmbedder(inner, memoryEmbeddingCache(), { model: 'm', dimension: 4 });
    const first = await e.embed(['Where is the deploy key?'], 'query');
    const second = await e.embed(['where is the   deploy key?'], 'query');
    expect(inner.calls).toHaveLength(1);
    expect([...(second[0] ?? [])]).toEqual([...(first[0] ?? [])]);
  });

  it('cache.documents-and-batches-are-never-cached', async () => {
    const inner = counting();
    const e = cachingEmbedder(inner, memoryEmbeddingCache(), { model: 'm', dimension: 4 });
    await e.embed(['a fact'], 'document');
    await e.embed(['a fact'], 'document');
    await e.embed(['q1', 'q2'], 'query');
    await e.embed(['q1', 'q2'], 'query');
    expect(inner.calls).toHaveLength(4);
  });

  it('cache.entries-expire-after-the-ttl', async () => {
    let now = 0;
    const inner = counting();
    const cache = memoryEmbeddingCache({ ttlMs: 1000, now: () => now });
    const e = cachingEmbedder(inner, cache, { model: 'm', dimension: 4 });
    await e.embed(['same question here'], 'query');
    now = 999;
    await e.embed(['same question here'], 'query');
    expect(inner.calls).toHaveLength(1);
    now = 1001;
    await e.embed(['same question here'], 'query');
    expect(inner.calls).toHaveLength(2);
  });

  it('cache.lru-evicts-the-oldest-entry-past-max', async () => {
    const inner = counting();
    const e = cachingEmbedder(inner, memoryEmbeddingCache({ max: 2 }), {
      model: 'm',
      dimension: 4,
    });
    await e.embed(['one'], 'query');
    await e.embed(['two'], 'query');
    await e.embed(['three'], 'query');
    await e.embed(['one'], 'query');
    expect(inner.calls.map((c) => c[0])).toEqual(['one', 'two', 'three', 'one']);
  });

  it('cache.a-failing-cache-never-breaks-embedding', async () => {
    const inner = counting();
    const broken = {
      get: async () => {
        throw new Error('disk gone');
      },
      set: async () => {
        throw new Error('disk gone');
      },
    };
    const e = cachingEmbedder(inner, broken, { model: 'm', dimension: 4 });
    const out = await e.embed(['still works'], 'query');
    expect(out).toHaveLength(1);
    expect(inner.calls).toHaveLength(1);
  });

  it('cache.returns-a-copy-so-callers-cannot-mutate-the-cached-vector', async () => {
    const e = cachingEmbedder(counting(), memoryEmbeddingCache(), { model: 'm', dimension: 4 });
    const a = (await e.embed(['mutate me'], 'query'))[0]!;
    a[0] = 99;
    const b = (await e.embed(['mutate me'], 'query'))[0]!;
    expect(b[0]).not.toBe(99);
  });
});
