import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryStore, Reranker, ScopeFilter } from './adapters.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { occurrencesOf } from './event-time.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { formatForInjection, recall, type RecallResult } from './recall.js';
import { makeMemory, TG } from './store-conformance.js';
import { TIME_BOOST, timeScore } from './time-channel.js';

/**
 * The time channel: a past time in the query ranks memories by when what they tell of happened,
 * as one more reciprocal-rank-fusion list. It never filters; only a question about a state then
 * reads as-of.
 */

const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-recall-time-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const withRecall = (r: Partial<ResolvedConfig['recall']>): ResolvedConfig => ({
  ...config,
  recall: { ...config.recall, ...r },
});
const NOW = new Date('2023-04-20T10:00:00.000Z');

/** A memory written at `at`, its event time read from its text as observe reads it. */
function said(id: string, text: string, at: string, extra: Partial<Memory> = {}): Memory {
  return makeMemory({
    id,
    text,
    stub: text.slice(0, 40),
    createdAt: at,
    validFrom: at,
    updatedAt: at,
    occurred: occurrencesOf(text, new Date(at)),
    ...extra,
  });
}

/** An in-memory store holding `ms`, counting its range reads. */
async function storeWith(ms: Memory[]): Promise<{ store: MemoryStore; reads: () => number }> {
  const inner = createMemoryStore({ d: config.activation.d });
  for (const m of ms) await inner.upsert(TG, m);
  let n = 0;
  const store = Object.create(inner) as MemoryStore & { occurredIn: MemoryStore['occurredIn'] };
  store.occurredIn = (...args) => {
    n++;
    return inner.occurredIn!(...args);
  };
  return { store, reads: () => n };
}

/** A recall result without its timings, which differ run to run. */
const stable = (r: RecallResult) => {
  const { timings: _t, ...rest } = r as RecallResult & { timings?: unknown };
  return rest;
};

// Said in early April about March: after the end of the range the question names.
const hike = said(
  'hike',
  'In March I went hiking at Mount Tam with Sam.',
  '2023-04-02T09:00:00.000Z',
);
// Said in January, before March: it cannot tell of March.
const boots = said('boots', 'My hiking boots are in the garage.', '2023-01-10T09:00:00.000Z');

