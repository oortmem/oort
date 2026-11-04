import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder, MemoryStore, Reranker, ScopeFilter } from './adapters.js';
import { resolveConfig } from './config.js';
import { ACKNOWLEDGMENTS, shouldRecall } from './gate.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { formatForInjection, recall, type RecallResult } from './recall.js';
import { informativeTokens, queryCoverage } from './relevance.js';
import { makeMemory, seedCold, vec } from './store-conformance.js';
import { TG } from './store-conformance.js';
import { localGrant } from './grant.js';

const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-recall-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const DAY = 86_400_000;

/** Vector chosen by substring lookup; everything else maps to an orthogonal default. */
function fakeEmbedder(table: [string, Int8Array][]): Embedder {
  return {
    dimension: 4,
    async embed(texts) {
      return texts.map((t) => table.find(([k]) => t.includes(k))?.[1] ?? vec(0, 0, 0, 100));
    },
  };
}

async function setup(memories: Memory[]): Promise<MemoryStore> {
  const store = createMemoryStore({ d: config.activation.d });
  for (const m of memories) await store.upsert(TG, m);
  return store;
}

describe('gate', () => {
  it('gate.skips-trivial', () => {
    expect(shouldRecall('/model')).toEqual({ recall: false, reason: 'slash-command' });
    expect(shouldRecall('ok')).toEqual({ recall: false, reason: 'too-short' });
    expect(shouldRecall('yes please')).toEqual({ recall: false, reason: 'too-short' });
    expect(shouldRecall('what port did we move auth to?')).toEqual({ recall: true, reason: 'ok' });
    expect(ACKNOWLEDGMENTS).toContain('lgtm');
  });
  it('gate.acknowledgment-list', () => {
    expect(shouldRecall('  sounds good!  ')).toEqual({ recall: false, reason: 'acknowledgment' });
    expect(shouldRecall('Go ahead and do it')).toEqual({ recall: true, reason: 'ok' });
  });
});

