import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Memory } from './model.js';
import type {
  DecisionController,
  Embedder,
  MemoryStore,
  GateDecision,
  MemoryWriter,
  Observation,
  ReconcileDecision,
  ScopeFilter,
} from './adapters.js';
import { resolveConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import { observe, type ObserveDeps } from './observe.js';
import { localScope } from './scope.js';
import { makeMemory, vec } from './store-conformance.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-observe-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const FILTER: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};

function fakeEmbedder(table: [string, Int8Array][]): Embedder {
  return {
    dimension: 4,
    async embed(texts) {
      return texts.map((t) => table.find(([k]) => t.includes(k))?.[1] ?? vec(0, 0, 0, 100));
    },
  };
}

function gate(shouldStore: number, salience = 0.5): GateDecision {
  return {
    shouldStore,
    salience,
    types: { semantic: 0.9 },
    decisions: [{ stage: 'gate', question: 'store?', answer: 'yes', probability: shouldStore }],
  };
}

function rec(
  candidateId: string | null,
  action: ReconcileDecision['action'],
  p = 0.9,
): ReconcileDecision {
  return {
    candidateId,
    action,
    probability: p,
    decisions: [{ stage: 'reconcile', question: 'action', answer: action, probability: p }],
  };
}

interface Spy {
  embed: number;
  reconcile: Memory[][];
  write: { action: string; prior?: Memory }[];
  access: string[][];
  filters: ScopeFilter[];
}

function setup(g: GateDecision, r: ReconcileDecision[] | (() => ReconcileDecision[])) {
  const real = createMemoryStore({ d: config.activation.d });
  const spy: Spy = { embed: 0, reconcile: [], write: [], access: [], filters: [] };
  const store: MemoryStore = Object.create(real) as MemoryStore;
  store.lexical = (q, f, k) => {
    spy.filters.push(f);
    return real.lexical(q, f, k);
  };
  store.dense = (v, f, k) => {
    spy.filters.push(f);
    return real.dense(v, f, k);
  };
  store.recordAccess = (ids, at) => {
    spy.access.push(ids);
    return real.recordAccess(ids, at);
  };
  const decide: DecisionController = {
    async gate() {
      return g;
    },
    async reconcile(_o, cands) {
      spy.reconcile.push(cands);
      return typeof r === 'function' ? r() : r;
    },
  };
  const write: MemoryWriter = {
    async write(obs, action, prior) {
      spy.write.push({ action, ...(prior !== undefined && { prior }) });
      return {
        text: `claim: ${obs.userText}`,
        stub: obs.userText.slice(0, 20),
        entities: [],
        type: 'semantic',
      };
    },
  };
  const inner = fakeEmbedder([
    ['auth', vec(100, 0, 0, 0)],
    ['port', vec(0, 100, 0, 0)],
  ]);
  const embed: Embedder = {
    dimension: 4,
    embed(texts, kind) {
      spy.embed++;
      return inner.embed(texts, kind);
    },
  };
  const deps: ObserveDeps = {
    store,
    embed,
    decide,
    write,
    config,
    now: new Date('2026-01-01T00:00:00Z'),
  };
  return { store: real, deps, spy };
}

function obs(userText: string, at = '2026-01-01T00:00:00.000Z'): Observation {
  return {
    userText,
    assistantText: 'noted',
    toolSummaries: [],
    sessionId: 's1',
    turnRef: 't1',
    at,
  };
}

describe('observe', () => {
  it('observe.skips-low-salience', async () => {
    const { store, deps } = setup(gate(0.1), []);
    const res = await observe(obs('hello there'), localScope(), deps);
    expect(res.outcome).toBe('skipped');
    expect(res.memoryId).toBeUndefined();
    expect(await store.list(FILTER)).toEqual([]);
  });

  it('observe.reinforce-increments-access', async () => {
    const { store, deps } = setup(gate(0.9), [rec('X', 'REINFORCE')]);
    await store.upsert(
      makeMemory({ id: 'X', text: 'auth runs on port 4000', embedding: vec(100, 0, 0, 0) }),
    );
    const res = await observe(obs('auth runs on port 4000'), localScope(), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
    expect((await store.get('X'))?.accessLog.count).toBe(1);
    expect(await store.list(FILTER)).toHaveLength(1);
  });

  it('observe.add-stores-warm', async () => {
    const { store, deps } = setup(gate(0.9, 0.5), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('added');
    const m = await store.get(res.memoryId ?? '');
    expect(m?.tier).toBe('warm');
    expect(m?.pinned).toBe(false);
    expect(m?.supersedes).toBeNull();
    expect(m?.embedding).toEqual(vec(100, 0, 0, 0));
    expect(m?.source.harness).toBe('unknown');
  });

  it('observe.high-salience-is-hot', async () => {
    const { store, deps } = setup(gate(0.9, 0.85), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect((await store.get(res.memoryId ?? ''))?.tier).toBe('hot');
  });

  it('observe.supersede-chain', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps, spy } = setup(gate(0.9), () => next);
    const a = await observe(
      obs('auth on port 3000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(
      obs('auth on port 4000', '2026-01-02T00:00:00.000Z'),
      localScope(),
      deps,
    );
    expect(b.outcome).toBe('superseded');
    next = [rec(b.memoryId ?? null, 'UPDATE')];
    const c = await observe(
      obs('auth on port 5000', '2026-01-03T00:00:00.000Z'),
      localScope(),
      deps,
    );
    expect(c.outcome).toBe('updated');
    expect(spy.reconcile[2]?.map((m) => m.id)).toEqual([b.memoryId]);

    const valid = await store.list(FILTER, { validOnly: true });
    expect(valid.map((m) => m.id)).toEqual([c.memoryId]);
    const [A, B, C] = await Promise.all([a, b, c].map((r) => store.get(r.memoryId ?? '')));
    expect(C?.supersedes).toBe(B?.id);
    expect(B?.supersededBy).toBe(C?.id);
    expect(B?.validTo).toBe('2026-01-03T00:00:00.000Z');
    expect(A?.supersededBy).toBe(B?.id);
    expect(A?.validTo).toBe('2026-01-02T00:00:00.000Z');
  });

  it('observe.records-decisions', async () => {
    const { store, deps } = setup(gate(0.9), [rec(null, 'ADD', 0.7), rec(null, 'NOOP', 0.2)]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    const m = await store.get(res.memoryId ?? '');
    const stages = m?.source.decisions.map((d) => d.stage);
    expect(stages).toEqual(['gate', 'reconcile', 'reconcile', 'write']);
    expect(m?.source.decisions.at(-1)).toMatchObject({ answer: 'ADD', probability: 0.7 });
    expect(res.decisions).toHaveLength(3);
    expect(m?.source.sessionId).toBe('s1');
  });

  it('observe.gate-reinforce-skips-embed-reconcile-write', async () => {
    const { store, deps, spy } = setup(gate(0.1), []);
    await store.upsert(makeMemory({ id: 'X', text: 'auth runs on port 4000' }));
    const res = await observe(obs('auth runs on port 4000'), localScope(), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
    expect(spy.access).toEqual([['X']]);
    expect([spy.embed, spy.reconcile.length, spy.write.length]).toEqual([0, 0, 0]);
  });

  it('observe.gate-skip-calls-nothing', async () => {
    const { deps, spy } = setup(gate(0.1), []);
    const res = await observe(obs('hello there'), localScope(), deps);
    expect(res.outcome).toBe('skipped');
    expect([spy.embed, spy.reconcile.length, spy.write.length, spy.access.length]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('observe.gate-reinforce-skips-superseded-hit', async () => {
    const { store, deps, spy } = setup(gate(0.1), []);
    await store.upsert(
      makeMemory({
        id: 'old',
        text: 'auth auth auth runs on port 3000 auth',
        validTo: '2025-12-01T00:00:00.000Z',
        supersededBy: 'cur',
      }),
    );
    await store.upsert(makeMemory({ id: 'cur', text: 'auth port', supersedes: 'old' }));
    const res = await observe(obs('auth port'), localScope(), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'cur' });
    expect(spy.access).toEqual([['cur']]);
  });

  it('observe.empty-candidates-reconcile-then-add', async () => {
    const { deps, spy } = setup(gate(0.9), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('added');
    expect(spy.reconcile).toEqual([[]]);
    expect(spy.write.map((w) => w.action)).toEqual(['ADD']);
  });

  it('observe.all-noop-skips', async () => {
    const { store, deps, spy } = setup(gate(0.9), [rec(null, 'NOOP')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('skipped');
    expect(res.decisions.map((d) => d.stage)).toEqual(['gate', 'reconcile']);
    expect(spy.write).toEqual([]);
    expect(await store.list(FILTER)).toEqual([]);
  });

  it('observe.reinforce-null-candidate-skips', async () => {
    const { deps, spy } = setup(gate(0.9), [rec(null, 'REINFORCE')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('skipped');
    expect(spy.access).toEqual([]);
  });

  it('observe.reinforce-unknown-candidate-skips', async () => {
    const { deps, spy } = setup(gate(0.9), [rec('ghost', 'REINFORCE')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('skipped');
    expect(spy.access).toEqual([]);
  });

  it('observe.update-unresolvable-candidate-adds', async () => {
    const { store, deps, spy } = setup(gate(0.9), [rec('ghost', 'UPDATE')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('added');
    expect(spy.write).toEqual([{ action: 'ADD' }]);
    const m = await store.get(res.memoryId ?? '');
    expect(m?.supersedes).toBeNull();
    expect(m?.source.decisions.at(-1)).toMatchObject({ stage: 'write', answer: 'ADD' });
  });

  it('observe.salience-boundary-is-hot', async () => {
    const { store, deps } = setup(gate(0.9, 0.8), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect((await store.get(res.memoryId ?? ''))?.tier).toBe('hot');
  });

  it('observe.lookup-filter-scopes', async () => {
    const g = setup(gate(0.9), [rec(null, 'ADD')]);
    await observe(obs('auth moved'), localScope(), g.deps);
    expect(g.spy.filters.every((f) => JSON.stringify(f.projectIds) === '[null]')).toBe(true);
    expect(g.spy.filters.length).toBeGreaterThan(0);
    const p = setup(gate(0.9), [rec(null, 'ADD')]);
    await observe(obs('auth moved'), localScope('p'), p.deps);
    expect(p.spy.filters.every((f) => JSON.stringify(f.projectIds) === '["p",null]')).toBe(true);
    expect(p.spy.filters.length).toBeGreaterThan(0);
  });
});