describe('recall: the time channel', () => {
  it('time.a-memory-written-after-the-range-about-it-is-found', async () => {
    // As-of the end of March (the old read) hid it: it was written on 2 April.
    const { store, reads } = await storeWith([hike, boots]);
    const r = await recall(
      { text: 'Where did I go hiking in March?', scope: SCOPE },
      { store, config, now: NOW },
    );
    expect(r.temporal).toEqual({
      mode: 'current',
      inferred: true,
      range: {
        from: '2023-03-01T00:00:00.000Z',
        to: '2023-04-01T00:00:00.000Z',
        precision: 'month',
      },
      shape: 'range',
    });
    expect(r.memories[0]?.id).toBe('hike');
    expect(r.memories[0]?.explanation.timeRank).toBe(1);
    expect(r.memories[0]?.explanation.time).toBeGreaterThan(0.75);
    // One range read per node the grant reads.
    expect(reads()).toBeGreaterThan(0);
  });

  it('time.fused-as-one-more-rrf-list-never-a-filter', async () => {
    const { store } = await storeWith([hike, boots]);
    const r = await recall(
      { text: 'Where did I go hiking in March?', scope: SCOPE },
      { store, config: withRecall({ minCoverage: 0 }), now: NOW },
    );
    const byId = new Map(r.memories.map((m) => [m.id, m]));
    const h = byId.get('hike')!.explanation;
    expect(h.rrf).toBeCloseTo(1 / (60 + h.lexicalRank!) + 1 / (60 + h.timeRank!), 12);
    // Said before March: no place in the time list, and still returned on its words.
    const b = byId.get('boots')!.explanation;
    expect(b.timeRank).toBeUndefined();
    expect(b.rrf).toBeCloseTo(1 / (60 + b.lexicalRank!), 12);
  });

  it('time.a-query-without-a-time-is-unchanged', async () => {
    // Channel on or off, memories with or without event time: the same result, and no range read.
    const plain = (m: Memory): Memory => {
      const { occurred: _o, ...rest } = m;
      return rest;
    };
    const q = { text: 'where are my hiking boots?', scope: SCOPE };
    const a = await storeWith([hike, boots]);
    // A recall records access, so each run reads its own copy.
    const c = await storeWith([hike, boots]);
    const b = await storeWith([plain(hike), plain(boots)]);
    const on = await recall(q, { store: a.store, config, now: NOW });
    const off = await recall(q, {
      store: c.store,
      config: withRecall({ timeChannel: false }),
      now: NOW,
    });
    const without = await recall(q, { store: b.store, config, now: NOW });
    expect(on.temporal?.range).toBeUndefined();
    expect(stable(on)).toEqual(stable(off));
    expect(without.memories.map((m) => [m.id, m.explanation])).toEqual(
      on.memories.map((m) => [m.id, m.explanation]),
    );
    expect(formatForInjection(on, 4000, NOW)).toBe(formatForInjection(off, 4000, NOW));
    expect(a.reads() + b.reads() + c.reads()).toBe(0);
  });

  it('time.a-question-about-a-state-then-still-reads-as-of', async () => {
    const { store, reads } = await storeWith([hike]);
    const r = await recall(
      { text: 'Which trail did we use in March?', scope: SCOPE },
      { store, config, now: NOW },
    );
    expect(r.temporal).toMatchObject({
      mode: 'as-of',
      asOf: '2023-03-31T23:59:59.999Z',
      inferred: true,
      shape: 'state',
    });
    expect(r.memories).toEqual([]);
    expect(reads()).toBe(0);
  });

  it('time.an-explicit-mode-is-kept', async () => {
    const { store, reads } = await storeWith([hike, boots]);
    const r = await recall(
      {
        text: 'Where did I go hiking in March?',
        scope: SCOPE,
        mode: 'as-of',
        asOf: '2023-03-31T23:59:59.999Z',
      },
      { store, config: withRecall({ minCoverage: 0 }), now: NOW },
    );
    expect(r.temporal).toEqual({
      mode: 'as-of',
      asOf: '2023-03-31T23:59:59.999Z',
      inferred: false,
    });
    expect(r.memories.map((m) => m.id)).toEqual(['boots']);
    expect(reads()).toBe(0);
  });

  it('time.the-range-read-brings-in-what-the-searches-missed', async () => {
    // No word of the query in it: only its time finds it, and the reranker judges it.
    const reyes = said(
      'reyes',
      'On Saturday we drove out to Point Reyes.',
      '2023-03-13T09:00:00.000Z',
    );
    const { store } = await storeWith([reyes, boots]);
    const rerank: Reranker = {
      async rerank(_q, docs) {
        return docs.map((d) => ({ id: d.id, score: d.id === 'reyes' ? 0.9 : 0.1 }));
      },
    };
    const r = await recall(
      { text: 'What did I do in March?', scope: SCOPE },
      { store, rerank, config, now: NOW },
    );
    expect(r.memories.map((m) => m.id)).toEqual(['reyes']);
    expect(r.memories[0]?.explanation.lexicalRank).toBeUndefined();
    expect(r.memories[0]?.explanation.timeRank).toBe(1);
  });

  it('time.after-a-rerank-a-bounded-boost-reorders-and-the-gate-reads-raw-scores', async () => {
    const inRange = said('in', 'In March I went hiking at Mount Tam.', '2023-04-02T09:00:00.000Z');
    const weak = said('weak', 'In March I went hiking near the lake.', '2023-04-03T09:00:00.000Z');
    const out = said('out', 'I went hiking at Mount Tam.', '2023-01-10T09:00:00.000Z');
    const { store } = await storeWith([inRange, weak, out]);
    const scores: Record<string, number> = { in: 0.49, out: 0.5, weak: 0.3 };
    let asked = -1;
    let given = -1;
    const rerank: Reranker = {
      async rerank(_q, docs, topK) {
        asked = topK;
        given = docs.length;
        return docs
          .map((d) => ({ id: d.id, score: scores[d.id] ?? 0 }))
          .sort((x, y) => y.score - x.score);
      },
    };
    const cfg = withRecall({ skipRerankWhenConfident: false, minRerankScore: 0.35 });
    const r = await recall(
      { text: 'Where did I go hiking in March?', scope: SCOPE },
      { store, rerank, config: cfg, now: NOW },
    );
    // Every score comes back, so the boost can reorder any of them.
    expect(asked).toBe(given);
    // 0.49 in the range overtakes 0.50 said before it; the boost is at most TIME_BOOST.
    expect(timeScore(inRange, r.temporal!.range!)).toBeGreaterThan(0.75);
    expect(r.memories.map((m) => [m.id, m.explanation.reranked])).toEqual([
      ['in', 0.49],
      ['out', 0.5],
    ]);
    // 0.30 cannot reach 0.35 with a boost of at most 10%: the gate keeps the raw score.
    expect(0.3 * (1 + TIME_BOOST)).toBeLessThan(0.35);
  });

  it('time.the-label-says-when-it-happened', async () => {
    const { store } = await storeWith([hike]);
    const r = await recall(
      { text: 'Where did I go hiking in March?', scope: SCOPE },
      { store, config, now: NOW },
    );
    expect(formatForInjection(r, 4000, NOW)).toContain('happened 2023-03]');
    // A memory with only the day it was said gets no such words.
    const { store: s2 } = await storeWith([boots]);
    const r2 = await recall(
      { text: 'hiking boots', scope: SCOPE },
      { store: s2, config, now: NOW },
    );
    expect(formatForInjection(r2, 4000, NOW)).not.toContain('happened');
  });

  it('time.a-failed-range-read-degrades-and-recall-goes-on', async () => {
    const { store } = await storeWith([hike]);
    (store as { occurredIn: MemoryStore['occurredIn'] }).occurredIn = () =>
      Promise.reject(new Error('boom'));
    const r = await recall(
      { text: 'Where did I go hiking in March?', scope: SCOPE },
      { store, config, now: NOW },
    );
    expect(r.degraded).toContain('time-failed');
    // The lexical search found it; the channel still ranks it.
    expect(r.memories[0]?.id).toBe('hike');
    expect(r.memories[0]?.explanation.timeRank).toBe(1);
  });

  it('time.a-store-without-the-range-read-ranks-what-the-searches-found', async () => {
    const inner = createMemoryStore({ d: config.activation.d });
    await inner.upsertMany(TG, [hike, boots]);
    // A store that keeps no event time: memories come back without `occurred`.
    const store = Object.create(inner) as MemoryStore;
    Object.defineProperty(store, 'occurrences', { value: undefined });
    Object.defineProperty(store, 'occurredIn', { value: undefined });
    store.get = async (g, id) => {
      const m = await inner.get(g, id);
      if (m === null) return m;
      const { occurred: _o, ...rest } = m;
      return rest;
    };
    const r = await recall(
      { text: 'Where did I go hiking in March?', scope: SCOPE },
      { store, config, now: NOW },
    );
    expect(r.degraded ?? []).not.toContain('time-failed');
    // When it was said (2 April, just after March) still ranks it; January's cannot be.
    expect(r.memories[0]?.id).toBe('hike');
    expect(r.memories[0]?.explanation.timeRank).toBe(1);
    expect(r.memories.find((m) => m.id === 'boots')?.explanation.timeRank).toBeUndefined();
  });
});

