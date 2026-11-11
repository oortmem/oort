/**
 * The read path's adaptive stop (CON-17): when the reranked set already answers the query, recall
 * does not widen into cold stubs, so it hydrates nothing. A decision model answers the question
 * when one is configured (`DecisionController.sufficient`); otherwise a rule in code does.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionController, MemoryStore, SufficiencyRequest } from './adapters.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { recall } from './recall.js';
import { makeMemory, seedCold, TG, vec } from './store-conformance.js';

const SCOPE = { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectIds: [null] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-stop-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const withRecall = (r: Partial<ResolvedConfig['recall']>): ResolvedConfig => ({
  ...config,
  recall: { ...config.recall, ...r },
});
/** The decision model answers the question (opt-in: it is a model call on the read path). */
const asking = withRecall({ adaptiveStop: 'decide' });

/** A store that records hydrations (upserts during recall). */
function counting(inner: MemoryStore): MemoryStore & { upserts: string[] } {
  const upserts: string[] = [];
  return {
    ...inner,
    upserts,
    upsert: (grant, m) => {
      upserts.push(m.id);
      return inner.upsert(grant, m);
    },
  };
}

/** A decision controller that only answers `sufficient`, recording what it was asked. */
function decider(p: number | Error): DecisionController & { asked: SufficiencyRequest[] } {
  const asked: SufficiencyRequest[] = [];
  const no = () => Promise.reject(new Error('not used'));
  return {
    asked,
    gate: no,
    reconcile: no,
    async sufficient(req) {
      asked.push(req);
      if (p instanceof Error) throw p;
      return {
        probability: p,
        decisions: [
          {
            stage: 'recall',
            question: 'sufficient',
            answer: p >= 0.5 ? 'yes' : 'no',
            probability: p,
          },
        ],
      };
    },
  };
}

const warm = (id: string, text: string, over: Partial<Memory> = {}): Memory =>
  makeMemory({ id, text, stub: text, embedding: vec(1, 0, 0, 0), ...over });

/** A store with one warm memory that answers `auth-service port 8080` and a cold near-miss. */
async function trivial(): Promise<MemoryStore & { upserts: string[] }> {
  const inner = createMemoryStore({ d: config.activation.d });
  await inner.upsert(
    TG,
    warm('w', 'auth-service listens on port 8080 in staging', { salience: 0.9 }),
  );
  await seedCold(inner, warm('c', 'auth-service on-call runbook'));
  return counting(inner);
}

