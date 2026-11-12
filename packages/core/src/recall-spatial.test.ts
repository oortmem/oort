import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder, MemoryStore, ScopeFilter } from './adapters.js';
import { resolveConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { SpatialUnsupportedError, type Place } from './place.js';
import { recall } from './recall.js';
import { makeMemory, TG, vec } from './store-conformance.js';

/**
 * Spatial recall (CON-84): `within` and `near` filter the first stage inside the store, compose
 * with every temporal view, leave ranking alone, and explain themselves with `placePath` and
 * `distanceM`.
 */

const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-recall-spatial-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const NOW = new Date('2026-11-11T12:00:00.000Z');
const embed: Embedder = {
  dimension: 4,
  async embed(texts) {
    return texts.map((t) => (t.includes('toolbox') ? vec(100, 0, 0, 0) : vec(0, 0, 0, 100)));
  },
};

const room = (r: string, x: number): Place => ({
  nodeId: `site:hq/floor:1/room:${r}`,
  mapId: 'hq',
  pose: { x, y: 0 },
});

function toolbox(id: string, place: Place | undefined, extra: Partial<Memory> = {}): Memory {
  return makeMemory({
    id,
    text: `The ${id} toolbox is here.`,
    stub: `${id} toolbox`,
    entities: ['toolbox'],
    embedding: vec(100, 0, 0, 0),
    validFrom: '2026-11-01T00:00:00.000Z',
    ...(place !== undefined && { place }),
    ...extra,
  });
}

async function setup(memories: Memory[]): Promise<MemoryStore> {
  const store = createMemoryStore({ d: config.activation.d, now: () => NOW });
  for (const m of memories) await store.upsert(TG, m);
  return store;
}

const ids = (r: { memories: { id: string }[] }) => r.memories.map((m) => m.id).sort();

describe('recall spatial', () => {
  const rooms = () => [
    toolbox('red', room('A', 0)),
    toolbox('blue', room('B', 10)),
    toolbox('green', { ...room('B', 12), nodeId: 'site:hq/floor:1/room:B/shelf:B3' }),
    toolbox('grey', room('C', 20)),
    toolbox('loose', undefined),
  ];

  it('recall.within-returns-only-the-place-and-explains-it', async () => {
    const store = await setup(rooms());
    const r = await recall(
      { text: 'toolbox', scope: SCOPE, within: 'room:B' },
      { store, embed, config, now: NOW },
    );
    expect(ids(r)).toEqual(['blue', 'green']);
    const green = r.memories.find((m) => m.id === 'green')!;
    expect(green.explanation.placePath).toBe('site:hq/floor:1/room:B/shelf:B3');
    expect(green.explanation.distanceM).toBeUndefined();
    expect(green.place?.nodeId).toBe('site:hq/floor:1/room:B/shelf:B3');
    expect(r.spatial).toEqual({ within: 'room:B' });
  });

  it('recall.near-returns-the-radius-with-its-distance', async () => {
    const store = await setup(rooms());
    const r = await recall(
      { text: 'toolbox', scope: SCOPE, near: { mapId: 'hq', pose: { x: 11, y: 0 }, radius: 1.5 } },
      { store, embed, config, now: NOW },
    );
    expect(ids(r)).toEqual(['blue', 'green']);
    for (const m of r.memories) expect(m.explanation.distanceM).toBeCloseTo(1);
    const other = await recall(
      { text: 'toolbox', scope: SCOPE, near: { mapId: 'lab', pose: { x: 11, y: 0 }, radius: 100 } },
      { store, embed, config, now: NOW },
    );
    expect(other.memories).toEqual([]);
  });

  it('recall.within-and-near-together-both-hold', async () => {
    const store = await setup(rooms());
    const r = await recall(
      {
        text: 'toolbox',
        scope: SCOPE,
        within: 'room:B',
        near: { mapId: 'hq', pose: { x: 13, y: 0 }, radius: 1.5 },
      },
      { store, embed, config, now: NOW },
    );
    expect(ids(r)).toEqual(['green']);
  });

  it('recall.without-a-filter-is-unchanged-by-places', async () => {
    const store = await setup(rooms());
    const r = await recall({ text: 'toolbox', scope: SCOPE }, { store, embed, config, now: NOW });
    expect(ids(r)).toEqual(['blue', 'green', 'grey', 'loose', 'red']);
    expect(r.spatial).toBeUndefined();
    expect(r.memories.find((m) => m.id === 'loose')!.explanation.placePath).toBeUndefined();
  });

  it('recall.spatial-composes-with-as-of-and-history', async () => {
    // The toolbox was on shelf B3 until Wednesday, then on the bench in room C.
    const before = toolbox(
      'b3',
      { nodeId: 'site:hq/room:B/shelf:B3' },
      {
        text: 'The toolbox is on shelf B3.',
        validFrom: '2026-11-02T00:00:00.000Z',
        validTo: '2026-11-04T00:00:00.000Z',
        expiredAt: '2026-11-04T00:00:00.000Z',
        endReason: 'superseded',
        supersededBy: 'bench',
      },
    );
    const after = toolbox(
      'bench',
      { nodeId: 'site:hq/room:C/bench' },
      {
        text: 'The toolbox is on the bench.',
        validFrom: '2026-11-04T00:00:00.000Z',
        supersedes: 'b3',
      },
    );
    const store = await setup([before, after]);
    const deps = { store, embed, config, now: NOW };
    const current = await recall({ text: 'toolbox', scope: SCOPE, within: 'shelf:B3' }, deps);
    expect(ids(current)).toEqual([]);
    const tuesday = await recall(
      { text: 'toolbox', scope: SCOPE, within: 'shelf:B3', asOf: '2026-11-03T12:00:00.000Z' },
      deps,
    );
    expect(ids(tuesday)).toEqual(['b3']);
    const history = await recall(
      { text: 'toolbox', scope: SCOPE, within: 'shelf:B3', mode: 'history' },
      deps,
    );
    // The fact found on B3, with the rest of its chain: the move to the bench.
    expect(history.memories.map((m) => m.id)).toEqual(['b3', 'bench']);
    expect(history.memories[1]!.explanation.chain).toBe(true);
    expect(history.memories[1]!.explanation.placePath).toBe('site:hq/room:C/bench');
  });

  it('recall.checks-the-filter-before-reading', async () => {
    const store = await setup(rooms());
    await expect(
      recall({ text: 'toolbox', scope: SCOPE, within: 'room B' }, { store, embed, config }),
    ).rejects.toThrow(RangeError);
    await expect(
      recall(
        { text: 'toolbox', scope: SCOPE, near: { mapId: 'hq', pose: { x: 0, y: 0 }, radius: 0 } },
        { store, embed, config },
      ),
    ).rejects.toThrow('near.radius');
  });

  it('recall.refuses-a-spatial-query-on-a-store-that-cannot-filter', async () => {
    const inner = await setup(rooms());
    // A store from before spatial memory: it would ignore the filter and return every room.
    const { spatial: _s, ...rest } = inner;
    const store = rest as MemoryStore;
    await expect(
      recall({ text: 'toolbox', scope: SCOPE, within: 'room:B' }, { store, embed, config }),
    ).rejects.toBeInstanceOf(SpatialUnsupportedError);
    const plain = await recall(
      { text: 'toolbox', scope: SCOPE },
      { store, embed, config, now: NOW },
    );
    expect(plain.memories.length).toBe(5);
  });

  it('recall.passes-no-search-options-without-a-filter', async () => {
    const inner = await setup(rooms());
    const calls: unknown[][] = [];
    const store: MemoryStore = {
      ...inner,
      lexical: (...a) => {
        calls.push(a);
        return inner.lexical(...a);
      },
      dense: (...a) => {
        calls.push(a);
        return inner.dense(...a);
      },
    };
    await recall({ text: 'toolbox', scope: SCOPE }, { store, embed, config, now: NOW });
    expect(calls.every((a) => a.length === 3)).toBe(true);
    calls.length = 0;
    await recall(
      { text: 'toolbox', scope: SCOPE, within: 'room:A' },
      { store, embed, config, now: NOW },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((a) => (a[3] as { spatial?: unknown }).spatial !== undefined)).toBe(true);
  });
});