describe('timeScore', () => {
  const march = {
    from: '2023-03-01T00:00:00.000Z',
    to: '2023-04-01T00:00:00.000Z',
    precision: 'month' as const,
  };
  const bare = (at: string): Memory =>
    makeMemory({ id: at, text: 'x', createdAt: at, validFrom: at, updatedAt: at });

  it('score.a-stated-time-in-the-range-beats-a-mention', () => {
    expect(timeScore(hike, march)).toBeGreaterThan(0.75);
    expect(timeScore(bare('2023-03-15T00:00:00.000Z'), march)).toBeCloseTo(0.4, 6);
  });

  it('score.said-before-the-range-is-zero-said-after-decays', () => {
    expect(timeScore(bare('2023-02-10T00:00:00.000Z'), march)).toBe(0);
    const soon = timeScore(bare('2023-04-05T00:00:00.000Z'), march);
    const later = timeScore(bare('2023-06-10T00:00:00.000Z'), march);
    expect(soon).toBeLessThan(0.4);
    expect(later).toBeLessThan(soon);
    expect(later).toBeGreaterThan(0);
  });

  it('score.a-stated-time-outside-the-range-falls-back-to-when-it-was-said', () => {
    const wedding = said('w', 'We got married on March 4, 2021.', '2023-03-20T00:00:00.000Z');
    // March 2021 is not March 2023: only the mention, inside the range, counts.
    expect(timeScore(wedding, march)).toBeCloseTo(0.4, 6);
  });
});
