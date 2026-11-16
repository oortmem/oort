import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder, MemoryStore, Reranker, ScopeFilter } from './adapters.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { isEnumeration } from './enumeration.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { recall, type RecallResult } from './recall.js';
import { makeMemory, TG, vec } from './store-conformance.js';
import { subQueries } from './subqueries.js';

/**
 * A question that gathers many things spreads its top k across source sessions; every other
 * query is ranked exactly as before.
 */

const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-recall-enum-'));
const base = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const withRecall = (r: Partial<ResolvedConfig['recall']>): ResolvedConfig => ({
  ...base,
  recall: { ...base.recall, ...r },
});
const NOW = new Date('2026-06-01T12:00:00Z');
const WRITTEN = '2026-05-01T09:00:00.000Z';
/** A memory written at one fixed time, so every run ranks alike. */
const memory = (m: Partial<Memory> & { id: string }): Memory =>
  makeMemory({ validFrom: WRITTEN, createdAt: WRITTEN, updatedAt: WRITTEN, ...m });

const QUESTION = 'How many charity events did I participate in?';
/** About the same memories, but one thing: no spread. */
const PLAIN = 'Where did I hold the charity events planning call?';

const Q = vec(100, 0, 0, 0);

function embedder(): Embedder {
  return {
    dimension: 4,
    async embed(texts) {
      return texts.map((t) => (/charity/i.test(t) ? Q : vec(0, 0, 0, 100)));
    },
  };
}

const at = (session: string | undefined) => ({
  harness: 'test',
  ...(session !== undefined && { sessionId: session }),
  decisions: [],
});

/**
 * One long session that talks about charity events at length (`a1` to `a4`), and sessions that
 * each hold one event (`b1`, `c1`). `e1` shares one word with the question and nothing more.
 */
function memories(): Memory[] {
  const crowd = (n: number) =>
    memory({
      id: `a${n}`,
      text: `Planning call ${n}: charity events I participate in, charity events calendar, charity events budget, planning call notes.`,
      embedding: vec(100, n, 0, 0),
      source: at('session-a'),
    });
  return [
    crowd(1),
    crowd(2),
    crowd(3),
    crowd(4),
    memory({
      id: 'b1',
      text: 'Ran the hospital 5k, one of the charity events I participate in.',
      embedding: vec(80, 40, 0, 0),
      source: at('session-b'),
    }),
    memory({
      id: 'c1',
      text: 'Volunteered at the food bank gala, a charity event.',
      embedding: vec(70, 50, 0, 0),
      source: at('session-c'),
    }),
    memory({ id: 'other', text: 'Watered the herb garden.', embedding: vec(0, 0, 0, 100) }),
  ];
}

const GATED = memory({
  id: 'e1',
  text: 'Bought a sweater at the charity shop.',
  embedding: vec(20, 0, 100, 0),
  source: at('session-e'),
});

async function setup(ms: Memory[]): Promise<MemoryStore> {
  const store = createMemoryStore({ d: base.activation.d });
  for (const m of ms) await store.upsert(TG, m);
  return store;
}

