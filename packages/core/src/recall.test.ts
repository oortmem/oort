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
import { makeMemory, vec } from './store-conformance.js';

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
  for (const m of memories) await store.upsert(m);
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
    await store.coldPut(cold);
    const r = await recall({ text: 'quokka', scope: SCOPE }, { store, config });
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]?.text).toBe('full text about quokka migration');
    expect(r.memories[0]?.explanation.hydrated).toBe(true);
    const live = await store.get('c');
    expect(live?.tier).toBe('warm');
    expect(live?.embedding).toBeDefined();
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
    store.lexical = (q, scope, k) => {
      lexicalQueries.push(q);
      return inner.lexical(q, scope, k);
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
      { store, embed, rerank, config },
    );
    expect(r.degraded).toEqual(['embed-failed', 'rerank-failed']);
    expect(r.memories.map((m) => m.id)).toEqual(['a']);
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
    expect((await store.get('hit'))?.accessLog.count).toBe(1);
    expect((await store.get('miss'))?.accessLog.count).toBe(0);
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
    explanation: { fused: 0, activation: 0, hydrated: false },
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
});
