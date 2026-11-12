import { describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  informativeTokens,
  recall,
  resolveConfig,
  tokenizeLexical,
  type Memory,
} from '@oortmem/core';
import {
  buildDemoRows,
  buildHookRows,
  buildWarmUpRows,
  demoMemories,
  multiHopMemories,
} from './fixture.js';
import { GENERATOR_NOW } from './generate.js';
import { ALL_SCOPE, seedStore } from './seed.js';

const memories = demoMemories();
const byId = new Map(memories.map((m) => [m.id, m]));
const tokens = (s: string): Set<string> => new Set(tokenizeLexical(s));
const shared = (a: Set<string>, b: Set<string>): string[] => [...a].filter((t) => b.has(t));
const pairOf = (target: string): { bridge: Memory; target: Memory } => ({
  bridge: byId.get(target.replace(/-target$/, '-bridge')) as Memory,
  target: byId.get(target) as Memory,
});

describe('multi-hop fixture rows (CON-146)', () => {
  const rows = buildDemoRows(memories).filter((r) => r.category === 'multi-hop');
  const hook = buildHookRows(memories).filter((r) => r.category === 'multi-hop');

  it('multi-hop.target-shares-no-word-with-the-question', () => {
    expect(rows).toHaveLength(6);
    expect(hook).toHaveLength(6);
    for (const r of [...rows, ...hook]) {
      const { bridge, target } = pairOf(r.expectedMemoryIds[0] as string);
      const q = tokens(r.question);
      const t = tokens([target.text, target.stub, ...target.entities].join(' '));
      expect(shared(q, t), r.question).toEqual([]);
      // The bridge is what the words reach.
      expect(
        shared(informativeTokens(r.question), informativeTokens(bridge.text)).length,
        r.question,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('multi-hop.linked-by-a-specific-entity-or-the-next-turn', () => {
    let about = 0;
    let episode = 0;
    for (const r of rows) {
      const { bridge, target } = pairOf(r.expectedMemoryIds[0] as string);
      const entities = shared(new Set(bridge.entities), new Set(target.entities));
      if (bridge.source.sessionId === target.source.sessionId) {
        episode++;
        expect(entities).toEqual([]);
        expect([bridge.source.turnRef, target.source.turnRef]).toEqual(['t1', 't2']);
        expect(Date.parse(target.createdAt)).toBeGreaterThan(Date.parse(bridge.createdAt));
      } else {
        about++;
        expect(entities).toHaveLength(1);
        // Specific: no other memory in the demo store names it.
        const fan = memories.filter((m) => m.entities.includes(entities[0] as string));
        expect(fan).toHaveLength(2);
      }
    }
    expect({ about, episode }).toEqual({ about: 3, episode: 3 });
  });

  it('multi-hop.unreachable-without-links (the baseline the links bar is held to)', async () => {
    const store = createMemoryStore({ now: () => GENERATOR_NOW });
    await seedStore(store, memories);
    const config = resolveConfig(
      '/nonexistent',
      { OORT_HOME: '/nonexistent' },
      { projectConfig: false },
    );
    for (const r of rows) {
      const got = await recall(
        { text: r.question, scope: ALL_SCOPE },
        { store, config, now: GENERATOR_NOW },
      );
      const ids = got.memories.map((m) => m.id);
      expect(ids, r.question).not.toContain(r.expectedMemoryIds[0]);
    }
  });

  it('multi-hop.warm-up-questions-return-both-ends-together', async () => {
    const store = createMemoryStore({ now: () => GENERATOR_NOW });
    await seedStore(store, memories);
    const config = resolveConfig(
      '/nonexistent',
      { OORT_HOME: '/nonexistent' },
      { projectConfig: false },
    );
    const warm = buildWarmUpRows();
    expect(warm).toHaveLength(6);
    for (const [i, r] of warm.entries()) {
      const got = await recall(
        { text: r.question, scope: ALL_SCOPE },
        { store, config, now: GENERATOR_NOW },
      );
      const ids = got.memories.slice(0, 3).map((m) => m.id);
      // Both ends in the top 3: the search hits a recalledWith pair is learned from (section 5).
      expect(ids, r.question).toEqual(
        expect.arrayContaining([`mh-${i + 1}-bridge`, `mh-${i + 1}-target`]),
      );
    }
  });

  it('multi-hop.warm-up-and-hook-sets-are-disjoint-from-the-fixture', () => {
    const fixture = new Set(buildDemoRows(memories).map((r) => r.question));
    for (const r of [...buildWarmUpRows(), ...buildHookRows(memories)]) {
      expect(fixture.has(r.question), r.question).toBe(false);
    }
  });

  it('multi-hop.memories-are-deterministic', () => {
    expect(multiHopMemories()).toEqual(multiHopMemories());
    expect(multiHopMemories().map((m) => m.id)).toHaveLength(12);
  });
});

describe('hook-shaped set (CON-146, decision 3)', () => {
  const rows = buildHookRows(memories);

  it('hook.short-conversational-prompts', () => {
    expect(rows.map((r) => r.category)).toEqual([
      ...Array(4).fill('single-fact'),
      ...Array(6).fill('multi-hop'),
      ...Array(5).fill('abstention'),
    ]);
    for (const r of rows) expect(r.question.split(' ').length, r.question).toBeLessThanOrEqual(10);
  });

  it('hook.single-fact-prompts-have-one-answer', () => {
    for (const r of rows.filter((x) => x.category === 'single-fact')) {
      const words = r.question.split(' ').slice(-3);
      const answers = memories.filter((m) => {
        const have = tokens(m.text);
        return words.every((w) => have.has(w));
      });
      expect(
        answers.map((m) => m.id),
        r.question,
      ).toEqual(r.expectedMemoryIds);
    }
  });
});
