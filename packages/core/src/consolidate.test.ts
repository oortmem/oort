import { describe, expect, it } from 'vitest';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import { appendAccess } from './activation.js';
import { resolveConfig } from './config.js';
import { COLD_EVICT_BATCH, consolidate, consolidateGrant } from './consolidate.js';
import { createMemoryStore } from './memory-store.js';
import { isCurrent, type AccessLog, type Memory } from './model.js';
import { makeMemory as baseMemory, vec } from './store-conformance.js';
import { grantFor, TG } from './store-conformance.js';
import { localGrant, principalGrant } from './grant.js';
import { addressed, canonicalMemory } from './address.js';
import { soleGrantFor } from './isolation.js';

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
      await store.upsert(TG, makeMemory({ id, accessLog: logAt(ago(hours * HOUR)) }));
    }
    const res = await consolidate(SCOPE, deps);
    const hot = (await store.list(localGrant(SCOPE), { tier: 'hot' })).map((m) => m.id).sort();
    expect(hot).toEqual(['a', 'b']);
    expect(res.promoted.sort()).toEqual(['a', 'b']);
    expect(res.demoted).toEqual([]);
  });

  it('consolidate.stale-goes-cold-and-keeps-stub', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      TG,
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
    const m = await store.get(TG, 'old');
    expect(m?.tier).toBe('cold');
    expect(m?.embedding).toBeUndefined();
    expect((await store.coldGet(TG, 'old'))?.embedding).toEqual(vec(1, 2, 3, 4));
    const hits = await store.lexical(localGrant(SCOPE), 'zebra-quartz', 5);
    expect(hits.map((h) => h.id)).toEqual(['old']);
  });

  it('consolidate.pinned-never-cold', async () => {
    const { store, deps } = setup(0);
    await store.upsert(
      TG,
      makeMemory({ id: 'p', pinned: true, salience: 0, accessLog: logAt(ago(400 * DAY)) }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.evicted).toEqual([]);
    expect((await store.get(TG, 'p'))?.tier).toBe('hot');
    expect(await store.coldGet(TG, 'p')).toBeNull();
  });

  it('consolidate.superseded-goes-cold', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      TG,
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
    const m = await store.get(TG, 'sup');
    expect(m?.tier).toBe('cold');
    expect(m?.endReason).toBe('superseded');
    expect(m?.expiredAt).toBe(ago(DAY).toISOString());
    expect(m?.embedding).toBeUndefined();
  });

  it('consolidate.expires-past-validTo', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      TG,
      makeMemory({ id: 'x', validTo: ago(HOUR).toISOString(), accessLog: logAt(ago(HOUR)) }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.expired).toEqual(['x']);
    const m = await store.get(TG, 'x');
    expect(m?.expiredAt).toBe(NOW.toISOString());
    expect(m?.endReason).toBe('expired');
    expect(
      (await store.list(localGrant(SCOPE), { validOnly: true })).map((e) => e.id),
    ).not.toContain('x');
  });

  it('consolidate.future-validTo-stays-current', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      TG,
      makeMemory({
        id: 'f',
        validTo: new Date(NOW.getTime() + DAY).toISOString(),
        accessLog: logAt(ago(HOUR)),
      }),
    );
    const res = await consolidate(SCOPE, deps);
    expect(res.expired).toEqual([]);
    expect((await store.get(TG, 'f'))?.expiredAt).toBeNull();
    expect((await store.list(localGrant(SCOPE), { validOnly: true })).map((e) => e.id)).toEqual([
      'f',
    ]);
  });

  it('consolidate.idempotent', async () => {
    const { store, deps } = setup(1);
    await store.upsert(TG, makeMemory({ id: 'a', accessLog: logAt(ago(HOUR)) }));
    await store.upsert(
      TG,
      makeMemory({
        id: 'b',
        embedding: vec(1, 1, 1, 1),
        salience: 0.1,
        accessLog: logAt(ago(300 * DAY)),
      }),
    );
    await store.upsert(TG, makeMemory({ id: 'e', validTo: ago(HOUR).toISOString() }));
    const first = await consolidate(SCOPE, deps);
    expect(first.promoted.length + first.demoted.length + first.expired.length).toBeGreaterThan(0);
    const second = await consolidate(SCOPE, deps);
    expect(second).toEqual({
      promoted: [],
      demoted: [],
      evicted: [],
      expired: [],
      skipped: 0,
      complete: true,
    });
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
    // Another agent's Star: private to it, so this agent's consolidation never touches it.
    const b = makeMemory({
      id: 'other-agent',
      ...addressed(
        { level: 'agent', orgId: 'local', agentId: 'another-agent' },
        {
          agentId: 'another-agent',
        },
      ),
      validTo: ago(HOUR).toISOString(),
      ...stale,
    });
    await store.upsert(grantFor(a.scope), a);
    await store.upsert(soleGrantFor(b), b);
    // Another of the person's agents wrote this one to the Planet: the Planet is shared (CON-62).
    const c = makeMemory({
      id: 'planet-other-author',
      scope: { ...base, agentId: 'another-agent' },
      validTo: ago(HOUR).toISOString(),
      ...stale,
    });
    await store.upsert(grantFor(c.scope), c);
    const res = await consolidate(SCOPE, deps);
    for (const arr of [res.promoted, res.demoted, res.evicted, res.expired]) {
      expect(arr).not.toContain('other-customer');
      expect(arr).not.toContain('other-agent');
    }
    expect(res.expired).toContain('planet-other-author');
    expect(await store.get(grantFor(a.scope), 'other-customer')).toEqual(a);
    expect(await store.get(soleGrantFor(b), 'other-agent')).toEqual(canonicalMemory(b));
  });

  it('consolidate.pinned-non-current-keeps-tier', async () => {
    const { store, deps } = setup(50);
    await store.upsert(
      TG,
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
    expect((await store.get(TG, 'ps'))?.tier).toBe('hot');
    expect(await store.coldGet(TG, 'ps')).toBeNull();
  });

  it('consolidate.tie-break-newer-updatedAt-first', async () => {
    const { store, deps } = setup(1);
    const common = { accessLog: logAt(ago(HOUR)), salience: 0.5 };
    await store.upsert(
      TG,
      makeMemory({ id: 'older', updatedAt: ago(2 * DAY).toISOString(), ...common }),
    );
    await store.upsert(
      TG,
      makeMemory({ id: 'newer', updatedAt: ago(DAY).toISOString(), ...common }),
    );
    await consolidate(SCOPE, deps);
    expect((await store.get(TG, 'newer'))?.tier).toBe('hot');
    expect((await store.get(TG, 'older'))?.tier).toBe('warm');
  });

  it('consolidate.uses-batched-eviction', async () => {
    const { store, deps } = setup(1);
    const n = COLD_EVICT_BATCH * 2 + 7;
    for (let i = 0; i < n; i++) {
      // Superseded memories go straight to cold.
      await store.upsert(TG, makeMemory({ id: `m${i}`, validTo: ago(DAY).toISOString() }));
    }
    const sizes: number[] = [];
    let singles = 0;
    const origMany = store.coldPutMany.bind(store);
    store.coldPutMany = async (grant, ms) => {
      sizes.push(ms.length);
      return origMany(grant, ms);
    };
    store.coldPut = async () => {
      singles++;
      return { skipped: [] };
    };
    const res = await consolidate(SCOPE, deps);
    expect(res.evicted).toHaveLength(n);
    expect(sizes).toEqual([COLD_EVICT_BATCH, COLD_EVICT_BATCH, 7]);
    expect(singles).toBe(0);
    expect((await store.list(localGrant(SCOPE), { tier: 'cold', validOnly: false })).length).toBe(
      n,
    );
  });

  it('consolidate.race-with-supersede-keeps-chain', async () => {
    const { store, deps } = setup(0);
    // Stale and rarely read: consolidation will evict it.
    await store.upsert(
      TG,
      makeMemory({
        id: 'prior',
        text: 'the api listens on 8080',
        salience: 0.1,
        embedding: vec(1, 1, 1, 1),
        accessLog: logAt(ago(300 * DAY)),
        updatedAt: ago(10 * DAY).toISOString(),
      }),
    );
    // A drain supersedes `prior` after consolidate's list() but before its eviction lands.
    const supersede = async (): Promise<void> => {
      const live = await store.get(TG, 'prior');
      if (live === null) throw new Error('prior missing');
      const iso = NOW.toISOString();
      await store.upsertMany(TG, [
        makeMemory({
          id: 'next',
          text: 'the api listens on 9090',
          validFrom: iso,
          supersedes: 'prior',
          embedding: vec(2, 2, 2, 2),
          accessLog: logAt(NOW),
          createdAt: iso,
          updatedAt: iso,
        }),
        {
          ...live,
          validTo: iso,
          expiredAt: iso,
          endReason: 'superseded',
          supersededBy: 'next',
          updatedAt: iso,
        },
      ]);
    };
    let raced = false;
    const racing: MemoryStore = {
      ...store,
      async coldPutMany(grant, ms) {
        if (!raced) {
          raced = true;
          await supersede();
        }
        return store.coldPutMany(grant, ms);
      },
    };
    const res = await consolidate(SCOPE, { ...deps, store: racing });
    expect(raced).toBe(true);
    const prior = await store.get(TG, 'prior');
    const next = await store.get(TG, 'next');
    expect(prior?.supersededBy).toBe('next');
    expect(prior?.expiredAt).toBe(NOW.toISOString());
    expect(prior?.validTo).toBe(NOW.toISOString());
    expect(prior?.endReason).toBe('superseded');
    expect(next?.supersedes).toBe('prior');
    // Exactly one current version of the fact.
    expect([prior, next].filter((m) => m !== null && isCurrent(m, NOW)).map((m) => m?.id)).toEqual([
      'next',
    ]);
    expect(res.evicted).not.toContain('prior');
    expect(res.skipped).toBe(1);
  });

  it('consolidate.global-tier-independent-of-project (CON-48)', async () => {
    // Two global memories and a busier project: hotTopN ranks global memories against global only.
    const run = async (project: 'p1' | 'p2') => {
      const { store, deps } = setup(1);
      const base = localScopeOf();
      await store.upsert(TG, makeMemory({ id: 'g-new', accessLog: logAt(ago(2 * HOUR)) }));
      await store.upsert(TG, makeMemory({ id: 'g-old', accessLog: logAt(ago(2 * DAY)) }));
      // Only p1 has memories, busier than any global one.
      for (const [i, p] of (['p1', 'p1'] as const).entries()) {
        const m = makeMemory({
          id: `${p}-${i}`,
          scope: { ...base, projectId: p },
          accessLog: logAt(ago(5 * 60_000), ago(10 * 60_000)),
        });
        await store.upsert(TG, m);
      }
      await consolidate({ ...SCOPE, projectIds: [project, null] }, deps);
      return {
        gNew: (await store.get(TG, 'g-new'))?.tier,
        gOld: (await store.get(TG, 'g-old'))?.tier,
      };
    };
    const fromP1 = await run('p1');
    const fromP2 = await run('p2');
    // Before CON-48, run from p1, p1's memories outranked g-new, which stayed warm.
    expect(fromP1).toEqual({ gNew: 'hot', gOld: 'warm' });
    expect(fromP2).toEqual(fromP1);
  });

  it('consolidate.each-project-ranked-alone', async () => {
    const { store, deps } = setup(1);
    const base = localScopeOf();
    for (const p of ['p1', 'p2']) {
      await store.upsert(
        TG,
        makeMemory({ id: `${p}-a`, scope: { ...base, projectId: p }, accessLog: logAt(ago(HOUR)) }),
      );
      await store.upsert(
        TG,
        makeMemory({ id: `${p}-b`, scope: { ...base, projectId: p }, accessLog: logAt(ago(DAY)) }),
      );
    }
    await consolidateGrant(TG, deps);
    const hot = (await store.list(TG, { tier: 'hot' })).map((m) => m.id).sort();
    expect(hot).toEqual(['p1-a', 'p2-a']);
  });

  it('consolidate.per-node-planet-and-star', async () => {
    const { store, deps } = setup(1);
    const star = addressed(
      { level: 'agent', orgId: 'local', agentId: 'claude-code' },
      { agentId: 'claude-code' },
    );
    // One fresh and one stale memory in each node: the top one of each node is hot.
    await store.upsert(TG, makeMemory({ id: 'planet-a', accessLog: logAt(ago(HOUR)) }));
    await store.upsert(TG, makeMemory({ id: 'planet-b', accessLog: logAt(ago(DAY)) }));
    await store.upsert(TG, makeMemory({ id: 'star-a', ...star, accessLog: logAt(ago(2 * DAY)) }));
    await store.upsert(
      TG,
      makeMemory({ id: 'star-gone', ...star, validTo: ago(HOUR).toISOString() }),
    );
    // A Star agent's grant reads the Planet but never changes it.
    const starOnly = principalGrant(
      { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
      { home: 'star' },
    );
    const r1 = await consolidateGrant(starOnly, deps);
    expect(r1.promoted).toEqual(['star-a']);
    expect(r1.expired).toEqual(['star-gone']);
    expect((await store.get(TG, 'planet-a'))?.tier).toBe('warm');
    // The Planet's grant consolidates the Planet on its own: star-a does not take its hot slot.
    const r2 = await consolidateGrant(TG, deps);
    expect(r2.promoted).toEqual(['planet-a']);
    expect((await store.get(TG, 'star-a'))?.tier).toBe('hot');
    expect((await store.get(TG, 'star-gone'))?.tier).toBe('cold');
  });

  it('consolidate.should-stop-partial-then-resume', async () => {
    const seed = async (store: MemoryStore) => {
      for (let i = 0; i < 30; i++) {
        await store.upsert(
          TG,
          makeMemory({
            id: `m${i}`,
            embedding: vec(1, 1, 1, 1),
            salience: i % 3 === 0 ? 0.1 : 0.6,
            accessLog: logAt(ago((i % 3 === 0 ? 300 : 1 + i) * DAY)),
            ...(i % 5 === 0 && { validTo: ago(HOUR).toISOString() }),
          }),
        );
      }
    };
    const clean = setup(3);
    await seed(clean.store);
    const full = await consolidateGrant(TG, clean.deps);
    expect(full.complete).toBe(true);

    const cut = setup(3);
    await seed(cut.store);
    let calls = 0;
    const budgeted = { ...cut.deps, evictBatch: 2, shouldStop: () => ++calls > 4 };
    const first = await consolidateGrant(TG, budgeted);
    expect(first.complete).toBe(false);
    // Resume runs until done; each run makes progress.
    let runs = 1;
    for (;;) {
      calls = 0;
      const r = await consolidateGrant(TG, budgeted);
      runs++;
      if (r.complete) break;
      expect(runs).toBeLessThan(40);
    }
    expect(runs).toBeGreaterThan(2);
    const tiers = async (s: MemoryStore) =>
      (await s.list(TG, { validOnly: false })).map((m) => [m.id, m.tier, m.expiredAt]).sort();
    expect(await tiers(cut.store)).toEqual(await tiers(clean.store));
  });

  it('consolidate.crash-mid-run-leaves-store-consistent', async () => {
    const { store, deps } = setup(2);
    for (let i = 0; i < 12; i++) {
      await store.upsert(
        TG,
        makeMemory({
          id: `m${i}`,
          embedding: vec(1, 2, 3, 4),
          salience: 0.1,
          accessLog: logAt(ago((i + 1) * 40 * DAY)),
          ...(i % 4 === 0 && { validTo: ago(HOUR).toISOString() }),
        }),
      );
    }
    const before = await store.list(TG, { validOnly: false });
    let batches = 0;
    const crashing: MemoryStore = {
      ...store,
      async coldPutMany(grant, ms) {
        if (++batches === 2) throw new Error('process killed');
        return store.coldPutMany(grant, ms);
      },
    };
    await expect(consolidateGrant(TG, { ...deps, store: crashing, evictBatch: 3 })).rejects.toThrow(
      'process killed',
    );
    // Nothing lost, and every cold record has its cold copy (with its embedding).
    const mid = await store.list(TG, { validOnly: false });
    expect(mid.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
    for (const m of mid.filter((x) => x.tier === 'cold')) {
      expect((await store.coldGet(TG, m.id))?.embedding).toBeDefined();
    }
    expect(mid.some((m) => m.tier === 'cold')).toBe(true);
    expect(mid.some((m) => m.tier !== 'cold')).toBe(true);
    // The next run finishes the job.
    const again = await consolidateGrant(TG, deps);
    expect(again.complete).toBe(true);
    const after = await store.list(TG, { validOnly: false });
    expect(after.filter((m) => !isCurrent(m, NOW)).every((m) => m.tier === 'cold')).toBe(true);
    expect((await consolidateGrant(TG, deps)).evicted).toEqual([]);
  });
});

function localScopeOf() {
  return makeMemory({ id: 'x' }).scope;
}