describe('recall', () => {
  it('recall.hybrid-finds-lexical-only-match', async () => {
    const store = await setup([
      makeMemory({
        id: 'ident',
        text: 'deploy uses flag ZX-4471 always',
        stub: 'ZX-4471',
        embedding: vec(0, 100, 0, 0),
      }),
      makeMemory({ id: 'other', text: 'unrelated note', embedding: vec(100, 0, 0, 0) }),
    ]);
    const embed = fakeEmbedder([['ZX-4471', vec(0, 0, 100, 0)]]);
    const r = await recall({ text: 'what is ZX-4471', scope: SCOPE }, { store, embed, config });
    expect(r.memories[0]?.id).toBe('ident');
    expect(r.memories[0]?.explanation.lexicalRank).toBe(1);
  });

  it('recall.hybrid-finds-dense-paraphrase', async () => {
    const store = await setup([
      makeMemory({ id: 'p', text: 'we shipped the login rewrite', embedding: vec(100, 0, 0, 0) }),
    ]);
    const embed = fakeEmbedder([['authentication', vec(100, 0, 0, 0)]]);
    const r = await recall(
      { text: 'authentication overhaul', scope: SCOPE },
      { store, embed, config },
    );
    expect(r.memories[0]?.id).toBe('p');
    expect(r.memories[0]?.explanation.denseRank).toBe(1);
    expect(r.memories[0]?.explanation.lexicalRank).toBeUndefined();
  });

  it('recall.hydrates-cold', async () => {
    const store = await setup([]);
    const cold = makeMemory({
      id: 'c',
      text: 'full text about quokka migration',
      stub: 'quokka migration',
      tier: 'warm',
      embedding: vec(1, 2, 3, 4),
      salience: 0.9,
    });
    await seedCold(store, cold);
    const r = await recall({ text: 'quokka', scope: SCOPE }, { store, config });
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]?.text).toBe('full text about quokka migration');
    expect(r.memories[0]?.explanation.hydrated).toBe(true);
    const live = await store.get(TG, 'c');
    expect(live?.tier).toBe('warm');
    expect(live?.embedding).toBeDefined();
  });

  it('recall.lost-cold-embedding-stays-cold-lexical-only', async () => {
    // Pins what spec §8 says about a lost cold blob: nothing re-derives the embedding yet.
    const store = await setup([]);
    await seedCold(
      store,
      makeMemory({ id: 'c', text: 'quokka migration notes', stub: 'quokka migration' }),
    );
    const lost: MemoryStore = { ...store, coldGet: async () => null };
    const r = await recall({ text: 'quokka', scope: SCOPE }, { store: lost, config });
    expect(r.memories.map((m) => m.id)).toEqual(['c']);
    expect(r.memories[0]?.explanation.hydrated).toBe(false);
    const live = await store.get(TG, 'c');
    expect(live?.tier).toBe('cold');
    expect(live?.embedding).toBeUndefined();
  });

  it('recall.scrubs-query-before-network', async () => {
    // Assembled at runtime so no full key literal appears in source.
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const seen: string[] = [];
    const guard = (texts: string[]): void => {
      for (const t of texts) {
        seen.push(t);
        if (/AKIA[0-9A-Z]{16}/.test(t)) throw new Error('secret reached adapter');
      }
    };
    const embed: Embedder = {
      dimension: 4,
      async embed(texts) {
        guard(texts);
        return texts.map(() => vec(100, 0, 0, 0));
      },
    };
    const rerank: Reranker = {
      async rerank(query, docs) {
        guard([query]);
        return docs.map((d, i) => ({ id: d.id, score: 1 - i * 0.1 }));
      },
    };
    const inner = await setup([
      makeMemory({ id: 'a', text: 'rotate the credential soon', embedding: vec(100, 0, 0, 0) }),
    ]);
    const lexicalQueries: string[] = [];
    const store: MemoryStore = Object.create(inner) as MemoryStore;
    store.lexical = (grant, q, k) => {
      lexicalQueries.push(q);
      return inner.lexical(grant, q, k);
    };
    const r = await recall(
      { text: `rotate the credential ${key}`, scope: SCOPE },
      { store, embed, rerank, config },
    );
    expect(r.degraded).toBeUndefined();
    expect(r.memories.map((m) => m.id)).toEqual(['a']);
    expect(seen).toHaveLength(2);
    expect(lexicalQueries).toHaveLength(1);
    for (const t of [...seen, ...lexicalQueries]) {
      expect(t).not.toContain(key);
      expect(t).toContain('[REDACTED:aws-access-key]');
    }
  });

  it('recall.degrades-without-embedder', async () => {
    const store = await setup([makeMemory({ id: 'a', text: 'port 8080 for auth' })]);
    const r = await recall({ text: 'auth port 8080', scope: SCOPE }, { store, config });
    expect(r.degraded).toContain('no-embedder');
    expect(r.degraded).toContain('no-reranker');
    expect(r.memories.map((m) => m.id)).toEqual(['a']);
  });

  it('recall.degrades-on-adapter-failure', async () => {
    const store = await setup([makeMemory({ id: 'a', text: 'port 8080 for auth' })]);
    const embed: Embedder = { dimension: 4, embed: () => Promise.reject(new Error('boom')) };
    const rerank: Reranker = { rerank: () => Promise.reject(new Error('boom')) };
    const r = await recall(
      { text: 'auth port 8080', scope: SCOPE },
      // Rerank and the embed are forced on: a clear lexical match would otherwise skip both.
      {
        store,
        embed,
        rerank,
        config: withRecall({ skipRerankWhenConfident: false, lexicalFirst: false }),
      },
    );
    expect(r.degraded).toEqual(['embed-failed', 'rerank-failed']);
    expect(r.memories.map((m) => m.id)).toEqual(['a']);
  });

  it('recall.degrades-on-dense-store-error', async () => {
    const embed = fakeEmbedder([['auth', vec(100, 0, 0, 0)]]);
    const store = await setup([
      makeMemory({ id: 'a', text: 'port 8080 for auth', embedding: vec(100, 0, 0, 0) }),
    ]);
    // A dense failure (SQLITE_BUSY, a dimension RangeError) leaves the lexical result.
    const busy: MemoryStore = {
      ...store,
      dense: () => Promise.reject(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })),
    };
    const r = await recall(
      { text: 'auth port 8080', scope: SCOPE },
      // The embed is forced on: lexical-first would skip it for this clear match.
      { store: busy, embed, config: withRecall({ lexicalFirst: false }) },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['a']);
    expect(r.degraded).toContain('dense-failed');
    expect(r.memories[0]?.explanation.denseRank).toBeUndefined();

    // A failing cold hydration returns the live (cold) row instead of rejecting.
    await seedCold(
      store,
      makeMemory({ id: 'c', text: 'quokka notes', stub: 'quokka', embedding: vec(1, 2, 3, 4) }),
    );
    for (const broken of [
      { ...store, coldGet: () => Promise.reject(new Error('EIO')) },
      { ...store, upsert: () => Promise.reject(new Error('SQLITE_BUSY')) },
    ] as MemoryStore[]) {
      const h = await recall({ text: 'quokka', scope: SCOPE }, { store: broken, config });
      expect(h.memories.map((m) => m.id)).toEqual(['c']);
      expect(h.memories[0]?.explanation.hydrated).toBe(false);
      expect(h.degraded).toContain('hydrate-failed');
    }
    expect((await store.get(TG, 'c'))?.tier).toBe('cold');

    // The lexical store is the floor: its failure still rejects.
    const noLexical: MemoryStore = { ...store, lexical: () => Promise.reject(new Error('fts')) };
    await expect(
      recall({ text: 'auth port 8080', scope: SCOPE }, { store: noLexical, embed, config }),
    ).rejects.toThrow('fts');
  });

  it('recall.empty-rerank-falls-back-to-fused', async () => {
    const store = await setup([
      makeMemory({ id: 'a', text: 'auth port 8080 is the default' }),
      makeMemory({ id: 'b', text: 'auth port moved' }),
    ]);
    const plain = await recall({ text: 'auth port 8080', scope: SCOPE }, { store, config });
    const rerank: Reranker = { rerank: async () => [] };
    const r = await recall(
      { text: 'auth port 8080', scope: SCOPE },
      { store, rerank, config: withRecall({ skipRerankWhenConfident: false }) },
    );
    expect(r.memories.map((m) => m.id)).toEqual(plain.memories.map((m) => m.id));
    expect(r.memories).toHaveLength(2);
    expect(r.degraded).toContain('rerank-empty');
    expect(r.memories[0]?.explanation.reranked).toBeUndefined();
  });

  it('recall.respects-asOf', async () => {
    const now = new Date();
    const old = makeMemory({
      id: 'old',
      text: 'auth port 3000',
      validFrom: new Date(now.getTime() - 20 * DAY).toISOString(),
      validTo: new Date(now.getTime() - 10 * DAY).toISOString(),
    });
    const cur = makeMemory({
      id: 'cur',
      text: 'auth port 8080',
      validFrom: new Date(now.getTime() - 10 * DAY).toISOString(),
    });
    const store = await setup([old, cur]);
    const nowRes = await recall({ text: 'auth port', scope: SCOPE }, { store, config, now });
    expect(nowRes.memories.map((m) => m.id)).toEqual(['cur']);
    const asOf = new Date(now.getTime() - 15 * DAY).toISOString();
    const past = await recall({ text: 'auth port', scope: SCOPE, asOf }, { store, config, now });
    expect(past.memories.map((m) => m.id)).toEqual(['old']);
  });

  it('recall.records-access', async () => {
    const store = await setup([
      makeMemory({ id: 'hit', text: 'auth port 8080' }),
      makeMemory({ id: 'miss', text: 'database schema' }),
    ]);
    await recall({ text: 'auth port', scope: SCOPE }, { store, config });
    expect((await store.get(TG, 'hit'))?.accessLog.count).toBe(1);
    expect((await store.get(TG, 'miss'))?.accessLog.count).toBe(0);
  });

  it('recall.reranker-reorders', async () => {
    const store = await setup([
      makeMemory({ id: 'a', text: 'auth port 8080' }),
      makeMemory({ id: 'b', text: 'auth port 9090' }),
    ]);
    const rerank: Reranker = {
      async rerank(_q, docs) {
        return [...docs].reverse().map((d, i) => ({ id: d.id, score: 1 - i * 0.1 }));
      },
    };
    const plain = await recall({ text: 'auth port', scope: SCOPE }, { store, config });
    const r = await recall({ text: 'auth port', scope: SCOPE }, { store, rerank, config });
    expect(r.memories.map((m) => m.id)).toEqual(plain.memories.map((m) => m.id).reverse());
    expect(r.memories[0]?.explanation.reranked).toBe(1);
    expect(r.degraded).not.toContain('rerank-failed');
  });

  it('recall.timings-present', async () => {
    const store = await setup([makeMemory({ id: 'a', text: 'auth port 8080' })]);
    const r = await recall({ text: 'auth port', scope: SCOPE }, { store, config });
    for (const k of [
      'gateMs',
      'embedMs',
      'lexicalMs',
      'denseMs',
      'hydrateMs',
      'fuseMs',
      'rerankMs',
      'totalMs',
    ]) {
      expect(typeof r.timings[k]).toBe('number');
    }
    expect(r.timings['gateMs']).toBe(0);
    expect(r.skipped).toBeUndefined();
  });
});