describe('adaptive stop', () => {
  it('stop.rule-skips-cold-stubs-when-the-warm-set-answers', async () => {
    const store = await trivial();
    const r = await recall({ text: 'auth-service port 8080', scope: SCOPE }, { store, config });
    expect(r.memories.map((m) => m.id)).toEqual(['w']);
    expect(r.adaptiveStop).toEqual({ stopped: true, by: 'rule', cold: 1 });
    expect(store.upserts).toEqual([]);
    expect((await store.get(TG, 'c'))?.tier).toBe('cold');
  });

  it('stop.rule-widens-when-a-cold-memory-answers-as-well', async () => {
    const inner = createMemoryStore({ d: config.activation.d });
    await inner.upsert(TG, warm('w', 'auth-service listens on port 8080 in staging'));
    await seedCold(inner, warm('c', 'auth-service moved off port 8080 to 9090 in prod'));
    const store = counting(inner);
    const r = await recall({ text: 'auth-service port 8080', scope: SCOPE }, { store, config });
    expect(new Set(r.memories.map((m) => m.id))).toEqual(new Set(['w', 'c']));
    expect(r.adaptiveStop).toEqual({ stopped: false, by: 'rule', cold: 1 });
    expect(store.upserts).toEqual(['c']);
  });

  it('stop.rule-widens-when-the-top-memory-misses-query-words', async () => {
    const inner = createMemoryStore({ d: config.activation.d });
    await inner.upsert(TG, warm('w', 'auth-service listens in staging', { salience: 0.9 }));
    await seedCold(inner, warm('c', 'auth-service runbook'));
    const store = counting(inner);
    const r = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store, config: withRecall({ minCoverage: 0.3 }) },
    );
    expect(r.adaptiveStop).toEqual({ stopped: false, by: 'rule', cold: 1 });
    expect(r.memories.map((m) => m.id)).toContain('c');
  });

  it('stop.asks-the-decision-model-when-there-is-one', async () => {
    const store = await trivial();
    const decide = decider(0.2);
    const r = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store, config: asking, decide },
    );
    // The model says the warm set is not enough: widen, whatever the rule would have said.
    expect(r.adaptiveStop).toEqual({ stopped: false, by: 'decide', cold: 1, probability: 0.2 });
    expect(r.memories.map((m) => m.id)).toEqual(['w', 'c']);
    expect(store.upserts).toEqual(['c']);
    expect(decide.asked).toHaveLength(1);
    const req = decide.asked[0]!;
    expect(req.query).toBe('auth-service port 8080');
    expect(req.memories.map((m) => m.id)).toEqual(['w']);
    expect(req.memories[0]?.text).toBe('auth-service listens on port 8080 in staging');
    expect(req.cold).toEqual([{ id: 'c', stub: 'auth-service on-call runbook' }]);

    const yes = decider(0.9);
    const again = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store: await trivial(), config: asking, decide: yes },
    );
    expect(again.adaptiveStop).toEqual({ stopped: true, by: 'decide', cold: 1, probability: 0.9 });
    expect(again.memories.map((m) => m.id)).toEqual(['w']);
  });

  it('stop.the-model-is-asked-only-when-configured', async () => {
    // By default the rule decides, even with a decision model: no model call on the read path.
    const decide = decider(0.1);
    const r = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store: await trivial(), config, decide },
    );
    expect(decide.asked).toEqual([]);
    expect(r.adaptiveStop).toEqual({ stopped: true, by: 'rule', cold: 1 });
    // Asked to, but without a model that answers: the rule.
    const noModel = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store: await trivial(), config: asking },
    );
    expect(noModel.adaptiveStop?.by).toBe('rule');
  });

  it('stop.the-threshold-is-sufficientAt', async () => {
    const r = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      {
        store: await trivial(),
        config: withRecall({ adaptiveStop: 'decide', sufficientAt: 0.95 }),
        decide: decider(0.9),
      },
    );
    expect(r.adaptiveStop?.stopped).toBe(false);
  });

  it('stop.a-failed-question-widens', async () => {
    const store = await trivial();
    const r = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store, config: asking, decide: decider(new Error('relay down')) },
    );
    expect(r.adaptiveStop).toEqual({ stopped: false, by: 'decide', cold: 1 });
    expect(r.degraded).toContain('stop-failed');
    expect(r.memories.map((m) => m.id)).toEqual(['w', 'c']);
  });

  it('stop.no-question-without-a-cold-candidate-or-a-warm-one', async () => {
    const inner = createMemoryStore({ d: config.activation.d });
    await inner.upsert(TG, warm('w', 'auth-service listens on port 8080'));
    const decide = decider(0.9);
    const r = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store: inner, config: asking, decide },
    );
    expect(r.adaptiveStop).toBeUndefined();
    expect(decide.asked).toEqual([]);
    // Only cold candidates: nothing to stop at, so recall widens without asking.
    const onlyCold = createMemoryStore({ d: config.activation.d });
    await seedCold(onlyCold, warm('c', 'auth-service listens on port 8080'));
    const c = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store: onlyCold, config: asking, decide },
    );
    expect(c.adaptiveStop).toBeUndefined();
    expect(c.memories[0]?.explanation.hydrated).toBe(true);
    expect(decide.asked).toEqual([]);
  });

  it('stop.off-by-config-and-outside-the-current-view', async () => {
    const off = await recall(
      { text: 'auth-service port 8080', scope: SCOPE },
      { store: await trivial(), config: withRecall({ adaptiveStop: 'off' }) },
    );
    expect(off.adaptiveStop).toBeUndefined();
    expect(off.memories.map((m) => m.id)).toEqual(['w', 'c']);
    // History and as-of reads want old versions, which are often cold: never stopped.
    const history = await recall(
      { text: 'auth-service port 8080', scope: SCOPE, mode: 'history' },
      { store: await trivial(), config },
    );
    expect(history.adaptiveStop).toBeUndefined();
    expect(history.memories.map((m) => m.id)).toContain('c');
  });
});
