import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder, MemoryStore, Reranker, ScopeFilter } from './adapters.js';
import { OortConfig, resolveConfig, type ResolvedConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { recall } from './recall.js';
import { makeMemory, TG, vec } from './store-conformance.js';

// CON-131: in `rerankWhen: 'gate-miss'`, recall reranks only when the relevance gate would
// drop every candidate and the best dense match is still plausible. A question asked in one
// language about a memory written in another shares no words with it, so the coverage gate
// drops it, and its dense score sits below `minDenseScore`: this is the case it rescues.

const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-gate-miss-'));
const base = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const withRecall = (r: Partial<ResolvedConfig['recall']>): ResolvedConfig => ({
  ...base,
  recall: { ...base.recall, ...r },
});
const GATE_MISS = withRecall({
  rerankWhen: 'gate-miss',
  gateMissDenseFloor: 0.4,
  gateMissRerankFloor: 0.5,
  lexicalFirst: false,
});

const QUERY = 'which port does the billing service listen on';
// cos(QUERY, SPANISH) = 0.5: under minDenseScore (0.6), over the test's dense floor (0.4).
const Q = vec(100, 0, 0, 0);
const SPANISH = makeMemory({
  id: 'es',
  text: 'el servicio de cobros escucha en el puerto 7070',
  embedding: vec(50, 87, 0, 0),
});
// cos(QUERY, FAR) = 0.2: under the dense floor too.
const FAR = makeMemory({
  id: 'far',
  text: 'la reunión semanal es los jueves',
  embedding: vec(20, 98, 0, 0),
});

function embedder(): Embedder {
  return { dimension: 4, embed: async (texts) => texts.map(() => Q) };
}

function reranker(
  scores: Record<string, number>,
  fail?: 'throw' | 'hang',
): Reranker & { calls: number; docs: string[][] } {
  const r = {
    calls: 0,
    docs: [] as string[][],
    async rerank(_q: string, docs: { id: string; text: string }[]) {
      r.calls++;
      r.docs.push(docs.map((d) => d.id));
      if (fail === 'throw') throw new Error('vendor down');
      if (fail === 'hang') return new Promise<never>(() => {});
      return docs
        .map((d) => ({ id: d.id, score: scores[d.id] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    },
  };
  return r;
}

async function storeOf(memories: Memory[]): Promise<MemoryStore> {
  const store = createMemoryStore({ d: base.activation.d });
  for (const m of memories) await store.upsert(TG, m);
  return store;
}

describe('gate-miss rerank (CON-131)', () => {
  it('config: off by default, with the floors in the recall section', () => {
    const r = OortConfig.parse({}).recall;
    expect(r.rerankWhen).toBe('always');
    expect(r.promptGateMissRerank).toBe(false);
    expect(r.gateMissDenseFloor).toBeGreaterThan(0);
    expect(r.gateMissDenseFloor).toBeLessThan(r.minDenseScore);
    expect(r.gateMissRerankFloor).toBeGreaterThan(r.minRerankScore);
    expect(() => OortConfig.parse({ recall: { rerankWhen: 'sometimes' } })).toThrow();
  });

  it('a gate miss with a plausible dense match is reranked and gated on the rerank floor', async () => {
    const store = await storeOf([SPANISH, FAR]);
    const rerank = reranker({ es: 0.8, far: 0.1 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: GATE_MISS },
    );
    expect(rerank.calls).toBe(1);
    expect(r.memories.map((m) => m.id)).toEqual(['es']);
    expect(r.memories[0]?.explanation.reranked).toBe(0.8);
    expect(r.gateMiss).toEqual({ reranked: true, topDense: expect.closeTo(0.5, 2), kept: 1 });
    expect(r.gate).toEqual({ by: 'rerank', threshold: 0.5, dropped: 1 });
    expect(r.abstained).toBeUndefined();
    expect(r.timings['rerankMs']).toBeGreaterThanOrEqual(0);
  });

  it('the rerank floor, not minRerankScore, decides an escalated recall', async () => {
    const store = await storeOf([SPANISH]);
    // 0.4 passes minRerankScore (0.35) but not the gate-miss floor (0.5).
    const rerank = reranker({ es: 0.4 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: GATE_MISS },
    );
    expect(rerank.calls).toBe(1);
    expect(r.memories).toEqual([]);
    expect(r.abstained).toBe(true);
    expect(r.gateMiss).toEqual({ reranked: true, topDense: expect.closeTo(0.5, 2), kept: 0 });
    expect(r.gate).toEqual({ by: 'rerank', threshold: 0.5, dropped: 1 });
  });

  it('a gate miss under the dense floor abstains without calling the reranker', async () => {
    const store = await storeOf([FAR]);
    const rerank = reranker({ far: 0.9 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: GATE_MISS },
    );
    expect(rerank.calls).toBe(0);
    expect(r.memories).toEqual([]);
    expect(r.abstained).toBe(true);
    expect(r.gateMiss).toEqual({ reranked: false, topDense: expect.closeTo(0.2, 1), kept: 0 });
    expect(r.gate?.by).toBe('coverage');
  });

  it('a recall the gate already answers never calls the reranker', async () => {
    const store = await storeOf([
      makeMemory({
        id: 'en',
        text: 'the billing service listens on port 7070',
        embedding: vec(50, 87, 0, 0),
      }),
      SPANISH,
    ]);
    const rerank = reranker({ en: 0.9, es: 0.9 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: GATE_MISS },
    );
    expect(rerank.calls).toBe(0);
    expect(r.memories.map((m) => m.id)).toEqual(['en']);
    expect(r.memories[0]?.explanation.reranked).toBeUndefined();
    expect(r.gateMiss).toBeUndefined();
    expect(r.rerankSkipped).toBeUndefined();
    // The reranker was there: its absence is not a degradation.
    expect(r.degraded ?? []).not.toContain('no-reranker');
  });

  it('the same miss is reranked as before in the default mode', async () => {
    const store = await storeOf([SPANISH]);
    const rerank = reranker({ es: 0.4 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: withRecall({ lexicalFirst: false }) },
    );
    expect(rerank.calls).toBe(1);
    // minRerankScore (0.35) decides, as it always has.
    expect(r.memories.map((m) => m.id)).toEqual(['es']);
    expect(r.gateMiss).toBeUndefined();
  });

  it('without a reranker a gate miss abstains, as before', async () => {
    const store = await storeOf([SPANISH]);
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), config: GATE_MISS },
    );
    expect(r.abstained).toBe(true);
    expect(r.degraded).toContain('no-reranker');
    expect(r.gateMiss).toBeUndefined();
  });

  it('without a dense match nothing is plausible: no rerank call', async () => {
    const store = await storeOf([SPANISH]);
    const rerank = reranker({ es: 0.9 });
    // No embedder: lexical candidates only, none with a dense score.
    const r = await recall(
      { text: 'servicio puerto reunión semanal jueves cobros', scope: SCOPE },
      { store, rerank, config: withRecall({ ...GATE_MISS.recall, minCoverage: 0.9 }) },
    );
    expect(rerank.calls).toBe(0);
    expect(r.abstained).toBe(true);
    expect(r.gateMiss).toEqual({ reranked: false, kept: 0 });
  });

  it('a failed rerank keeps the abstention and says why', async () => {
    const store = await storeOf([SPANISH]);
    const rerank = reranker({}, 'throw');
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: GATE_MISS },
    );
    expect(rerank.calls).toBe(1);
    expect(r.memories).toEqual([]);
    expect(r.abstained).toBe(true);
    expect(r.degraded).toContain('rerank-failed');
    // Asked, but no answer: `reranked` means asked and answered.
    expect(r.gateMiss).toEqual({
      reranked: false,
      failed: true,
      topDense: expect.closeTo(0.5, 2),
      kept: 0,
    });
  });

  it('the escalation keeps to the rerank budget', async () => {
    const store = await storeOf([SPANISH]);
    const rerank = reranker({}, 'hang');
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      {
        store,
        embed: embedder(),
        rerank,
        config: withRecall({ ...GATE_MISS.recall, rerankBudgetMs: 20 }),
      },
    );
    expect(r.abstained).toBe(true);
    expect(r.degraded).toContain('rerank-timeout');
    expect(r.gateMiss).toMatchObject({ reranked: false, failed: true });
  });

  it('a superseded memory close to the query does not make a miss plausible', async () => {
    // The old version scores 0.98 dense but can never be returned; the current one scores 0.2.
    const old = makeMemory({
      id: 'old',
      text: 'el servicio de cobros escuchaba en el puerto 6060',
      embedding: vec(98, 20, 0, 0),
      validTo: '2026-02-01T00:00:00.000Z',
      supersededBy: 'far',
    });
    const store = await storeOf([old, FAR]);
    const rerank = reranker({ far: 0.9, old: 0.9 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      { store, embed: embedder(), rerank, config: GATE_MISS },
    );
    expect(rerank.calls).toBe(0);
    expect(r.gateMiss).toEqual({ reranked: false, topDense: expect.closeTo(0.2, 1), kept: 0 });
  });

  it('reranks the fused candidates, up to rerankK', async () => {
    // Dense scores from about 0.55 (m0) down to 0.47 (m5): all plausible, none past the gate.
    const many = Array.from({ length: 6 }, (_, i) =>
      makeMemory({
        id: `m${i}`,
        text: `nota ${i} sobre cobros`,
        embedding: vec(55 - 2 * i, 83, 0, 0),
      }),
    );
    const store = await storeOf(many);
    const rerank = reranker({ m2: 0.9, m5: 0.95 });
    const r = await recall(
      { text: QUERY, scope: SCOPE },
      {
        store,
        embed: embedder(),
        rerank,
        config: withRecall({ ...GATE_MISS.recall, rerankK: 4, returnK: 2 }),
      },
    );
    expect(rerank.docs[0]).toEqual(['m0', 'm1', 'm2', 'm3']);
    // m5 would score higher, but it was never a candidate.
    expect(r.memories.map((m) => m.id)).toEqual(['m2']);
  });
});