const withRecall = (over: Partial<typeof config.recall>) => ({
  ...config,
  recall: { ...config.recall, ...over },
});

/** A reranker that scores each document by a lookup on its id, counting calls. */
function scoredReranker(scores: Record<string, number>): Reranker & { calls: number } {
  const r = {
    calls: 0,
    async rerank(_q: string, docs: { id: string; text: string }[]) {
      r.calls++;
      return docs
        .map((d) => ({ id: d.id, score: scores[d.id] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    },
  };
  return r;
}

describe('relevance', () => {
  it('relevance.stopwords-and-question-words-do-not-count', () => {
    expect([...informativeTokens('which library does the queue runner use for auth?')]).toEqual([
      'library',
      'queue',
      'runner',
      'auth',
    ]);
    // Joined tokens also count by their parts.
    expect(informativeTokens('auth-service-8080')).toEqual(
      new Set(['auth-service-8080', 'auth', 'service', '8080']),
    );
  });

  it('relevance.coverage-is-the-share-of-query-words-a-memory-contains', () => {
    const m = makeMemory({ id: 'a', text: 'the queue runner validates input with zod' });
    expect(queryCoverage(informativeTokens('queue runner zod'), m)).toBe(1);
    expect(queryCoverage(informativeTokens('queue billing rollback zod'), m)).toBe(0.5);
    expect(queryCoverage(informativeTokens('the for which'), m)).toBe(0);
  });
});

describe('relevance gate (CON-45)', () => {
  it('gate.abstains-when-every-rerank-score-is-weak', async () => {
    const store = await setup([
      makeMemory({ id: 'a', text: 'auth port 8080' }),
      makeMemory({ id: 'b', text: 'auth port 9090' }),
    ]);
    const rerank = scoredReranker({ a: 0.05, b: 0.1 });
    const r = await recall({ text: 'auth port', scope: SCOPE }, { store, rerank, config });
    expect(r.memories).toEqual([]);
    expect(r.abstained).toBe(true);
    expect(r.gate).toEqual({ by: 'rerank', threshold: config.recall.minRerankScore, dropped: 2 });
  });

  it('gate.keeps-only-memories-above-the-rerank-threshold', async () => {
    const store = await setup([
      makeMemory({ id: 'a', text: 'auth port 8080' }),
      makeMemory({ id: 'b', text: 'auth port 9090' }),
    ]);
    const rerank = scoredReranker({ a: 0.9, b: 0.1 });
    const r = await recall({ text: 'auth port', scope: SCOPE }, { store, rerank, config });
    expect(r.memories.map((m) => m.id)).toEqual(['a']);
    expect(r.abstained).toBeUndefined();
    expect(r.gate?.dropped).toBe(1);
  });

  it('gate.without-a-reranker-uses-query-word-coverage', async () => {
    const store = await setup([
      makeMemory({ id: 'full', text: 'the billing worker retries webhooks three times' }),
      makeMemory({ id: 'weak', text: 'the search worker caches results' }),
    ]);
    const r = await recall(
      { text: 'billing worker webhooks retries', scope: SCOPE },
      { store, config },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['full']);
    expect(r.memories[0]?.explanation.coverage).toBe(1);
    expect(r.gate).toEqual({ by: 'coverage', threshold: config.recall.minCoverage, dropped: 1 });

    const none = await recall(
      { text: 'who approved the quarterly budget for the search gateway', scope: SCOPE },
      { store, config },
    );
    expect(none.memories).toEqual([]);
    expect(none.abstained).toBe(true);
  });

  it('gate.strong-dense-match-passes-without-shared-words', async () => {
    const store = await setup([
      makeMemory({ id: 'p', text: 'we shipped the login rewrite', embedding: vec(100, 0, 0, 0) }),
    ]);
    const embed = fakeEmbedder([['authentication', vec(100, 0, 0, 0)]]);
    const r = await recall(
      { text: 'authentication overhaul', scope: SCOPE },
      { store, embed, config },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['p']);
    expect(r.memories[0]?.explanation.coverage).toBe(0);
  });

  it('gate.zero-thresholds-switch-it-off', async () => {
    const store = await setup([makeMemory({ id: 'weak', text: 'the search worker caches' })]);
    const off = withRecall({ minCoverage: 0, minRerankScore: 0, minDenseScore: 0 });
    const r = await recall(
      { text: 'search budget approval policy', scope: SCOPE },
      { store, config: off },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['weak']);
    expect(r.gate).toBeUndefined();
  });
});

describe('conditional rerank (CON-57)', () => {
  const both = vec(100, 0, 0, 0);
  async function agreed(): Promise<{ store: MemoryStore; embed: Embedder }> {
    const store = await setup([
      makeMemory({ id: 'top', text: 'auth listens on port 8080', embedding: both }),
      makeMemory({ id: 'other', text: 'auth notes', embedding: vec(0, 100, 0, 0) }),
    ]);
    return { store, embed: fakeEmbedder([['8080', both]]) };
  }

  it('rerank.skipped-when-fusion-is-confident', async () => {
    const { store, embed } = await agreed();
    const rerank = scoredReranker({ top: 0.9, other: 0.9 });
    const r = await recall(
      { text: 'auth port 8080 listens', scope: SCOPE },
      { store, embed, rerank, config },
    );
    expect(rerank.calls).toBe(0);
    expect(r.rerankSkipped).toBe('confident');
    expect(r.memories[0]?.id).toBe('top');
    expect(r.memories[0]?.explanation.reranked).toBeUndefined();
  });

  it('rerank.runs-when-fusion-is-close', async () => {
    const v = vec(100, 0, 0, 0);
    const store = await setup([
      makeMemory({ id: 'a', text: 'auth port 8080 on staging', embedding: v }),
      makeMemory({ id: 'b', text: 'auth port 8080 on prod', embedding: vec(99, 5, 0, 0) }),
    ]);
    const embed = fakeEmbedder([['8080', v]]);
    const rerank = scoredReranker({ a: 0.4, b: 0.9 });
    const r = await recall(
      { text: 'auth port 8080', scope: SCOPE },
      { store, embed, rerank, config },
    );
    expect(rerank.calls).toBe(1);
    expect(r.rerankSkipped).toBeUndefined();
    expect(r.memories.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('rerank.always-runs-when-the-switch-is-off', async () => {
    const { store, embed } = await agreed();
    const rerank = scoredReranker({ top: 0.9 });
    await recall(
      { text: 'auth port 8080 listens', scope: SCOPE },
      { store, embed, rerank, config: withRecall({ skipRerankWhenConfident: false }) },
    );
    expect(rerank.calls).toBe(1);
  });

  it('recall.lexical-runs-while-the-query-embeds', async () => {
    const store = await setup([makeMemory({ id: 'a', text: 'auth port 8080' })]);
    let lexicalStarted = false;
    let lexicalBeforeEmbed = false;
    const spy: MemoryStore = {
      ...store,
      lexical: (...args) => {
        lexicalStarted = true;
        return store.lexical(...args);
      },
    };
    const embed: Embedder = {
      dimension: 4,
      async embed() {
        await new Promise((r) => setTimeout(r, 20));
        lexicalBeforeEmbed = lexicalStarted;
        return [vec(100, 0, 0, 0)];
      },
    };
    await recall(
      { text: 'auth port 8080', scope: SCOPE },
      { store: spy, embed, config: withRecall({ lexicalFirst: false }) },
    );
    expect(lexicalBeforeEmbed).toBe(true);
  });
});

describe('format', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const mk = (
    type: Memory['type'],
    text: string,
    daysAgo: number,
  ): RecallResult['memories'][number] => ({
    ...makeMemory({
      id: text,
      type,
      text,
      validFrom: new Date(now.getTime() - daysAgo * DAY).toISOString(),
    }),
    explanation: { fused: 0, rrf: 0, coverage: 0, activation: 0, hydrated: false },
  });

  it('format.empty', () => {
    expect(formatForInjection({ memories: [], timings: {} }, 6000, now)).toBe('');
  });

  it('format.ages', () => {
    const r: RecallResult = {
      memories: [
        mk('semantic', 'a', 0),
        mk('episodic', 'b', 1),
        mk('semantic', 'c', 3),
        mk('semantic', 'd', 14),
        mk('semantic', 'e', 65),
        mk('semantic', 'f', 800),
      ],
      timings: {},
    };
    expect(formatForInjection(r, 6000, now)).toBe(
      '<oort-memory>\n- [semantic, today] a\n- [episodic, yesterday] b\n- [semantic, 3d ago] c\n- [semantic, 2w ago] d\n- [semantic, 2mo ago] e\n- [semantic, 2y ago] f\n</oort-memory>',
    );
  });

  it('format.budget-cuts-whole-memories', () => {
    const r: RecallResult = {
      memories: [
        mk('semantic', 'first', 0),
        mk('semantic', 'x'.repeat(200), 0),
        mk('semantic', 'third', 0),
      ],
      timings: {},
    };
    const full = formatForInjection(r, 6000, now);
    const out = formatForInjection(r, 100, now);
    expect(full.length).toBeGreaterThan(100);
    expect(out).toBe('<oort-memory>\n- [semantic, today] first\n</oort-memory>');
    expect(out.length).toBeLessThanOrEqual(100);
    expect(formatForInjection(r, 10, now)).toBe('');
  });

  it('recall.injection-is-scrubbed', async () => {
    // Assembled at runtime so no full key literal appears in source.
    const key = 'AKIA' + 'QWERTYUIOPASDFGH';
    // Stored directly, as by an older build or another tool: the write path never saw it.
    const store = await setup([
      makeMemory({ id: 'leak', text: `deploy with key ${key} via the quokka pipeline` }),
    ]);
    const r = await recall({ text: 'quokka pipeline', scope: SCOPE }, { store, config });
    expect(r.memories.map((m) => m.id)).toEqual(['leak']);
    const out = formatForInjection(r, 6000);
    expect(out).not.toContain(key);
    expect(out).toContain('deploy with key [REDACTED:');
    expect(out).toContain('via the quokka pipeline');
  });
});

describe('recall latency (CON-57)', () => {
  const counting = (inner: Embedder): Embedder & { calls: number } => {
    const e = {
      calls: 0,
      dimension: inner.dimension,
      async embed(texts: string[], kind: 'query' | 'document') {
        e.calls++;
        return inner.embed(texts, kind);
      },
    };
    return e;
  };
  const twoMemories = (): Memory[] => [
    makeMemory({
      id: 'clear',
      text: 'the billing worker retries failed invoices nightly',
      embedding: vec(0, 100, 0, 0),
    }),
    makeMemory({
      id: 'weak',
      text: 'the billing page has a new logo',
      embedding: vec(100, 0, 0, 0),
    }),
  ];
  const withRecall = (over: Partial<typeof config.recall>) => ({
    ...config,
    recall: { ...config.recall, ...over },
  });

  it('latency.lexical-first-skips-the-embed-when-lexical-is-confident', async () => {
    const store = await setup(twoMemories());
    const embed = counting(fakeEmbedder([]));
    const r = await recall(
      { text: 'billing worker retries failed invoices', scope: SCOPE },
      { store, embed, config },
    );
    expect(embed.calls).toBe(0);
    expect(r.embedSkipped).toBe('lexical-confident');
    expect(r.memories[0]?.id).toBe('clear');
    expect(r.degraded ?? []).not.toContain('no-embedder');
  });

  it('latency.lexical-first-embeds-when-lexical-is-not-confident', async () => {
    const store = await setup(twoMemories());
    const embed = counting(fakeEmbedder([]));
    // "billing" matches both memories equally: no clear lexical winner.
    const r = await recall({ text: 'billing changes', scope: SCOPE }, { store, embed, config });
    expect(embed.calls).toBe(1);
    expect(r.embedSkipped).toBeUndefined();
  });

  it('latency.lexical-first-needs-two-informative-words', async () => {
    const store = await setup(twoMemories());
    const embed = counting(fakeEmbedder([]));
    await recall({ text: 'invoices', scope: SCOPE }, { store, embed, config });
    expect(embed.calls).toBe(1);
  });

  it('latency.lexical-first-can-be-switched-off', async () => {
    const store = await setup(twoMemories());
    const embed = counting(fakeEmbedder([]));
    const r = await recall(
      { text: 'billing worker retries failed invoices', scope: SCOPE },
      { store, embed, config: withRecall({ lexicalFirst: false }) },
    );
    expect(embed.calls).toBe(1);
    expect(r.embedSkipped).toBeUndefined();
  });

  it('latency.lexical-first-ignores-a-superseded-top-hit', async () => {
    const store = await setup([
      makeMemory({
        id: 'old',
        text: 'the billing worker retries failed invoices nightly',
        validTo: new Date(Date.now() - DAY).toISOString(),
        embedding: vec(0, 100, 0, 0),
      }),
    ]);
    const embed = counting(fakeEmbedder([]));
    await recall(
      { text: 'billing worker retries failed invoices', scope: SCOPE },
      { store, embed, config },
    );
    expect(embed.calls).toBe(1);
  });

  it('latency.rerank-past-its-budget-uses-the-fused-order', async () => {
    const store = await setup(twoMemories());
    const slow: Reranker = {
      rerank: (_q, docs) =>
        new Promise((res) =>
          setTimeout(() => res(docs.map((d, i) => ({ id: d.id, score: 0.9 - i / 10 }))), 300),
        ),
    };
    const r = await recall(
      { text: 'billing changes this week', scope: SCOPE },
      {
        store,
        embed: fakeEmbedder([]),
        rerank: slow,
        config: withRecall({ rerankBudgetMs: 40, skipRerankWhenConfident: false }),
      },
    );
    expect(r.degraded).toContain('rerank-timeout');
    expect(r.memories.every((m) => m.explanation.reranked === undefined)).toBe(true);
    expect(r.timings['rerankMs']).toBeLessThan(200);
  });

  it('latency.rerank-budget-zero-waits-for-the-reranker', async () => {
    const store = await setup(twoMemories());
    const slow: Reranker = {
      rerank: (_q, docs) =>
        new Promise((res) =>
          setTimeout(() => res(docs.map((d) => ({ id: d.id, score: 0.9 }))), 60),
        ),
    };
    const r = await recall(
      { text: 'billing changes this week', scope: SCOPE },
      {
        store,
        embed: fakeEmbedder([]),
        rerank: slow,
        config: withRecall({ rerankBudgetMs: 0, skipRerankWhenConfident: false }),
      },
    );
    expect(r.degraded ?? []).not.toContain('rerank-timeout');
    expect(r.memories[0]?.explanation.reranked).toBe(0.9);
  });
});

describe('recall modes (CON-34)', () => {
  const now = new Date('2026-11-04T10:00:00.000Z');
  const VOLATILE = { stage: 'gate', question: 'volatile', answer: 'yes', probability: 0.8 };
  const chain = (): Memory[] => [
    makeMemory({
      id: 'v1',
      text: 'auth service port 3000',
      validFrom: '2026-03-01T00:00:00.000Z',
      validTo: '2026-05-01T00:00:00.000Z',
      expiredAt: '2026-05-01T00:00:00.000Z',
      endReason: 'superseded',
      createdAt: '2026-03-01T00:00:00.000Z',
      supersededBy: 'v2',
    }),
    makeMemory({
      // Shares no words with the query: only the chain walk finds it.
      id: 'v2',
      text: 'moved to 4000 behind the gateway',
      validFrom: '2026-05-01T00:00:00.000Z',
      validTo: '2026-08-01T00:00:00.000Z',
      expiredAt: '2026-08-01T00:00:00.000Z',
      endReason: 'superseded',
      createdAt: '2026-05-01T00:00:00.000Z',
      supersedes: 'v1',
      supersededBy: 'v3',
    }),
    makeMemory({
      id: 'v3',
      text: 'auth service port 8080',
      validFrom: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      supersedes: 'v2',
    }),
  ];

  it('recall.mode-defaults-to-current-and-is-reported', async () => {
    const store = await setup(chain());
    const r = await recall({ text: 'auth service port', scope: SCOPE }, { store, config, now });
    expect(r.memories.map((m) => m.id)).toEqual(['v3']);
    expect(r.temporal).toEqual({ mode: 'current', inferred: true });
  });

  it('recall.a-dated-question-reads-as-of-that-day', async () => {
    const store = await setup(chain());
    const r = await recall(
      { text: 'which port did the auth service use on 2 April 2026', scope: SCOPE },
      { store, config, now },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['v1']);
    expect(r.temporal).toEqual({
      mode: 'as-of',
      asOf: '2026-04-02T23:59:59.999Z',
      inferred: true,
    });
  });

  it('recall.an-explicit-mode-wins-over-the-question', async () => {
    const store = await setup(chain());
    const r = await recall(
      { text: 'auth service port on 2 April 2026', scope: SCOPE, mode: 'current' },
      { store, config, now },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['v3']);
    expect(r.temporal).toEqual({ mode: 'current', inferred: false });
  });

  it('recall.history-walks-the-supersede-chain-oldest-first', async () => {
    const wrong = makeMemory({
      id: 'wrong',
      text: 'auth service port 9999',
      validFrom: '2026-03-01T00:00:00.000Z',
      expiredAt: '2026-03-02T00:00:00.000Z',
      endReason: 'corrected',
    });
    const store = await setup([...chain(), wrong]);
    const r = await recall(
      { text: 'auth service port', scope: SCOPE, mode: 'history' },
      { store, config, now },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['v1', 'v2', 'v3']);
    expect(r.memories[1]?.explanation.chain).toBe(true);
    expect(r.memories[0]?.explanation.chain).toBeUndefined();
    expect(r.temporal).toEqual({ mode: 'history', inferred: false });
  });

  it('recall.history-is-inferred-from-the-question', async () => {
    const store = await setup(chain());
    const r = await recall(
      { text: 'how has the auth service port changed over time', scope: SCOPE },
      { store, config, now },
    );
    expect(r.temporal?.mode).toBe('history');
    expect(r.memories.map((m) => m.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('recall.known-at-includes-what-was-later-corrected', async () => {
    const wrong = makeMemory({
      id: 'wrong',
      text: 'billing runs on stripe',
      validFrom: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiredAt: '2026-06-01T00:00:00.000Z',
      endReason: 'corrected',
      supersededBy: 'right',
    });
    const right = makeMemory({
      id: 'right',
      text: 'billing runs on paddle',
      validFrom: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
      supersedes: 'wrong',
    });
    const store = await setup([wrong, right]);
    const then = await recall(
      {
        text: 'billing runs on',
        scope: SCOPE,
        mode: 'known-at',
        knownAt: '2026-04-01T00:00:00.000Z',
      },
      { store, config, now },
    );
    expect(then.memories.map((m) => m.id)).toEqual(['wrong']);
    const asOf = await recall(
      { text: 'billing runs on', scope: SCOPE, asOf: '2026-04-01T00:00:00.000Z' },
      { store, config, now },
    );
    expect(asOf.memories.map((m) => m.id)).toEqual(['right']);
  });

  it('recall.flags-a-stale-volatile-memory', async () => {
    const old = new Date(now.getTime() - 60 * DAY).toISOString();
    const mk = (id: string, text: string, over: Partial<Memory>) => {
      const m = makeMemory({ id, text, validFrom: old, ...over });
      return over.source === undefined ? m : { ...m, source: { ...m.source, ...over.source } };
    };
    const store = await setup([
      mk('stale', 'release train status is blocked', {
        source: { harness: 't', decisions: [VOLATILE] },
      }),
      mk('fresh', 'release train owner is the platform team', {
        lastConfirmedAt: new Date(now.getTime() - 2 * DAY).toISOString(),
        source: { harness: 't', decisions: [VOLATILE] },
      }),
      mk('stable', 'release train uses semantic versioning', {}),
    ]);
    const r = await recall({ text: 'release train', scope: SCOPE }, { store, config, now });
    const stale = Object.fromEntries(r.memories.map((m) => [m.id, m.explanation.stale === true]));
    expect(stale).toEqual({ stale: true, fresh: false, stable: false });
    const block = formatForInjection(r, 6000, now);
    expect(block).toContain(
      'release train status is blocked (may be outdated; last confirmed 2mo ago)',
    );
    expect(block).not.toContain('platform team (may be outdated');
  });

  it('format.a-version-that-is-not-current-shows-its-interval', () => {
    const [v1] = chain();
    const r: RecallResult = {
      memories: [
        { ...v1!, explanation: { fused: 0, rrf: 0, coverage: 0, activation: 0, hydrated: false } },
      ],
      timings: {},
    };
    expect(formatForInjection(r, 6000, now)).toBe(
      '<oort-memory>\n- [semantic, 2026-03-01 to 2026-05-01] auth service port 3000\n</oort-memory>',
    );
  });
});
