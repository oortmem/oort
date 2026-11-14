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
import {
  observe,
  REINFORCE_MIN_CONTAINMENT,
  REINFORCE_MIN_SHARED,
  type ObserveDeps,
} from './observe.js';
import { localScope } from './scope.js';
import { makeMemory, seedCold, vec } from './store-conformance.js';
import { recall } from './recall.js';
import { TG } from './store-conformance.js';
import { localGrant, type GrantFilter } from './grant.js';

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
  filters: GrantFilter[];
  /** One entry per store write call: the method and the ids it wrote. */
  writes: string[][];
}

function setup(
  g: GateDecision,
  r: ReconcileDecision[] | (() => ReconcileDecision[]),
  listNow?: () => Date,
) {
  const real = createMemoryStore({ d: config.activation.d, ...(listNow && { now: listNow }) });
  const spy: Spy = { embed: 0, reconcile: [], write: [], access: [], filters: [], writes: [] };
  const store: MemoryStore = Object.create(real) as MemoryStore;
  store.lexical = (grant, q, k) => {
    spy.filters.push(grant.read);
    return real.lexical(grant, q, k);
  };
  store.dense = (grant, v, k) => {
    spy.filters.push(grant.read);
    return real.dense(grant, v, k);
  };
  store.upsert = (grant, m) => {
    spy.writes.push(['upsert', m.id]);
    return real.upsert(grant, m);
  };
  store.upsertMany = (grant, ms) => {
    spy.writes.push(['upsertMany', ...ms.map((m) => m.id)]);
    return real.upsertMany(grant, ms);
  };
  store.recordAccess = (grant, ids, at) => {
    spy.access.push(ids);
    return real.recordAccess(grant, ids, at);
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
  it('observe.caps-text-before-gate-and-writer', async () => {
    const { deps } = setup(gate(0.9), [rec(null, 'ADD')]);
    const seen: Observation[] = [];
    const big = '日本語😀 '.repeat(20_000);
    const res = await observe({ ...obs(big), assistantText: big }, localScope(), {
      ...deps,
      decide: {
        async gate(o) {
          seen.push(o);
          return gate(0.9);
        },
        async reconcile(o) {
          seen.push(o);
          return [rec(null, 'ADD')];
        },
      },
      write: {
        async write(o) {
          seen.push(o);
          return { text: 'x', stub: 'x', entities: [], type: 'semantic' };
        },
      },
    });
    expect(res.outcome).toBe('added');
    expect(seen).toHaveLength(3);
    for (const o of seen) {
      expect(new TextEncoder().encode(o.userText).length).toBeLessThanOrEqual(32 * 1024);
      expect(new TextEncoder().encode(o.assistantText).length).toBeLessThanOrEqual(32 * 1024);
      expect(o.userText).toMatch(/\[… \d+ bytes omitted …\]/);
    }
  });

  it('observe.skips-low-salience', async () => {
    const { store, deps } = setup(gate(0.1), []);
    const res = await observe(obs('hello there'), localScope(), deps);
    expect(res.outcome).toBe('skipped');
    expect(res.memoryId).toBeUndefined();
    expect(await store.list(localGrant(FILTER))).toEqual([]);
  });

  it('observe.reinforce-increments-access', async () => {
    const { store, deps } = setup(gate(0.9), [rec('X', 'REINFORCE')]);
    await store.upsert(
      TG,
      makeMemory({ id: 'X', text: 'auth runs on port 4000', embedding: vec(100, 0, 0, 0) }),
    );
    const res = await observe(obs('auth runs on port 4000'), localScope(), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
    expect((await store.get(TG, 'X'))?.accessLog.count).toBe(1);
    expect(await store.list(localGrant(FILTER))).toHaveLength(1);
  });

  it('observe.add-stores-warm', async () => {
    const { store, deps } = setup(gate(0.9, 0.5), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect(res.outcome).toBe('added');
    const m = await store.get(TG, res.memoryId ?? '');
    expect(m?.tier).toBe('warm');
    expect(m?.pinned).toBe(false);
    expect(m?.supersedes).toBeNull();
    expect(m?.embedding).toEqual(vec(100, 0, 0, 0));
    expect(m?.source.harness).toBe('unknown');
  });

  it('observe.high-salience-is-hot', async () => {
    const { store, deps } = setup(gate(0.9, 0.85), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect((await store.get(TG, res.memoryId ?? ''))?.tier).toBe('hot');
  });

  it('observe.supersede-chain', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps, spy } = setup(gate(0.9), () => next);
    const a = await observe(obs('auth on port 3000', '2026-01-01T00:00:00.000Z'), localScope(), {
      ...deps,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(obs('auth on port 4000', '2026-01-02T00:00:00.000Z'), localScope(), {
      ...deps,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(b.outcome).toBe('superseded');
    next = [rec(b.memoryId ?? null, 'SUPERSEDE')];
    const c = await observe(obs('auth on port 5000', '2026-01-03T00:00:00.000Z'), localScope(), {
      ...deps,
      now: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(c.outcome).toBe('superseded');
    expect(spy.reconcile[2]?.map((m) => m.id)).toEqual([b.memoryId]);

    const valid = await store.list(localGrant(FILTER), { validOnly: true });
    expect(valid.map((m) => m.id)).toEqual([c.memoryId]);
    const [A, B, C] = await Promise.all([a, b, c].map((r) => store.get(TG, r.memoryId ?? '')));
    expect(C?.supersedes).toBe(B?.id);
    expect(B?.supersededBy).toBe(C?.id);
    expect(B?.validTo).toBe('2026-01-03T00:00:00.000Z');
    expect(A?.supersededBy).toBe(B?.id);
    expect(A?.validTo).toBe('2026-01-02T00:00:00.000Z');
  });

  it('observe.supersede-closes-prior-at-new-validFrom', async () => {
    // Observed 01-06 for a fact that started 01-05.
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(
      obs('auth on port 3000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(obs('auth on port 4000', '2026-01-05T00:00:00.000Z'), localScope(), {
      ...deps,
      now: new Date('2026-01-06T00:00:00.000Z'),
    });
    const [A, B] = await Promise.all([a, b].map((r) => store.get(TG, r.memoryId ?? '')));
    expect(A).toMatchObject({
      validTo: B?.validFrom,
      expiredAt: '2026-01-06T00:00:00.000Z',
      endReason: 'superseded',
      supersededBy: B?.id,
    });
    expect(B).toMatchObject({ validTo: null, expiredAt: null, endReason: null });
    expect(b.decisions.at(-1)).toMatchObject({ stage: 'temporal', answer: 'in-order' });
    expect(B?.source.decisions).toContainEqual(
      expect.objectContaining({ stage: 'temporal', answer: 'in-order' }),
    );
  });

  it('observe.future-supersede-keeps-prior-current-until-switch', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(
      gate(0.9),
      () => next,
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    const a = await observe(
      obs('auth on port 3000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    await observe(obs('auth on port 4000', '2026-01-05T00:00:00.000Z'), localScope(), deps);
    const A = await store.get(TG, a.memoryId ?? '');
    expect(A).toMatchObject({
      expiredAt: null,
      endReason: 'superseded',
      validTo: '2026-01-05T00:00:00.000Z',
    });
    expect((await store.list(localGrant(FILTER))).map((m) => m.id)).toEqual([a.memoryId]);
  });

  it('observe.future-validFrom-fact-is-reinforced-though-not-listed', async () => {
    const { store, deps } = setup(gate(0.1), [], () => new Date('2026-01-01T00:00:00.000Z'));
    await store.upsert(
      TG,
      makeMemory({
        id: 'F',
        text: 'auth runs on port 4000',
        validFrom: '2026-02-01T00:00:00.000Z',
      }),
    );
    expect(await store.list(localGrant(FILTER))).toEqual([]);
    const res = await observe(obs('auth runs on port 4000'), localScope(), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'F' });
  });

  it('observe.out-of-order-older-fact-closes-itself', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(
      obs('auth on port 4000', '2026-01-05T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(
      obs('auth on port 3000', '2026-01-02T00:00:00.000Z'),
      localScope(),
      deps,
    );
    expect(b.outcome).toBe('superseded');
    const [A, B] = await Promise.all([a, b].map((r) => store.get(TG, r.memoryId ?? '')));
    expect(A).toMatchObject({ validTo: null, expiredAt: null, endReason: null, supersedes: B?.id });
    expect(B).toMatchObject({
      validTo: A?.validFrom,
      expiredAt: '2026-01-01T00:00:00.000Z',
      endReason: 'superseded',
      supersededBy: A?.id,
      supersedes: null,
    });
    expect((await store.list(localGrant(FILTER))).map((m) => m.id)).toEqual([a.memoryId]);
    const temporal = {
      stage: 'temporal',
      question: 'order',
      answer: 'out-of-order',
      probability: 1,
    };
    expect(b.decisions.at(-1)).toMatchObject(temporal);
    expect(B?.source.decisions).toContainEqual(temporal);
  });

  it('observe.out-of-order-repairs-predecessor-chain', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const z = await observe(
      obs('auth on port 1000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(z.memoryId ?? null, 'SUPERSEDE')];
    const a = await observe(
      obs('auth on port 3000', '2026-01-10T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(
      obs('auth on port 2000', '2026-01-05T00:00:00.000Z'),
      localScope(),
      deps,
    );
    const [Z, A, B] = await Promise.all([z, a, b].map((r) => store.get(TG, r.memoryId ?? '')));
    expect(Z?.supersededBy).toBe(B?.id);
    expect(B?.supersedes).toBe(Z?.id);
    expect(B?.supersededBy).toBe(A?.id);
    expect(A?.supersedes).toBe(B?.id);
    expect(B?.validTo).toBe(A?.validFrom);
    expect(Z?.validTo).toBe(B?.validFrom);
    expect((await store.list(localGrant(FILTER))).map((m) => m.id)).toEqual([a.memoryId]);
  });

  it('observe.out-of-order-deep-walks-back-one-step', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const y = await observe(
      obs('auth on port 100', '2026-01-03T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(y.memoryId ?? null, 'SUPERSEDE')];
    const z = await observe(
      obs('auth on port 1000', '2026-01-05T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(z.memoryId ?? null, 'SUPERSEDE')];
    const a = await observe(
      obs('auth on port 3000', '2026-01-10T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(obs('auth on port 7', '2026-01-04T00:00:00.000Z'), localScope(), deps);
    // B (01-04) is older than A (01-10) and than its predecessor Z (01-05).
    const [Y, Z, B] = await Promise.all([y, z, b].map((r) => store.get(TG, r.memoryId ?? '')));
    expect(B).toMatchObject({
      validTo: Z?.validFrom,
      supersededBy: Z?.id,
      supersedes: Y?.id,
      endReason: 'superseded',
    });
    expect(Z?.supersedes).toBe(B?.id);
    expect(Y?.supersededBy).toBe(B?.id);
    expect(B?.source.decisions).toContainEqual(
      expect.objectContaining({ stage: 'temporal', answer: 'out-of-order-deep' }),
    );
  });

  it('observe.multi-record-writes-are-one-upsertMany', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { deps, spy } = setup(gate(0.9), () => next);
    const z = await observe(
      obs('auth on port 1000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(z.memoryId ?? null, 'SUPERSEDE')];
    const a = await observe(
      obs('auth on port 3000', '2026-01-10T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(
      obs('auth on port 2000', '2026-01-05T00:00:00.000Z'),
      localScope(),
      deps,
    );
    expect(spy.writes).toEqual([
      ['upsert', z.memoryId],
      ['upsertMany', a.memoryId, z.memoryId],
      ['upsertMany', b.memoryId, a.memoryId, z.memoryId],
    ]);
  });

  it('observe.reinforce-sets-lastConfirmedAt', async () => {
    // Only a decided REINFORCE confirms; the gate-stage path bumps activation alone.
    const gateSide = setup(gate(0.1), []);
    await gateSide.store.upsert(TG, makeMemory({ id: 'X', text: 'auth runs on port 4000' }));
    const res = await observe(obs('auth runs on port 4000'), localScope(), gateSide.deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
    expect((await gateSide.store.get(TG, 'X'))?.lastConfirmedAt).toBeNull();

    const rec2 = setup(gate(0.9), [rec('Y', 'REINFORCE')]);
    await rec2.store.upsert(
      TG,
      makeMemory({ id: 'Y', text: 'auth runs on port 4000', embedding: vec(100, 0, 0, 0) }),
    );
    await observe(obs('auth runs on port 4000'), localScope(), rec2.deps);
    expect((await rec2.store.get(TG, 'Y'))?.lastConfirmedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('observe.records-decisions', async () => {
    const { store, deps } = setup(gate(0.9), [rec(null, 'ADD', 0.7), rec(null, 'NOOP', 0.2)]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    const m = await store.get(TG, res.memoryId ?? '');
    const stages = m?.source.decisions.map((d) => d.stage);
    expect(stages).toEqual(['gate', 'reconcile', 'reconcile', 'write']);
    expect(m?.source.decisions.at(-1)).toMatchObject({ answer: 'ADD', probability: 0.7 });
    expect(res.decisions).toHaveLength(3);
    expect(m?.source.sessionId).toBe('s1');
  });

  it('observe.gate-reinforce-skips-embed-reconcile-write', async () => {
    const { store, deps, spy } = setup(gate(0.1), []);
    await store.upsert(TG, makeMemory({ id: 'X', text: 'auth runs on port 4000' }));
    const res = await observe(obs('auth runs on port 4000'), localScope(), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
    expect(spy.access).toEqual([['X']]);
    expect([spy.embed, spy.reconcile.length, spy.write.length]).toEqual([0, 0, 0]);
  });

  it('observe.gate-reinforce-ignores-coincidental-overlap', async () => {
    const { store, deps, spy } = setup(gate(0.1), []);
    // One shared token ("job").
    await store.upsert(TG, makeMemory({ id: 'one', text: 'Billing job runs nightly at 02:00' }));
    // Four shared tokens, but under a third of a long memory's.
    await store.upsert(
      TG,
      makeMemory({
        id: 'long',
        text: 'Staging deploys of the payments service wait for the canary, then promote at noon',
      }),
    );
    const res = await observe(
      obs('which job deploys the payments thing to staging?'),
      localScope(),
      deps,
    );
    expect(res.outcome).toBe('skipped');
    expect(spy.access).toEqual([]);
    for (const id of ['one', 'long']) {
      const m = await store.get(TG, id);
      expect(m?.accessLog.count).toBe(0);
      expect(m?.lastConfirmedAt).toBeNull();
    }
  });

  it('observe.gate-reinforce-on-strong-match', async () => {
    const { store, deps, spy } = setup(gate(0.1), []);
    await store.upsert(TG, makeMemory({ id: 'weak', text: 'The billing job runs nightly' }));
    await store.upsert(TG, makeMemory({ id: 'X', text: 'The auth service listens on port 4000' }));
    const res = await observe(
      obs('so the auth service listens on port 4000, right?'),
      localScope(),
      deps,
    );
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
    expect(spy.access).toEqual([['X']]);
    const m = await store.get(TG, 'X');
    expect(m?.accessLog.count).toBe(1);
    expect(m?.lastConfirmedAt).toBeNull(); // activation only: nothing decided it was confirmed
    expect((await store.get(TG, 'weak'))?.accessLog.count).toBe(0);
    expect([REINFORCE_MIN_SHARED, REINFORCE_MIN_CONTAINMENT]).toEqual([3, 0.5]);
  });

  it('observe.unparseable-at-uses-observe-time', async () => {
    for (const at of ['', 'not a date']) {
      const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
      const res = await observe(obs('auth moved to port 4000', at), localScope(), deps);
      const m = await store.get(TG, res.memoryId ?? '');
      expect(m?.validFrom, JSON.stringify(at)).toBe('2026-01-01T00:00:00.000Z');
      expect((await store.list(localGrant(FILTER))).map((x) => x.id)).toEqual([res.memoryId]);
    }
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
      TG,
      makeMemory({
        id: 'old',
        text: 'auth auth auth runs on port 3000 auth',
        validTo: '2025-12-01T00:00:00.000Z',
        supersededBy: 'cur',
      }),
    );
    await store.upsert(
      TG,
      makeMemory({ id: 'cur', text: 'auth runs on port 3000', supersedes: 'old' }),
    );
    const res = await observe(obs('auth runs on port 3000'), localScope(), deps);
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
    expect(await store.list(localGrant(FILTER))).toEqual([]);
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
    const m = await store.get(TG, res.memoryId ?? '');
    expect(m?.supersedes).toBeNull();
    expect(m?.source.decisions.at(-1)).toMatchObject({ stage: 'write', answer: 'ADD' });
  });

  it('observe.project-observation-never-supersedes-global', async () => {
    for (const action of ['SUPERSEDE', 'UPDATE', 'REFINE', 'CORRECT'] as const) {
      const { store, deps, spy } = setup(gate(0.9), [rec('G', action)]);
      const global = makeMemory({
        id: 'G',
        text: 'auth on port 4000',
        embedding: vec(100, 0, 0, 0),
      });
      await store.upsert(TG, global);
      const res = await observe(obs('auth on port 5000'), localScope('p'), deps);
      // The global fact is another scope's: the project gets its own memory instead.
      expect(res.outcome).toBe('added');
      expect(spy.write).toEqual([{ action: 'ADD' }]);
      expect(await store.get(TG, 'G')).toEqual(global);
      const m = await store.get(TG, res.memoryId ?? '');
      expect(m?.scope.projectId).toBe('p');
      expect(m?.supersedes).toBeNull();
      const scopeDecision = {
        stage: 'scope',
        question: 'cross-scope-target',
        answer: 'add-instead',
        probability: 1,
      };
      expect(res.decisions).toContainEqual(scopeDecision);
      expect(m?.source.decisions).toContainEqual(scopeDecision);
      expect(m?.source.decisions.at(-1)).toMatchObject({ stage: 'write', answer: 'ADD' });
    }
  });

  it('observe.project-observation-may-reinforce-global', async () => {
    const { store, deps } = setup(gate(0.9), [rec('G', 'REINFORCE')]);
    await store.upsert(
      TG,
      makeMemory({ id: 'G', text: 'auth on port 4000', embedding: vec(100, 0, 0, 0) }),
    );
    const res = await observe(obs('auth on port 4000'), localScope('p'), deps);
    expect(res).toMatchObject({ outcome: 'reinforced', memoryId: 'G' });
    expect((await store.get(TG, 'G'))?.accessLog.count).toBe(1);
    expect(res.decisions.some((d) => d.stage === 'scope')).toBe(false);
  });

  it('observe.salience-boundary-is-hot', async () => {
    const { store, deps } = setup(gate(0.9, 0.8), [rec(null, 'ADD')]);
    const res = await observe(obs('auth moved'), localScope(), deps);
    expect((await store.get(TG, res.memoryId ?? ''))?.tier).toBe('hot');
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

  it('observe.never-sends-secret-to-adapters', async () => {
    // Assembled at runtime so no full key literal appears in source.
    const key = ['sk', 'ant', 'api03', 'Zk3Qx9Lm2Vb7Nc4Rt8Yp1Wd6'].join('-');
    const { deps, spy } = setup(gate(0.9), [rec(null, 'ADD')]);
    const guard = (v: unknown): void => {
      if (JSON.stringify(v).includes(key)) throw new Error('secret reached an adapter');
    };
    const wrapped: ObserveDeps = {
      ...deps,
      embed: {
        dimension: 4,
        embed(texts, kind) {
          guard(texts);
          return deps.embed.embed(texts, kind);
        },
      },
      decide: {
        async gate(o) {
          guard(o);
          return deps.decide.gate(o);
        },
        async reconcile(o, c) {
          guard([o, c]);
          return deps.decide.reconcile(o, c);
        },
      },
      write: {
        async write(o, a, p) {
          guard(o);
          return deps.write.write(o, a, p);
        },
      },
    };
    const res = await observe(
      {
        ...obs(`use auth key ${key} for the service, remember this long preference text`),
        toolSummaries: [`env ANTHROPIC=${key}`],
      },
      localScope(),
      wrapped,
    );
    expect(res.outcome).toBe('added');
    expect(spy.write).toHaveLength(1);
  });

  it('observe.drops-mostly-secret-turn', async () => {
    const { deps, spy } = setup(gate(0.9), [rec(null, 'ADD')]);
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A1b2C3d4E5f6G7h8'.repeat(80).slice(0, 1146)}\n-----END PRIVATE KEY-----`; // nosemgrep: synthetic test credential, not a real secret
    const res = await observe(obs(`${pem} ok`), localScope(), deps);
    expect(res).toEqual({
      outcome: 'skipped',
      reason: 'secret',
      decisions: [],
      memories: [{ outcome: 'skipped', reason: 'secret' }],
      counts: { skipped: 1 },
    });
    expect(spy.embed).toBe(0);
    expect(spy.reconcile).toEqual([]);
    expect(spy.write).toEqual([]);
    expect(spy.filters).toEqual([]);
  });
});

describe('observe: dates and the REFINE / SUPERSEDE / CORRECT split (CON-34, CON-49)', () => {
  // A Wednesday.
  const WED = '2026-11-04T10:00:00.000Z';
  const at = (iso: string) => ({ now: new Date(iso) });

  it('observe.until-in-the-fact-sets-validTo', async () => {
    const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
    const res = await observe(obs('auth listens on port 8080 until Friday', WED), localScope(), {
      ...deps,
      ...at(WED),
    });
    expect(await store.get(TG, res.memoryId ?? '')).toMatchObject({
      validFrom: WED,
      validTo: '2026-11-07T00:00:00.000Z',
      expiredAt: null,
    });
    expect(res.decisions).toContainEqual(
      expect.objectContaining({ stage: 'temporal', question: 'interval' }),
    );
  });

  it('observe.starting-next-week-starts-the-fact-and-closes-the-prior-then', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(obs('auth on port 3000', '2026-11-01T00:00:00.000Z'), localScope(), {
      ...deps,
      ...at('2026-11-01T00:00:00.000Z'),
    });
    next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
    const b = await observe(obs('starting next week auth moves to port 4000', WED), localScope(), {
      ...deps,
      ...at(WED),
    });
    const [A, B] = await Promise.all([a, b].map((r) => store.get(TG, r.memoryId ?? '')));
    expect(B?.validFrom).toBe('2026-11-11T00:00:00.000Z');
    // The prior stays current until the new fact starts.
    expect(A).toMatchObject({
      validTo: '2026-11-11T00:00:00.000Z',
      expiredAt: null,
      endReason: 'superseded',
    });
  });

  it('observe.a-wrong-writer-date-is-fixed-from-the-turn', async () => {
    const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
    const write: MemoryWriter = {
      async write() {
        return {
          text: 'On 2026-11-02 the auth service moved to port 4000.',
          stub: 'auth port',
          entities: [],
          type: 'episodic',
        };
      },
    };
    const res = await observe(obs('yesterday auth moved to port 4000', WED), localScope(), {
      ...deps,
      write,
      ...at(WED),
    });
    const m = await store.get(TG, res.memoryId ?? '');
    expect(m?.text).toBe('On 2026-11-03 the auth service moved to port 4000.');
    expect(m?.source.decisions).toContainEqual({
      stage: 'temporal',
      question: 'writer-date',
      answer: '2026-11-02 -> 2026-11-03',
      probability: 1,
    });
  });

  it('observe.refine-updates-the-memory-in-place', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps, spy } = setup(gate(0.9), () => next);
    const a = await observe(
      obs('auth on port 3000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'REFINE', 0.8)];
    const b = await observe(
      obs('auth on port 3000 over TLS', '2026-01-02T00:00:00.000Z'),
      localScope(),
      {
        ...deps,
        ...at('2026-01-02T00:00:00.000Z'),
      },
    );
    expect(b).toMatchObject({ outcome: 'updated', memoryId: a.memoryId });
    expect(spy.write.at(-1)).toMatchObject({ action: 'UPDATE', prior: { id: a.memoryId } });
    const all = await store.list(localGrant(FILTER));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: a.memoryId,
      text: 'claim: auth on port 3000 over TLS',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      expiredAt: null,
      lastConfirmedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(all[0]?.source.decisions).toContainEqual({
      stage: 'refine',
      question: 'previous-text',
      answer: 'claim: auth on port 3000',
      probability: 0.8,
    });
  });

  it('observe.update-is-the-legacy-name-for-refine', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(obs('auth on port 3000'), localScope(), deps);
    next = [rec(a.memoryId ?? null, 'UPDATE')];
    const b = await observe(obs('auth on port 3000 over TLS'), localScope(), deps);
    expect(b).toMatchObject({ outcome: 'updated', memoryId: a.memoryId });
    expect(await store.list(localGrant(FILTER))).toHaveLength(1);
  });

  it('observe.correct-expires-the-prior-and-keeps-its-interval', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps, spy } = setup(gate(0.9), () => next);
    const a = await observe(
      obs('auth on port 3000', '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId ?? null, 'CORRECT')];
    const b = await observe(
      obs('auth was always on port 3001', '2026-01-05T00:00:00.000Z'),
      localScope(),
      {
        ...deps,
        ...at('2026-01-05T00:00:00.000Z'),
      },
    );
    expect(b.outcome).toBe('corrected');
    expect(spy.write.at(-1)).toMatchObject({ action: 'SUPERSEDE', prior: { id: a.memoryId } });
    const [A, B] = await Promise.all([a, b].map((r) => store.get(TG, r.memoryId ?? '')));
    // Transaction time ends; the valid interval is left as it was.
    expect(A).toMatchObject({
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      expiredAt: '2026-01-05T00:00:00.000Z',
      endReason: 'corrected',
      supersededBy: B?.id,
    });
    // The correction takes the prior's place in valid time.
    expect(B).toMatchObject({
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      expiredAt: null,
      endReason: null,
      supersedes: A?.id,
      createdAt: '2026-01-05T00:00:00.000Z',
    });
    expect((await store.list(localGrant(FILTER))).map((m) => m.id)).toEqual([b.memoryId]);
  });

  describe('follow-up fixes', () => {
    const run = (text: string, iso: string, extra: Partial<Observation> = {}) => ({
      o: { ...obs(text, iso), ...extra },
      now: { now: new Date(iso) },
    });

    it('observe.a-stated-date-is-logged-not-rewritten', async () => {
      const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
      const write: MemoryWriter = {
        async write() {
          return {
            text: 'The cutover is 2026-12-01.',
            stub: 'cutover',
            entities: [],
            type: 'semantic',
          };
        },
      };
      const { o, now } = run('Today we agreed the cutover is 2026-12-01', WED);
      const res = await observe(o, localScope(), { ...deps, write, ...now });
      const m = await store.get(TG, res.memoryId ?? '');
      expect(m?.text).toBe('The cutover is 2026-12-01.');
      expect(m?.source.decisions).toContainEqual({
        stage: 'temporal',
        question: 'writer-date',
        answer: 'kept 2026-12-01 (turn reads 2026-11-04)',
        probability: 1,
      });
    });

    it('observe.refine-of-a-cold-memory-survives-recall', async () => {
      const { store, deps } = setup(gate(0.9), [rec('C', 'REFINE')]);
      await seedCold(
        store,
        makeMemory({
          id: 'C',
          text: 'auth on port 3000',
          stub: 'auth port',
          embedding: vec(100, 0, 0, 0),
          validFrom: '2025-12-01T00:00:00.000Z',
        }),
      );
      expect((await store.get(TG, 'C'))?.tier).toBe('cold');
      await observe(obs('auth on port 3000 over TLS'), localScope(), deps);
      const after = await store.get(TG, 'C');
      expect(after).toMatchObject({ tier: 'warm', text: 'claim: auth on port 3000 over TLS' });
      expect(await store.coldGet(TG, 'C')).toBeNull();
      const r = await recall(
        { text: 'auth port TLS', scope: FILTER, mode: 'current' },
        { store, config, now: new Date('2026-01-02T00:00:00.000Z') },
      );
      expect(r.memories.find((m) => m.id === 'C')?.text).toBe('claim: auth on port 3000 over TLS');
    });

    it('observe.correct-and-refine-honour-the-text-bounds', async () => {
      const prior = () =>
        makeMemory({
          id: 'P',
          text: 'auth on port 3000',
          embedding: vec(100, 0, 0, 0),
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2026-06-01T00:00:00.000Z',
        });
      const corrected = setup(gate(0.9), [rec('P', 'CORRECT')]);
      await corrected.store.upsert(TG, prior());
      const c = await observe(
        obs('auth was on port 3001 since 2025-12-15', '2026-01-05T00:00:00.000Z'),
        localScope(),
        corrected.deps,
      );
      // Its own start; no end in the text, so the prior's end stands.
      expect(await corrected.store.get(TG, c.memoryId ?? '')).toMatchObject({
        validFrom: '2025-12-15T00:00:00.000Z',
        validTo: '2026-06-01T00:00:00.000Z',
      });

      const refined = setup(gate(0.9), [rec('P', 'REFINE')]);
      await refined.store.upsert(TG, prior());
      await observe(
        obs('auth on port 3000 over TLS since 2025-12-20', '2026-01-05T00:00:00.000Z'),
        localScope(),
        refined.deps,
      );
      expect(await refined.store.get(TG, 'P')).toMatchObject({
        validFrom: '2025-12-20T00:00:00.000Z',
        validTo: '2026-06-01T00:00:00.000Z',
      });
    });

    it('observe.a-past-end-stores-the-fact-already-ended', async () => {
      const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
      const { o, now } = run('the deploy freeze ran until yesterday', WED);
      const res = await observe(o, localScope(), { ...deps, ...now });
      expect(await store.get(TG, res.memoryId ?? '')).toMatchObject({
        validFrom: '2026-11-03T00:00:00.000Z',
        validTo: '2026-11-04T00:00:00.000Z',
      });
    });

    it('observe.since-before-the-prior-makes-the-update-current', async () => {
      let next: ReconcileDecision[] = [rec(null, 'ADD')];
      const { store, deps } = setup(gate(0.9), () => next);
      const a = await observe(obs('auth on port 3000', '2026-11-01T00:00:00.000Z'), localScope(), {
        ...deps,
        now: new Date('2026-11-01T00:00:00.000Z'),
      });
      next = [rec(a.memoryId ?? null, 'SUPERSEDE')];
      const { o, now } = run('since 2026-10-20 auth listens on port 4000', WED);
      const b = await observe(o, localScope(), { ...deps, ...now });
      const [A, B] = await Promise.all([a, b].map((r) => store.get(TG, r.memoryId ?? '')));
      expect(B).toMatchObject({
        validFrom: '2026-10-20T00:00:00.000Z',
        validTo: null,
        expiredAt: null,
        supersedes: A?.id,
      });
      expect(A).toMatchObject({
        validTo: A?.validFrom,
        expiredAt: WED,
        endReason: 'superseded',
        supersededBy: B?.id,
      });
      expect((await store.list(localGrant(FILTER))).map((m) => m.id)).toEqual([b.memoryId]);
    });

    it('observe.refine-stamps-the-turn-and-appends-only-new-decisions', async () => {
      let next: ReconcileDecision[] = [rec(null, 'ADD')];
      const { store, deps } = setup(gate(0.9), () => next);
      const a = await observe(obs('auth on port 3000'), localScope(), deps);
      for (const turn of ['t2', 't3']) {
        next = [rec(a.memoryId ?? null, 'REFINE')];
        await observe({ ...obs(`auth on port 3000 ${turn}`), turnRef: turn }, localScope(), deps);
      }
      const m = await store.get(TG, a.memoryId ?? '');
      expect(m?.source.turnRef).toBe('t3');
      const count = (q: string) => m?.source.decisions.filter((d) => d.question === q).length;
      // The gate's decision is not copied again on each refine; each refine adds its own.
      expect(count('store?')).toBe(1);
      expect(count('previous-text')).toBe(2);
      expect(m?.source.decisions).toHaveLength(3 + 2 * 3);
    });

    it('observe.relative-dates-use-the-turn-offset', async () => {
      const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
      const at = '2026-11-04T23:30:00-05:00';
      const res = await observe(obs('auth on port 8080 until tomorrow', at), localScope(), {
        ...deps,
        now: new Date(at),
      });
      expect(await store.get(TG, res.memoryId ?? '')).toMatchObject({
        validFrom: '2026-11-05T04:30:00.000Z',
        validTo: '2026-11-06T05:00:00.000Z',
      });
    });
  });
});

describe('observe: places (CON-84)', () => {
  const B3 = { nodeId: 'site:hq/room:B/shelf:B3', mapId: 'hq', pose: { x: 4, y: 1 } };
  const BENCH = { nodeId: 'site:hq/room:C/bench', mapId: 'hq', pose: { x: 20, y: 3 } };
  const placed = (text: string, place: unknown, at?: string): Observation =>
    ({ ...obs(text, at), place }) as Observation;

  it('observe.add-carries-the-place', async () => {
    const { store, deps } = setup(gate(0.9), [rec(null, 'ADD')]);
    const res = await observe(placed('toolbox on the shelf', B3), localScope(), deps);
    expect((await store.get(TG, res.memoryId!))?.place).toEqual(B3);
    const bare = await observe(obs('auth moved'), localScope(), deps);
    expect((await store.get(TG, bare.memoryId!))?.place).toBeUndefined();
  });

  it('observe.a-bad-place-is-refused-before-any-adapter', async () => {
    const { store, deps, spy } = setup(gate(0.9), [rec(null, 'ADD')]);
    const bad = placed('toolbox', { nodeId: 'room B' });
    await expect(observe(bad, localScope(), deps)).rejects.toThrow('place.nodeId');
    await expect(
      observe(placed('toolbox', { mapId: 'hq', pose: { x: 1 } }), localScope(), deps),
    ).rejects.toThrow(RangeError);
    expect(spy.embed).toBe(0);
    expect(await store.list(localGrant(FILTER))).toEqual([]);
  });

  it('observe.supersede-takes-the-new-place-only', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(
      placed('toolbox on shelf B3', B3, '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId!, 'SUPERSEDE')];
    const b = await observe(obs('toolbox was lent out', '2026-01-02T00:00:00.000Z'), localScope(), {
      ...deps,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(b.outcome).toBe('superseded');
    // Nothing is inherited: a fact about something that moved must not keep the old place.
    expect((await store.get(TG, b.memoryId!))?.place).toBeUndefined();
    expect((await store.get(TG, a.memoryId!))?.place).toEqual(B3);
  });

  it('observe.correct-takes-the-new-place-only', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(
      placed('toolbox on shelf B3', B3, '2026-01-01T00:00:00.000Z'),
      localScope(),
      deps,
    );
    next = [rec(a.memoryId!, 'CORRECT')];
    const b = await observe(
      obs('no, the toolbox was never there', '2026-01-02T00:00:00.000Z'),
      localScope(),
      { ...deps, now: new Date('2026-01-02T00:00:00.000Z') },
    );
    expect(b.outcome).toBe('corrected');
    expect((await store.get(TG, b.memoryId!))?.place).toBeUndefined();
  });

  it('observe.refine-keeps-its-place-unless-the-turn-gives-one', async () => {
    let next: ReconcileDecision[] = [rec(null, 'ADD')];
    const { store, deps } = setup(gate(0.9), () => next);
    const a = await observe(placed('toolbox on shelf B3', B3), localScope(), deps);
    next = [rec(a.memoryId!, 'REFINE')];
    await observe(obs('toolbox on shelf B3 is red'), localScope(), deps);
    expect((await store.get(TG, a.memoryId!))?.place).toEqual(B3);
    const B3top = { ...B3, pose: { x: 4, y: 1, z: 1.8 } };
    await observe(placed('toolbox on top of shelf B3', B3top), localScope(), deps);
    expect((await store.get(TG, a.memoryId!))?.place).toEqual(B3top);
  });

  it('observe.reinforce-in-the-same-place-reinforces', async () => {
    const { store, deps } = setup(gate(0.9), [rec('X', 'REINFORCE')]);
    await store.upsert(
      TG,
      makeMemory({ id: 'X', text: 'the toolbox', place: { ...B3, sigma: 0.3 } }),
    );
    // Within the two places' combined uncertainty, or with no place said, it is the same sighting.
    const jitter = { ...B3, pose: { x: 4.2, y: 1.1 } };
    for (const o of [placed('the toolbox', jitter), obs('the toolbox')]) {
      expect(await observe(o, localScope(), deps)).toMatchObject({
        outcome: 'reinforced',
        memoryId: 'X',
      });
    }
    expect(await store.list(localGrant(FILTER))).toHaveLength(1);
  });

  it('observe.reinforce-elsewhere-adds-a-memory', async () => {
    const { store, deps } = setup(gate(0.9), [rec('X', 'REINFORCE')]);
    await store.upsert(TG, makeMemory({ id: 'X', text: 'the toolbox', place: B3 }));
    const cases: unknown[] = [
      BENCH,
      { nodeId: 'site:hq/room:B/shelf:B4' },
      { ...B3, pose: { x: 9, y: 1 } },
      { ...B3, mapId: 'lab' },
    ];
    for (const place of cases) {
      const res = await observe(placed('the toolbox', place), localScope(), deps);
      expect(res.outcome).toBe('added');
      const m = await store.get(TG, res.memoryId!);
      expect(m?.place).toEqual(place);
      expect(m?.source.decisions).toContainEqual({
        stage: 'place',
        question: 'elsewhere',
        answer: 'add-instead',
        probability: 1,
      });
    }
    // The memory it would have reinforced is untouched.
    const x = await store.get(TG, 'X');
    expect(x?.place).toEqual(B3);
    expect(x?.accessLog.count).toBe(0);
  });

  it('observe.a-matching-path-reinforces-when-only-one-side-has-coordinates', async () => {
    // A missing pose is no evidence of being elsewhere: the same path is the same place.
    for (const [known, seen] of [
      [{ nodeId: B3.nodeId }, B3],
      [B3, { nodeId: B3.nodeId }],
    ]) {
      const { store, deps } = setup(gate(0.9), [rec('X', 'REINFORCE')]);
      await store.upsert(TG, makeMemory({ id: 'X', text: 'the toolbox', place: known }));
      expect(await observe(placed('the toolbox', seen), localScope(), deps)).toMatchObject({
        outcome: 'reinforced',
        memoryId: 'X',
      });
    }
  });

  it('observe.a-low-gate-turn-never-reinforces-a-memory-seen-elsewhere', async () => {
    const text = 'the red toolbox sits on the shelf';
    const { store, deps } = setup(gate(0), [rec('X', 'REINFORCE')]);
    await store.upsert(TG, makeMemory({ id: 'X', text, stub: text, place: B3 }));
    const away = await observe(placed(text, BENCH), localScope(), deps);
    expect(away.outcome).toBe('skipped');
    expect((await store.get(TG, 'X'))?.accessLog.count).toBe(0);
    const here = await observe(placed(text, B3), localScope(), deps);
    expect(here).toMatchObject({ outcome: 'reinforced', memoryId: 'X' });
  });

  it('observe.a-place-for-a-placeless-memory-adds-a-memory', async () => {
    const { store, deps } = setup(gate(0.9), [rec('X', 'REINFORCE')]);
    await store.upsert(TG, makeMemory({ id: 'X', text: 'the toolbox' }));
    const res = await observe(placed('the toolbox', B3), localScope(), deps);
    expect(res.outcome).toBe('added');
    expect((await store.get(TG, res.memoryId!))?.place).toEqual(B3);
  });
});
