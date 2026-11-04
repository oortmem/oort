import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DecisionController,
  Embedder,
  GateDecision,
  MemoryWriter,
  Observation,
  ReconcileDecision,
  WrittenMemory,
} from './adapters.js';
import { resolveConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { observe } from './observe.js';
import { localScope } from './scope.js';
import { makeMemory, vec } from './store-conformance.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-observe-multi-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const scope = localScope();
const NOW = new Date('2026-11-04T12:00:00.000Z');

const obs: Observation = {
  userText: 'CI on main is green again, and release 1.2 shipped this morning.',
  assistantText: 'Noted both.',
  toolSummaries: [],
  at: '2026-11-04T11:00:00.000Z',
};

const fact = (text: string, entities: string[] = []): WrittenMemory => ({
  text,
  stub: text.slice(0, 40),
  entities,
  type: 'semantic',
});

/** One vector per keyword, so each fact finds only the memories about its own subject. */
const KEYS: [string, Int8Array][] = [
  ['CI', vec(100, 0, 0, 0)],
  ['release', vec(0, 100, 0, 0)],
  ['pnpm', vec(0, 0, 100, 0)],
];
const embedder = (calls: string[][]): Embedder => ({
  dimension: 4,
  async embed(texts) {
    calls.push(texts);
    return texts.map((t) => KEYS.find(([k]) => t.includes(k))?.[1] ?? vec(0, 0, 0, 100));
  },
});

const gate: GateDecision = {
  shouldStore: 0.9,
  salience: 0.5,
  types: { semantic: 0.9 },
  decisions: [{ stage: 'gate', question: 'store?', answer: 'yes', probability: 0.9 }],
};

const rec = (
  candidateId: string | null,
  action: ReconcileDecision['action'],
  p = 0.9,
): ReconcileDecision => ({
  candidateId,
  action,
  probability: p,
  decisions: [{ stage: 'reconcile', question: 'action', answer: action, probability: p }],
});

/**
 * Jev, faked by subject: a fact supersedes a candidate that shares its first word (its
 * subject), and is unrelated (NOOP) to everything else. With no candidates it is novel.
 */
function bySubject(fact: Observation, candidates: Memory[]): ReconcileDecision[] {
  if (candidates.length === 0) return [rec(null, 'ADD')];
  const subject = fact.userText.split(' ')[0];
  return candidates.map((c) =>
    c.text.split(' ')[0] === subject ? rec(c.id, 'SUPERSEDE', 0.95) : rec(c.id, 'NOOP', 0.9),
  );
}

interface Spy {
  writeMany: number;
  write: number;
  reconcile: string[];
  reconcileMany: number;
  embeds: string[][];
}

function deps(
  facts: WrittenMemory[],
  opts: { batched?: boolean; seed?: Memory[] } = {},
): {
  spy: Spy;
  run: () => ReturnType<typeof observe>;
  store: ReturnType<typeof createMemoryStore>;
} {
  const store = createMemoryStore({ d: config.activation.d, now: () => NOW });
  const spy: Spy = { writeMany: 0, write: 0, reconcile: [], reconcileMany: 0, embeds: [] };
  const decide: DecisionController = {
    async gate() {
      return gate;
    },
    async reconcile(o, candidates) {
      spy.reconcile.push(o.userText);
      return bySubject(o, candidates);
    },
    ...(opts.batched === true && {
      async reconcileMany(items: { obs: Observation; candidates: Memory[] }[]) {
        spy.reconcileMany++;
        return items.map((it) => bySubject(it.obs, it.candidates));
      },
    }),
  };
  const write: MemoryWriter = {
    async write() {
      spy.write++;
      throw new Error('the multi path must not call write()');
    },
    async writeMany(_o, max) {
      spy.writeMany++;
      return facts.slice(0, Math.max(max, facts.length));
    },
  };
  const run = async () => {
    for (const m of opts.seed ?? []) await store.upsert(m);
    return observe(obs, scope, {
      store,
      embed: embedder(spy.embeds),
      decide,
      write,
      config,
      now: NOW,
    });
  };
  return { spy, run, store };
}

describe('observe with a multi-memory writer (CON-56)', () => {
  it('observe.multi.three-facts-become-three-memories', async () => {
    const { spy, run, store } = deps([
      fact('CI on main is green.', ['CI']),
      fact('release 1.2 shipped on 2026-11-04.', ['release']),
      fact('pnpm is the package manager.', ['pnpm']),
    ]);
    const r = await run();
    expect(r.memories.map((m) => m.outcome)).toEqual(['added', 'added', 'added']);
    expect(r.outcome).toBe('added');
    expect(r.memoryId).toBe(r.memories[0]?.memoryId);
    // One writer call, one embed call for all facts, no single-memory write.
    expect(spy.writeMany).toBe(1);
    expect(spy.write).toBe(0);
    expect(spy.embeds).toHaveLength(1);
    expect(spy.embeds[0]).toHaveLength(3);
    const stored = await store.list({
      orgId: scope.orgId,
      customerId: scope.customerId,
      agentId: scope.agentId,
      projectIds: [null],
    });
    expect(stored.map((m) => m.text).sort()).toEqual([
      'CI on main is green.',
      'pnpm is the package manager.',
      'release 1.2 shipped on 2026-11-04.',
    ]);
    // Each memory keeps its own fact's embedding, not the whole turn's.
    const ci = stored.find((m) => m.text.startsWith('CI'));
    expect([...(ci?.embedding ?? [])]).toEqual([100, 0, 0, 0]);
  });

  it('observe.multi.each-fact-is-reconciled-on-its-own', async () => {
    const { spy, run } = deps([fact('CI on main is green.'), fact('release 1.2 shipped.')]);
    await run();
    expect(spy.reconcile).toEqual(['CI on main is green.', 'release 1.2 shipped.']);
  });

  it('observe.multi.unrelated-status-updates-supersede-only-their-own-fact', async () => {
    const oldCi = makeMemory({
      id: 'ci-red',
      scope,
      text: 'CI on main is red.',
      embedding: vec(100, 0, 0, 0),
      validFrom: '2026-11-01T00:00:00.000Z',
    });
    const oldRelease = makeMemory({
      id: 'release-planned',
      scope,
      text: 'release 1.2 is planned for next week.',
      embedding: vec(0, 100, 0, 0),
      validFrom: '2026-11-02T00:00:00.000Z',
    });
    const { run, store } = deps(
      [fact('CI on main is green.'), fact('release 1.2 shipped on 2026-11-04.')],
      { seed: [oldCi, oldRelease] },
    );
    const r = await run();
    expect(r.memories.map((m) => m.outcome)).toEqual(['superseded', 'superseded']);
    const [ci, rel] = r.memories;
    const ciPrior = await store.get('ci-red');
    const relPrior = await store.get('release-planned');
    // Each old status is closed by the new status about the same thing, never the other one.
    expect(ciPrior?.supersededBy).toBe(ci?.memoryId);
    expect(relPrior?.supersededBy).toBe(rel?.memoryId);
    expect((await store.get(ci!.memoryId!))?.supersedes).toBe('ci-red');
    expect((await store.get(rel!.memoryId!))?.supersedes).toBe('release-planned');
  });

  it('observe.multi.facts-from-one-turn-never-supersede-each-other', async () => {
    // Both facts start with "CI": under the fake Jev each would supersede the other if it
    // could see it, but candidates are gathered before anything from this turn is stored.
    const { run, store } = deps([fact('CI uses pnpm 12.'), fact('CI caches the store.')]);
    const r = await run();
    expect(r.memories.map((m) => m.outcome)).toEqual(['added', 'added']);
    for (const m of r.memories) expect((await store.get(m.memoryId!))?.supersedes).toBeNull();
  });

  it('observe.multi.a-prior-is-claimed-once', async () => {
    const old = makeMemory({
      id: 'ci-red',
      scope,
      text: 'CI on main is red.',
      embedding: vec(100, 0, 0, 0),
      validFrom: '2026-11-01T00:00:00.000Z',
    });
    const { run, store } = deps([fact('CI on main is green.'), fact('CI on main is fast.')], {
      seed: [old],
    });
    const r = await run();
    expect(r.memories.map((m) => m.outcome)).toEqual(['superseded', 'added']);
    expect((await store.get('ci-red'))?.supersededBy).toBe(r.memories[0]?.memoryId);
    const second = await store.get(r.memories[1]!.memoryId!);
    expect(second?.supersedes).toBeNull();
    expect(second?.source.decisions.some((d) => d.question === 'prior-claimed')).toBe(true);
  });

  it('observe.multi.caps-at-max-memories-per-observation', async () => {
    const seven = ['CI a.', 'CI b.', 'CI c.', 'CI d.', 'CI e.', 'CI f.', 'CI g.'].map((t) =>
      fact(t),
    );
    const { run } = deps(seven);
    const r = await run();
    expect(config.writer.maxMemoriesPerObservation).toBe(5);
    expect(r.memories).toHaveLength(5);
  });

  it('observe.multi.duplicate-facts-are-stored-once', async () => {
    const { run } = deps([fact('CI on main is green.'), fact('CI on main is green. ')]);
    const r = await run();
    expect(r.memories).toHaveLength(1);
  });

  it('observe.multi.batched-reconcile-is-one-call', async () => {
    const { spy, run } = deps(
      [fact('CI on main is green.'), fact('release 1.2 shipped.'), fact('pnpm 12.')],
      { batched: true },
    );
    const r = await run();
    expect(spy.reconcileMany).toBe(1);
    expect(spy.reconcile).toEqual([]);
    expect(r.memories).toHaveLength(3);
  });

  it('observe.multi.counts-summarise-the-memories', async () => {
    const old = makeMemory({
      id: 'ci-red',
      scope,
      text: 'CI on main is red.',
      embedding: vec(100, 0, 0, 0),
      validFrom: '2026-11-01T00:00:00.000Z',
    });
    const { run } = deps([fact('CI on main is green.'), fact('release 1.2 shipped.')], {
      seed: [old],
    });
    const r = await run();
    expect(r.counts).toEqual({ superseded: 1, added: 1 });
  });
});
