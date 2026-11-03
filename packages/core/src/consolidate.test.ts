import { describe, expect, it } from 'vitest';
import type { ScopeFilter } from './adapters.js';
import { appendAccess } from './activation.js';
import { resolveConfig } from './config.js';
import { consolidate } from './consolidate.js';
import { createMemoryStore } from './memory-store.js';
import type { AccessLog, Memory } from './model.js';
import { makeMemory as baseMemory, vec } from './store-conformance.js';

const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const NOW = new Date('2026-06-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D = 0.5;

/** `makeMemory` stamps wall-clock times; pin validity to start before NOW. */
function makeMemory(o: Partial<Memory> & { id: string }): Memory {
  return baseMemory({ validFrom: new Date(NOW.getTime() - 400 * DAY).toISOString(), ...o });
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function logAt(...ats: Date[]): AccessLog {
  let log: AccessLog = { count: 0, recent: [], compactedSum: 0, compactedAt: null };
  for (const at of ats) log = appendAccess(log, at, { d: D });
  return log;
}

function setup(hotTopN: number) {
  const store = createMemoryStore({ d: D, now: () => NOW });
  const config = resolveConfig(process.cwd(), { OORT_HOME: '/nonexistent-oort-home' });
  config.activation = { ...config.activation, hotTopN };
  return { store, config, deps: { store, config, now: NOW } };
}

describe('consolidate', () => {
  it('consolidate.top-n-hot', async () => {
    const { store, deps } = setup(2);
    for (const [id, hours] of [
      ['a', 1],
      ['b', 5],
      ['c', 24],
      ['d', 48],
      ['e', 72],
    ] as const) {
      await store.upsert(makeMemory({ id, accessLog: logAt(ago(hours * HOUR)) }));
    }
    const res = await consolidate(SCOPE, deps);
    const hot = (await store.list(SCOPE, { tier: 'hot' })).map((m) => m.id).sort();
    expect(hot).toEqual(['a', 'b']);
    expect(res.promoted.sort()).toEqual(['a', 'b']);
    expect(res.demoted).toEqual([]);
  });

  it('consolidate.stale-goes-cold-and-keeps-stub', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      makeMemory({
        id: 'old',
        text: 'rotated the zebra-quartz credentials',
        stub: 'zebra-quartz credentials rotation',
        salience: 0.2,
        embedding: vec(1, 2, 3, 4),
        accessLog: logAt(ago(30 * DAY)),
      }),
    );
    const res = await consolidate(SCOPE, {
      ...deps,
      config: { ...deps.config, activation: { ...deps.config.activation, hotTopN: 0 } },
    });
    expect(res.evicted).toEqual(['old']);
    expect(res.demoted).toEqual(['old']);
    const m = await store.get('old');
    expect(m?.tier).toBe('cold');
    expect(m?.embedding).toBeUndefined();
    expect((await store.coldGet('old'))?.embedding).toEqual(vec(1, 2, 3, 4));
    const hits = await store.lexical('zebra-quartz', SCOPE, 5);
    expect(hits.map((h) => h.id)).toEqual(['old']);
  });

  it('consolidate.pinned-never-cold', async () => {
    const { store, deps } = setup(0);
    await store.upsert(
      makeMemory({ id: 'p', pinned: true, salience: 0, accessLog: logAt(ago(400 * DAY)) }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.evicted).toEqual([]);
    expect((await store.get('p'))?.tier).toBe('hot');
    expect(await store.coldGet('p')).toBeNull();
  });

  it('consolidate.superseded-goes-cold', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      makeMemory({
        id: 'sup',
        embedding: vec(1, 1, 1, 1),
        validTo: ago(DAY).toISOString(),
        expiredAt: ago(DAY).toISOString(),
        endReason: 'superseded',
        supersededBy: 'new',
        accessLog: logAt(ago(HOUR)),
      }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.demoted).toEqual(['sup']);
    expect(res.evicted).toEqual(['sup']);
    const m = await store.get('sup');
    expect(m?.tier).toBe('cold');
    expect(m?.endReason).toBe('superseded');
    expect(m?.expiredAt).toBe(ago(DAY).toISOString());
    expect(m?.embedding).toBeUndefined();
  });

  it('consolidate.expires-past-validTo', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      makeMemory({ id: 'x', validTo: ago(HOUR).toISOString(), accessLog: logAt(ago(HOUR)) }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.expired).toEqual(['x']);
    const m = await store.get('x');
    expect(m?.expiredAt).toBe(NOW.toISOString());
    expect(m?.endReason).toBe('expired');
    expect((await store.list(SCOPE, { validOnly: true })).map((e) => e.id)).not.toContain('x');
  });

  it('consolidate.future-validTo-stays-current', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      makeMemory({
        id: 'f',
        validTo: new Date(NOW.getTime() + DAY).toISOString(),
        accessLog: logAt(ago(HOUR)),
      }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.expired).toEqual([]);
    expect((await store.get('f'))?.expiredAt).toBeNull();
    expect((await store.list(SCOPE, { validOnly: true })).map((e) => e.id)).toEqual(['f']);
  });

  it('consolidate.idempotent', async () => {
    const { store, deps } = setup(1);
    await store.upsert(makeMemory({ id: 'a', accessLog: logAt(ago(HOUR)) }));
    await store.upsert(
      makeMemory({
        id: 'b',
        embedding: vec(1, 1, 1, 1),
        salience: 0.1,
        accessLog: logAt(ago(300 * DAY)),
      }),
    );
    await store.upsert(makeMemory({ id: 'e', validTo: ago(HOUR).toISOString() }));
    const first = await consolidate(SCOPE, deps);
    expect(first.promoted.length + first.demoted.length + first.expired.length).toBeGreaterThan(0);
    const second = await consolidate(SCOPE, deps);
    expect(second).toEqual({ promoted: [], demoted: [], evicted: [], expired: [] });
  });
  it('consolidate.leaves-out-of-scope-untouched', async () => {
    const { store, deps } = setup(50);
    const stale = { salience: 0.1, embedding: vec(1, 1, 1, 1), accessLog: logAt(ago(300 * DAY)) };
    const base = makeMemory({ id: 'x' }).scope;
    const a = makeMemory({
      id: 'other-customer',
      scope: { ...base, customerId: 'someone-else' },
      ...stale,
    });
    const b = makeMemory({
      id: 'other-agent',
      scope: { ...base, agentId: 'another-agent' },
      validTo: ago(HOUR).toISOString(),
      ...stale,
    });
    await store.upsert(a);
    await store.upsert(b);
    const res = await consolidate(SCOPE, deps);
    for (const arr of Object.values(res)) {
      expect(arr).not.toContain('other-customer');
      expect(arr).not.toContain('other-agent');
    }
    expect(await store.get('other-customer')).toEqual(a);
    expect(await store.get('other-agent')).toEqual(b);
  });

  it('consolidate.pinned-non-current-keeps-tier', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      makeMemory({
        id: 'ps',
        pinned: true,
        tier: 'hot',
        embedding: vec(1, 1, 1, 1),
        validTo: ago(DAY).toISOString(),
        expiredAt: ago(DAY).toISOString(),
        endReason: 'superseded',
        supersededBy: 'new',
      }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.evicted).toEqual([]);
    expect(res.demoted).toEqual([]);
    expect((await store.get('ps'))?.tier).toBe('hot');
    expect(await store.coldGet('ps')).toBeNull();
  });

  it('consolidate.tie-break-newer-updatedAt-first', async () => {
    const { store, deps } = setup(1);
    const common = { accessLog: logAt(ago(HOUR)), salience: 0.5 };
    await store.upsert(
      makeMemory({ id: 'older', updatedAt: ago(2 * DAY).toISOString(), ...common }),
    );
    await store.upsert(makeMemory({ id: 'newer', updatedAt: ago(DAY).toISOString(), ...common }));
    await consolidate(SCOPE, deps);
    expect((await store.get('newer'))?.tier).toBe('hot');
    expect((await store.get('older'))?.tier).toBe('warm');
  });
});