function reranker(scores: Record<string, number>): Reranker & { topK: number[] } {
  const r = {
    topK: [] as number[],
    async rerank(_q: string, docs: { id: string }[], topK: number) {
      r.topK.push(topK);
      return docs
        .map((d) => ({ id: d.id, score: scores[d.id] ?? 0.01 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
  return r;
}
const RERANK = { a1: 0.9, a2: 0.88, a3: 0.86, a4: 0.84, b1: 0.6, c1: 0.55, e1: 0.1 };

const ids = (r: RecallResult) => r.memories.map((m) => m.id);
const sessionA = (r: RecallResult) =>
  r.memories.filter((m) => m.source.sessionId === 'session-a').length;

/** A fresh store per run: a recall records access, which would change the next run's scores. */
async function run(
  text: string,
  config: ResolvedConfig,
  opts: { ms?: Memory[]; rerank?: Reranker } = {},
): Promise<RecallResult> {
  const store = await setup(opts.ms ?? memories());
  return recall(
    { text, scope: SCOPE },
    {
      store,
      embed: embedder(),
      ...(opts.rerank !== undefined && { rerank: opts.rerank }),
      config,
      now: NOW,
    },
  );
}

describe('recall spreads an enumeration question across sources', () => {
  it('enumeration.the-question-is-one', () => {
    expect(isEnumeration(QUESTION)).toBe(true);
    expect(isEnumeration(PLAIN)).toBe(false);
  });

  it('enumeration.fast-one-session-fills-the-top-k-without-the-spread', async () => {
    const r = await run(QUESTION, withRecall({ returnK: 4, enumerationPerSource: 0 }));
    expect(ids(r)).toHaveLength(4);
    expect(sessionA(r)).toBe(4);
  });

  it('enumeration.fast-spreads-across-sessions', async () => {
    const off = await run(QUESTION, withRecall({ returnK: 4, enumerationPerSource: 0 }));
    const r = await run(QUESTION, withRecall({ returnK: 4 }));
    expect(sessionA(r)).toBe(2);
    // The best two of the long session keep their places; the next go to other sessions.
    expect(ids(r).slice(0, 2)).toEqual(ids(off).slice(0, 2));
    expect(ids(r).slice(2)).toEqual(['b1', 'c1']);
    expect(r.degraded).toEqual(['no-reranker']);
  });

  it('enumeration.full-spreads-across-sessions-and-asks-for-every-score', async () => {
    const offRerank = reranker(RERANK);
    const off = await run(QUESTION, withRecall({ returnK: 4, enumerationPerSource: 0 }), {
      ms: [...memories(), GATED],
      rerank: offRerank,
    });
    expect(ids(off)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(offRerank.topK).toEqual([4]);

    const rr = reranker(RERANK);
    const r = await run(QUESTION, withRecall({ returnK: 4 }), {
      ms: [...memories(), GATED],
      rerank: rr,
    });
    expect(ids(r)).toEqual(['a1', 'a2', 'b1', 'c1']);
    expect(rr.topK[0]).toBeGreaterThan(4);
    expect(r.memories.map((m) => m.explanation.reranked)).toEqual([0.9, 0.88, 0.6, 0.55]);
  });

  it('enumeration.fills-from-skipped-memories-when-sources-are-few', async () => {
    const ms = memories().filter((m) => m.id !== 'c1');
    const r = await run(QUESTION, withRecall({ returnK: 6 }), { ms });
    // Two sessions for six places: the long session's other memories fill the places left.
    expect(ids(r)).toHaveLength(5);
    expect(new Set(ids(r))).toEqual(new Set(['a1', 'a2', 'a3', 'a4', 'b1']));
    expect(ids(r)[2]).toBe('b1');
  });

  it('enumeration.never-admits-a-memory-the-gate-dropped', async () => {
    const ms = [...memories().filter((m) => m.id !== 'c1'), GATED];
    // Gate on: the one memory from a new session fails it, and the places go to the long session.
    const r = await run(QUESTION, withRecall({ returnK: 5 }), { ms });
    expect(ids(r)).not.toContain('e1');
    expect(ids(r)).toHaveLength(5);
    expect(sessionA(r)).toBe(4);
    expect(r.gate?.dropped).toBeGreaterThanOrEqual(1);
    // Gate off: the same memory is a new source, and the spread takes it.
    const open = await run(
      QUESTION,
      withRecall({ returnK: 5, minCoverage: 0, minDenseScore: 0, minRerankScore: 0 }),
      { ms },
    );
    expect(ids(open)).toContain('e1');
    // With a reranker: its score is below the threshold, so it never comes back.
    const full = await run(QUESTION, withRecall({ returnK: 5 }), {
      ms,
      rerank: reranker(RERANK),
    });
    expect(ids(full)).not.toContain('e1');
    expect(ids(full)).toEqual(['a1', 'a2', 'b1', 'a3', 'a4']);
  });

  it('enumeration.a-memory-without-a-session-is-its-own-source', async () => {
    const ms = memories().map((m) =>
      m.id.startsWith('a') ? { ...m, source: { harness: 'test', decisions: [] } } : m,
    );
    const r = await run(QUESTION, withRecall({ returnK: 4 }), { ms });
    // No session: nothing to spread, the order is as without the spread.
    const off = await run(QUESTION, withRecall({ returnK: 4, enumerationPerSource: 0 }), { ms });
    expect(ids(r)).toEqual(ids(off));
  });
});

describe('any other query is unchanged', () => {
  /** Everything but the timings, which differ run to run. */
  const same = (r: RecallResult) => {
    const { timings: _, ...rest } = r;
    return JSON.parse(JSON.stringify(rest)) as unknown;
  };

  it('enumeration.plain-query-same-ids-order-and-scores-fast', async () => {
    const ms = [...memories(), GATED];
    const on = await run(PLAIN, withRecall({ returnK: 4 }), { ms });
    const off = await run(PLAIN, withRecall({ returnK: 4, enumerationPerSource: 0 }), { ms });
    expect(on.memories.length).toBeGreaterThan(0);
    expect(same(on)).toEqual(same(off));
  });

  it('enumeration.plain-query-same-ids-order-and-scores-full', async () => {
    const ms = [...memories(), GATED];
    const onRerank = reranker(RERANK);
    const offRerank = reranker(RERANK);
    const on = await run(PLAIN, withRecall({ returnK: 4 }), { ms, rerank: onRerank });
    const off = await run(PLAIN, withRecall({ returnK: 4, enumerationPerSource: 0 }), {
      ms,
      rerank: offRerank,
    });
    expect(ids(on)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(same(on)).toEqual(same(off));
    // The rerank call asks for the top k, as before.
    expect(onRerank.topK).toEqual([4]);
    expect(offRerank.topK).toEqual([4]);
  });
});

describe('an enumeration question about several things', () => {
  const ORDERED =
    'In what order did these happen: the day I adopted the puppy, the day I started the new job, and the day I sold my car?';
  const P = vec(0, 100, 0, 0);
  const J = vec(0, 0, 100, 0);
  const C = vec(0, 0, 0, 100);

  function partsEmbedder(): Embedder {
    return {
      dimension: 4,
      async embed(texts) {
        return texts.map((t) => {
          if (/puppy/.test(t) && /car/.test(t)) return Q;
          if (/puppy/.test(t)) return P;
          if (/job/.test(t)) return J;
          if (/car/.test(t)) return C;
          return vec(1, 1, 1, 1);
        });
      },
    };
  }

  /** Notes that ask about the order, and all three events, in one session; one note in another. */
  function events(): Memory[] {
    const crowd = (id: string, n: number, session: string) =>
      memory({
        id,
        text: `Note ${n}: in what order did these happen? I keep mixing up the order of those days.`,
        embedding: vec(100, n, n, n),
        source: at(session),
      });
    return [
      crowd('a1', 1, 'session-a'),
      crowd('a2', 2, 'session-a'),
      crowd('a3', 3, 'session-a'),
      crowd('b1', 9, 'session-b'),
      memory({
        id: 'puppy',
        text: 'Adopted the puppy from the shelter today.',
        embedding: vec(5, 100, 0, 0),
        source: at('session-a'),
      }),
      memory({
        id: 'job',
        text: 'Started the new job at the bakery this morning.',
        embedding: vec(5, 0, 100, 0),
        source: at('session-a'),
      }),
      memory({
        id: 'car',
        text: 'Sold my car to the neighbour.',
        embedding: vec(5, 0, 0, 100),
        source: at('session-a'),
      }),
    ];
  }

  it('enumeration.parts-split-and-it-is-an-enumeration', () => {
    expect(isEnumeration(ORDERED)).toBe(true);
    expect(subQueries(ORDERED)).toHaveLength(3);
  });

  it('enumeration.each-part-best-match-keeps-its-place', async () => {
    const go = async (perSource: number) => {
      const store = await setup(events());
      return recall(
        { text: ORDERED, scope: SCOPE },
        {
          store,
          embed: partsEmbedder(),
          config: withRecall({ returnK: 5, enumerationPerSource: perSource }),
          now: NOW,
        },
      );
    };
    const off = await go(0);
    const on = await go(2);
    const heads = (r: RecallResult) =>
      r.memories.flatMap((m, i) => (m.explanation.part === undefined ? [] : [[m.id, i]]));
    // The three best matches come first, all from one session. Each keeps its place with the
    // spread, though the third is past the two places a session holds.
    expect(heads(off).map(([, i]) => i)).toEqual([0, 1, 2]);
    expect(heads(on)).toEqual(heads(off));
    expect(new Set(on.memories.map((m) => m.source.sessionId))).toEqual(
      new Set(['session-a', 'session-b']),
    );
    expect(ids(on).slice(0, 3)).toEqual(ids(off).slice(0, 3));
    // The next place goes to another session; the notes of the first fill what is left.
    expect(ids(off).slice(3)).not.toContain('b1');
    expect(ids(on)[3]).toBe('b1');
    expect(on.memories[4]?.source.sessionId).toBe('session-a');
  });
});
