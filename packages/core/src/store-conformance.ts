/**
 * The conformance suite every `MemoryStore` implementation must pass.
 *
 * Imported as `@oortmem/core/store-conformance` (not from the main barrel, so
 * importing core never pulls in vitest). Call it from a test file:
 *
 *     storeConformance('sqlite', async () => openSqliteStore({ dir, dimension: CONFORMANCE_DIMENSION }));
 *
 * Every embedding and query vector the suite uses has `CONFORMANCE_DIMENSION`
 * dimensions (except `dense-rejects-dimension-mismatch`, which queries with one
 * more); a store with a fixed dimension must be built by `make()` with it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import { localGrant, principalGrant, type Grant } from './grant.js';
import type { Memory, Scope } from './model.js';
import { localScope } from './scope.js';
import { isolationViolations, nonInterference } from './isolation.js';

export const CONFORMANCE_DIMENSION = 4;

/** A valid memory with test defaults; `id` is required, everything else overridable. */
export function makeMemory(overrides: Partial<Memory> & { id: string }): Memory {
  const now = new Date().toISOString();
  return {
    scope: localScope(),
    type: 'semantic',
    text: `memory ${overrides.id}`,
    stub: `stub ${overrides.id}`,
    entities: [],
    salience: 0.5,
    pinned: false,
    tier: 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: now,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'test', decisions: [] },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** An int8 vector with `values.length` dimensions. */
export function vec(...values: number[]): Int8Array {
  return Int8Array.from(values);
}

/**
 * Stores `m` and demotes it to cold, the way consolidation does: `coldPut` is
 * targeted and guarded, so it only demotes a record read back from the store.
 * A `tier: "cold"` input is stored warm first. Returns the record as demoted.
 */
export async function seedCold(store: MemoryStore, m: Memory, grant: Grant = TG): Promise<Memory> {
  const snapshot: Memory = { ...m, tier: m.tier === 'cold' ? 'warm' : m.tier };
  await store.upsert(grant, snapshot);
  const { skipped } = await store.coldPut(grant, snapshot);
  if (skipped.length > 0) throw new Error(`seedCold: coldPut skipped ${m.id}`);
  return snapshot;
}

/**
 * The suite's default grant: every project of the local principal (the
 * CLI's own). Tests of isolation build narrower grants with `localGrant`.
 */
export const TG: Grant = principalGrant({
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
});

/** The narrowest grant that can read and write a memory at `scope`. */
export function grantFor(scope: Scope): Grant {
  const { orgId, customerId, agentId } = scope;
  return localGrant({ orgId, customerId, agentId, projectIds: [scope.projectId ?? null] });
}

const LOCAL: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};

function ids(xs: { id: string }[]): string[] {
  return xs.map((x) => x.id);
}

export function storeConformance(name: string, make: () => Promise<MemoryStore>): void {
  describe(`store conformance: ${name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await make();
    });

    afterEach(async () => {
      await store.close();
    });

    it('upsert-get-roundtrip', async () => {
      const m = makeMemory({
        id: 'm1',
        text: 'The auth service listens on port 8080',
        stub: 'auth service port 8080',
        entities: ['auth-service', '8080'],
        embedding: vec(1, -2, 3, -4),
        source: {
          harness: 'test',
          sessionId: 's1',
          turnRef: 't1',
          decisions: [{ stage: 'gate', question: 'store?', answer: 'yes', probability: 0.9 }],
        },
      });
      await store.upsert(TG, m);
      expect(await store.get(TG, 'm1')).toEqual(m);
      expect(await store.get(TG, 'missing')).toBeNull();

      const updated = { ...m, text: 'The auth service listens on port 9090' };
      await store.upsert(TG, updated);
      expect(await store.get(TG, 'm1')).toEqual(updated);
    });

    it('upsert-many-roundtrip', async () => {
      const a = makeMemory({ id: 'a', text: 'first', embedding: vec(1, 2, 3, 4) });
      const b = makeMemory({ id: 'b', text: 'second' });
      await store.upsertMany(TG, [a, b]);
      expect(await store.get(TG, 'a')).toEqual(a);
      expect(await store.get(TG, 'b')).toEqual(b);

      const a2 = { ...a, text: 'first, revised', embedding: vec(4, 3, 2, 1) };
      const c = makeMemory({ id: 'c', text: 'third', embedding: vec(0, 0, 0, 1) });
      await store.upsertMany(TG, [a2, c]);
      expect(await store.get(TG, 'a')).toEqual(a2);
      expect(await store.get(TG, 'b')).toEqual(b);
      expect(await store.get(TG, 'c')).toEqual(c);
      await expect(store.upsertMany(TG, [])).resolves.toBeUndefined();
    });

    it('upsert-warm-drops-cold-copy', async () => {
      const m = makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) });
      await seedCold(store, m);
      const main = await store.get(TG, 'c1');
      if (main === null) throw new Error('coldPut lost the main record');

      // Re-upserting while still cold keeps the cold copy.
      await store.upsert(TG, main);
      expect((await store.coldGet(TG, 'c1'))?.embedding).toEqual(vec(1, 2, 3, 4));

      await store.upsert(TG, { ...main, embedding: vec(1, 2, 3, 4), tier: 'warm' });
      expect(await store.coldGet(TG, 'c1')).toBeNull();
      expect((await store.get(TG, 'c1'))?.tier).toBe('warm');

      await seedCold(store, makeMemory({ id: 'c2' }));
      await store.upsertMany(TG, [{ ...makeMemory({ id: 'c2' }), tier: 'hot' }]);
      expect(await store.coldGet(TG, 'c2')).toBeNull();
    });

    it('cold-put-many-roundtrip', async () => {
      const a = makeMemory({ id: 'a', text: 'alpha', embedding: vec(1, 2, 3, 4) });
      const b = makeMemory({ id: 'b', text: 'beta', tier: 'hot', embedding: vec(4, 3, 2, 1) });
      await store.upsertMany(TG, [a, b]);
      expect(await store.coldPutMany(TG, [a, b])).toEqual({ skipped: [] });
      for (const m of [a, b]) {
        // The cold copy is the snapshot; the main record changes only tier and embedding.
        expect(await store.coldGet(TG, m.id)).toEqual(m);
        const { embedding: _dropped, ...rest } = m;
        expect(await store.get(TG, m.id)).toEqual({ ...rest, tier: 'cold' });
      }
      await expect(store.coldPutMany(TG, [])).resolves.toEqual({ skipped: [] });
    });

    it('cold-put-many-is-atomic', async () => {
      const first = makeMemory({ id: 'x', text: 'first', embedding: vec(1, 2, 3, 4) });
      await seedCold(store, first);
      const good = makeMemory({ id: 'y', text: 'good', embedding: vec(1, 1, 1, 1) });
      const plain = makeMemory({ id: 'z' });
      await store.upsertMany(TG, [good, plain]);
      const bad = { ...plain, embedding: vec(1, 2, 3, 4, 5) }; // wrong dimension
      await expect(store.coldPutMany(TG, [good, bad])).rejects.toThrow();
      expect(await store.get(TG, 'y')).toEqual(good);
      expect(await store.coldGet(TG, 'y')).toBeNull();
      expect(await store.get(TG, 'z')).toEqual(plain);
      expect(await store.coldGet(TG, 'x')).toEqual(first);
      expect((await store.get(TG, 'x'))?.tier).toBe('cold');
    });

    it('cold-put-skips-changed-missing-and-cold', async () => {
      const a = makeMemory({ id: 'a', embedding: vec(1, 2, 3, 4) });
      const b = makeMemory({ id: 'b', embedding: vec(1, 2, 3, 4) });
      const c = makeMemory({ id: 'c', embedding: vec(1, 2, 3, 4) });
      await store.upsertMany(TG, [a, b, c]);
      await store.setTier(TG, 'b', 'hot'); // tier moved since the snapshot
      await store.forget(TG, 'c'); // gone since the snapshot
      const coldSnap = await seedCold(store, makeMemory({ id: 'd', embedding: vec(1, 2, 3, 4) }));
      const d = await store.get(TG, 'd'); // a cold record has no embedding to keep
      if (d === null) throw new Error('seedCold lost d');
      const res = await store.coldPutMany(TG, [a, b, c, d]);
      expect([...res.skipped].sort()).toEqual(['b', 'c', 'd']);
      expect((await store.get(TG, 'a'))?.tier).toBe('cold');
      expect(await store.get(TG, 'b')).toEqual({ ...b, tier: 'hot' });
      expect(await store.coldGet(TG, 'b')).toBeNull();
      expect(await store.get(TG, 'c')).toBeNull(); // never resurrected
      expect(await store.coldGet(TG, 'c')).toBeNull();
      expect(await store.coldGet(TG, 'd')).toEqual(coldSnap);
      // Only the last entry for an id counts.
      const e = makeMemory({ id: 'e', text: 'e', embedding: vec(1, 1, 1, 1) });
      await store.upsert(TG, e);
      const eLater = { ...e, embedding: vec(2, 2, 2, 2) };
      expect(await store.coldPutMany(TG, [e, eLater])).toEqual({ skipped: [] });
      expect((await store.coldGet(TG, 'e'))?.embedding).toEqual(vec(2, 2, 2, 2));
    });

    it('targeted-eviction-preserves-concurrent-supersede', async () => {
      const t0 = '2026-11-01T00:00:00.000Z';
      const t1 = '2026-11-02T00:00:00.000Z';
      const prior = makeMemory({
        id: 'prior',
        text: 'the api listens on 8080',
        validFrom: t0,
        embedding: vec(1, 2, 3, 4),
        createdAt: t0,
        updatedAt: t0,
      });
      const other = makeMemory({ id: 'other', embedding: vec(4, 3, 2, 1), updatedAt: t0 });
      await store.upsertMany(TG, [prior, other]);
      // Consolidation reads its snapshot ...
      const snapshot = await store.list(localGrant(LOCAL), { validOnly: false });
      // ... a drain supersedes `prior` and a recall reads `other` before the eviction lands.
      const next = makeMemory({
        id: 'next',
        text: 'the api listens on 9090',
        validFrom: t1,
        supersedes: 'prior',
        embedding: vec(1, 1, 2, 2),
        createdAt: t1,
        updatedAt: t1,
      });
      const closed: Memory = {
        ...prior,
        validTo: t1,
        expiredAt: t1,
        endReason: 'superseded',
        supersededBy: 'next',
        updatedAt: t1,
      };
      await store.upsertMany(TG, [next, closed]);
      await store.recordAccess(TG, ['other'], new Date(t1));
      const liveOther = await store.get(TG, 'other');

      const res = await store.coldPutMany(TG, snapshot);
      // The chain survives intact: prior stays non-current and linked, nothing resurrected.
      expect(await store.get(TG, 'prior')).toEqual(closed);
      expect(res.skipped).toEqual(['prior']);
      expect(await store.coldGet(TG, 'prior')).toBeNull();
      expect(await store.get(TG, 'next')).toEqual(next);
      // The applied eviction is targeted: the concurrent access is kept.
      const { embedding: _dropped, ...rest } = liveOther as Memory;
      expect(await store.get(TG, 'other')).toEqual({ ...rest, tier: 'cold' });
      expect((await store.get(TG, 'other'))?.accessLog.count).toBe(1);
    });

    it('targeted-expiry-preserves-concurrent-change', async () => {
      const t0 = '2026-11-01T00:00:00.000Z';
      const t1 = '2026-11-02T00:00:00.000Z';
      const at = new Date('2026-11-03T00:00:00.000Z');
      const past = '2026-11-01T12:00:00.000Z';
      const base = { validFrom: t0, validTo: past, embedding: vec(1, 2, 3, 4), updatedAt: t0 };
      const due = makeMemory({ id: 'due', ...base });
      const redated = makeMemory({ id: 'redated', ...base });
      const ended = makeMemory({ id: 'ended', ...base, endReason: 'superseded' });
      const gone = makeMemory({ id: 'gone', ...base });
      await store.upsertMany(TG, [due, redated, ended, gone]);
      const snapshot = await store.list(localGrant(LOCAL), { validOnly: false });
      // Between the read and the expiry: one fact is re-dated, one is read, one forgotten.
      const later = { ...redated, validTo: '2999-01-01T00:00:00.000Z', updatedAt: t1 };
      await store.upsert(TG, later);
      await store.recordAccess(TG, ['due'], new Date(t1));
      await store.forget(TG, 'gone');

      const res = await store.expireMany(TG, snapshot, at);
      expect([...res.skipped].sort()).toEqual(['gone', 'redated']);
      expect(await store.get(TG, 'redated')).toEqual(later);
      expect(await store.get(TG, 'gone')).toBeNull();
      // Only the expiry fields change; the concurrent access is kept.
      const live = await store.get(TG, 'due');
      expect(live).toEqual({
        ...due,
        expiredAt: at.toISOString(),
        endReason: 'expired',
        accessLog: live?.accessLog,
      });
      expect(live?.accessLog.count).toBe(1);
      // An existing end reason is kept.
      expect(await store.get(TG, 'ended')).toEqual({ ...ended, expiredAt: at.toISOString() });
      // Already expired: skipped, and the first expiry stands.
      const again = await store.expireMany(TG, snapshot, new Date('2026-11-04T00:00:00.000Z'));
      expect([...again.skipped].sort()).toEqual(['due', 'ended', 'gone', 'redated']);
      expect((await store.get(TG, 'due'))?.expiredAt).toBe(at.toISOString());
      await expect(store.expireMany(TG, [], at)).resolves.toEqual({ skipped: [] });
    });

    it('lexical-finds-exact-identifier', async () => {
      await store.upsert(
        TG,
        makeMemory({ id: 'target', text: 'Requests now route through auth-service-8080 only' }),
      );
      await store.upsert(TG, makeMemory({ id: 'near', text: 'The auth service used port 3000' }));
      await store.upsert(TG, makeMemory({ id: 'unrelated', text: 'The billing job runs nightly' }));
      const hits = await store.lexical(localGrant(LOCAL), 'auth-service-8080', 10);
      expect(hits[0]).toMatchObject({ id: 'target', tier: 'warm' });
      expect(ids(hits)).not.toContain('unrelated');
    });

    it('lexical-matches-cold-stub', async () => {
      const m = makeMemory({
        id: 'c1',
        text: 'The login backend moved to a new port',
        stub: 'login backend port auth-service-8080',
        entities: ['auth-service-8080'],
        embedding: vec(1, 2, 3, 4),
      });
      await seedCold(store, m);
      const hits = await store.lexical(localGrant(LOCAL), 'auth-service-8080', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ id: 'c1', tier: 'cold' });
    });

    it('dense-returns-nearest', async () => {
      await store.upsert(TG, makeMemory({ id: 'x', embedding: vec(100, 0, 0, 0) }));
      await store.upsert(TG, makeMemory({ id: 'y', embedding: vec(0, 100, 0, 0) }));
      await store.upsert(TG, makeMemory({ id: 'xy', embedding: vec(70, 70, 0, 0) }));
      const q = vec(100, 10, 0, 0);
      expect(ids(await store.dense(localGrant(LOCAL), q, 10))).toEqual(['x', 'xy', 'y']);
      expect(ids(await store.dense(localGrant(LOCAL), q, 2))).toEqual(['x', 'xy']);
    });

    it('dense-excludes-cold', async () => {
      await store.upsert(TG, makeMemory({ id: 'warm', embedding: vec(0, 100, 0, 0) }));
      await store.upsert(TG, makeMemory({ id: 'bare' }));
      await seedCold(store, makeMemory({ id: 'cold', embedding: vec(100, 0, 0, 0) }));
      const hits = await store.dense(localGrant(LOCAL), vec(100, 0, 0, 0), 10);
      expect(ids(hits)).toEqual(['warm']);
      expect(hits[0]?.tier).toBe('warm');
    });

    it('scope-excludes-other-org-customer-agent', async () => {
      const text = 'Deploys go through auth-service-8080';
      const embedding = vec(1, 1, 1, 1);
      const others = {
        'other-org': { ...localScope(), orgId: 'another-org' },
        'other-customer': { ...localScope(), customerId: 'someone-else' },
        'other-agent': { ...localScope(), agentId: 'another-agent' },
      };
      await store.upsert(TG, makeMemory({ id: 'mine', text, embedding }));
      for (const [id, scope] of Object.entries(others)) {
        await store.upsert(grantFor(scope), makeMemory({ id, text, embedding, scope }));
      }
      expect(ids(await store.lexical(localGrant(LOCAL), 'auth-service-8080', 10))).toEqual([
        'mine',
      ]);
      expect(ids(await store.dense(localGrant(LOCAL), embedding, 10))).toEqual(['mine']);
      expect(ids(await store.list(localGrant(LOCAL)))).toEqual(['mine']);

      const none: ScopeFilter = { ...LOCAL, projectIds: [] };
      expect(await store.lexical(localGrant(none), 'auth-service-8080', 10)).toEqual([]);
      expect(await store.dense(localGrant(none), embedding, 10)).toEqual([]);
      expect(await store.list(localGrant(none))).toEqual([]);
    });

    it('dense-rejects-dimension-mismatch', async () => {
      await store.upsert(TG, makeMemory({ id: 'four', embedding: vec(1, 2, 3, 4) }));
      const wrong = new Int8Array(CONFORMANCE_DIMENSION + 1).fill(1);
      const err: unknown = await store.dense(localGrant(LOCAL), wrong, 10).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      const message = (err as RangeError).message;
      expect(message).toContain(String(CONFORMANCE_DIMENSION));
      expect(message).toContain(String(CONFORMANCE_DIMENSION + 1));
    });

    it('scope-project-ids-global-and-p1-not-p2', async () => {
      const text = 'Deploys go through auth-service-8080';
      const embedding = vec(1, 1, 1, 1);
      await store.upsert(TG, makeMemory({ id: 'global', text, embedding, scope: localScope() }));
      await store.upsert(TG, makeMemory({ id: 'p1', text, embedding, scope: localScope('p1') }));
      await store.upsert(TG, makeMemory({ id: 'p2', text, embedding, scope: localScope('p2') }));
      const filter: ScopeFilter = { ...LOCAL, projectIds: [null, 'p1'] };
      const sorted = (xs: { id: string }[]) => ids(xs).sort();
      expect(sorted(await store.lexical(localGrant(filter), 'auth-service-8080', 10))).toEqual([
        'global',
        'p1',
      ]);
      expect(sorted(await store.dense(localGrant(filter), embedding, 10))).toEqual([
        'global',
        'p1',
      ]);
      expect(sorted(await store.list(localGrant(filter)))).toEqual(['global', 'p1']);
      expect(ids(await store.list(localGrant({ ...LOCAL, projectIds: ['p2'] })))).toEqual(['p2']);
    });

    it('record-access-increments-only-listed', async () => {
      await store.upsert(TG, makeMemory({ id: 'a' }));
      await store.upsert(TG, makeMemory({ id: 'b' }));
      await store.upsert(TG, makeMemory({ id: 'c' }));
      const at = new Date('2026-11-03T12:00:00.000Z');
      await store.recordAccess(TG, ['a', 'c', 'unknown'], at);
      for (const id of ['a', 'c']) {
        const log = (await store.get(TG, id))?.accessLog;
        expect(log?.count).toBe(1);
        expect(log?.recent).toEqual([at.toISOString()]);
      }
      expect((await store.get(TG, 'b'))?.accessLog.count).toBe(0);

      await store.recordAccess(TG, ['a'], new Date('2026-11-03T13:00:00.000Z'));
      expect((await store.get(TG, 'a'))?.accessLog.count).toBe(2);
    });

    it('cold-roundtrip-preserves-embedding', async () => {
      const m = makeMemory({ id: 'c1', text: 'A long claim', embedding: vec(5, -6, 7, -8) });
      await seedCold(store, m);
      const cold = await store.coldGet(TG, 'c1');
      expect(cold?.text).toBe('A long claim');
      expect(cold?.embedding).toEqual(vec(5, -6, 7, -8));
      const main = await store.get(TG, 'c1');
      expect(main?.tier).toBe('cold');
      expect(main?.embedding).toBeUndefined();
      expect(main?.stub).toBe(m.stub);
      expect(await store.coldGet(TG, 'missing')).toBeNull();
    });

    it('set-tier', async () => {
      const m = makeMemory({ id: 'm1', embedding: vec(1, 2, 3, 4) });
      await store.upsert(TG, m);
      expect(await store.setTier(TG, 'm1', 'hot')).toBe(true);
      expect(await store.get(TG, 'm1')).toEqual({ ...m, tier: 'hot' });
      expect(await store.setTier(TG, 'missing', 'hot')).toBe(false);
      // Guarded by a snapshot: applies only while updatedAt and tier still match it.
      expect(await store.setTier(TG, 'm1', 'warm', m)).toBe(false); // tier moved since `m`
      expect(await store.setTier(TG, 'm1', 'warm', { ...m, tier: 'hot', updatedAt: 'x' })).toBe(
        false,
      );
      expect((await store.get(TG, 'm1'))?.tier).toBe('hot');
      expect(await store.setTier(TG, 'm1', 'warm', { ...m, tier: 'hot' })).toBe(true);
      expect(await store.get(TG, 'm1')).toEqual(m);
    });

    it('cursor-roundtrip', async () => {
      expect(await store.getCursor(TG, 'import:session-1')).toBeNull();
      await store.setCursor(TG, 'import:session-1', '42');
      expect(await store.getCursor(TG, 'import:session-1')).toBe('42');
      await store.setCursor(TG, 'import:session-1', '43');
      expect(await store.getCursor(TG, 'import:session-1')).toBe('43');
      expect(await store.getCursor(TG, 'import:session-2')).toBeNull();
    });

    it('forget-removes-everywhere', async () => {
      await store.upsert(TG, makeMemory({ id: 'warm', text: 'auth-service-8080 warm' }));
      await seedCold(
        store,
        makeMemory({ id: 'cold', stub: 'auth-service-8080 cold', embedding: vec(1, 2, 3, 4) }),
      );
      await store.forget(TG, 'warm');
      await store.forget(TG, 'cold');
      expect(await store.get(TG, 'warm')).toBeNull();
      expect(await store.get(TG, 'cold')).toBeNull();
      expect(await store.coldGet(TG, 'cold')).toBeNull();
      expect(await store.lexical(localGrant(LOCAL), 'auth-service-8080', 10)).toEqual([]);
      expect(await store.list(localGrant(LOCAL), { validOnly: false })).toEqual([]);
      await expect(store.forget(TG, 'never-existed')).resolves.toBeUndefined();
    });

    it('list-valid-only-default', async () => {
      await store.upsert(
        TG,
        makeMemory({ id: 'old', updatedAt: '2026-11-01T00:00:00.000Z', tier: 'hot' }),
      );
      await store.upsert(
        TG,
        makeMemory({
          id: 'superseded',
          updatedAt: '2026-11-02T00:00:00.000Z',
          validTo: '2026-11-02T00:00:00.000Z',
        }),
      );
      await store.upsert(TG, makeMemory({ id: 'new', updatedAt: '2026-11-03T00:00:00.000Z' }));
      expect(ids(await store.list(localGrant(LOCAL)))).toEqual(['new', 'old']);
      expect(ids(await store.list(localGrant(LOCAL), { validOnly: false }))).toEqual([
        'new',
        'superseded',
        'old',
      ]);
      expect(ids(await store.list(localGrant(LOCAL), { tier: 'hot' }))).toEqual(['old']);
    });

    it('list-valid-only-uses-isCurrent', async () => {
      await store.upsert(TG, makeMemory({ id: 'future', validTo: '2999-01-01T00:00:00.000Z' }));
      await store.upsert(
        TG,
        makeMemory({
          id: 'past',
          validFrom: '2000-01-01T00:00:00.000Z',
          validTo: '2000-06-01T00:00:00.000Z',
        }),
      );
      await store.upsert(
        TG,
        makeMemory({ id: 'expired', expiredAt: '2026-11-01T00:00:00.000Z', endReason: 'expired' }),
      );
      expect(ids(await store.list(localGrant(LOCAL))).sort()).toEqual(['future']);
      expect(ids(await store.list(localGrant(LOCAL), { validOnly: false })).sort()).toEqual([
        'expired',
        'future',
        'past',
      ]);
    });

    it('close-is-idempotent', async () => {
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
    });

    it('rejects-after-close', async () => {
      const m = makeMemory({ id: 'm1', embedding: vec(1, 2, 3, 4) });
      await store.upsert(TG, m);
      await store.close();
      const calls: [string, () => Promise<unknown>][] = [
        ['upsert', () => store.upsert(TG, m)],
        ['upsertMany', () => store.upsertMany(TG, [m])],
        ['get', () => store.get(TG, 'm1')],
        ['forget', () => store.forget(TG, 'm1')],
        ['lexical', () => store.lexical(localGrant(LOCAL), 'memory', 10)],
        ['dense', () => store.dense(localGrant(LOCAL), vec(1, 2, 3, 4), 10)],
        ['recordAccess', () => store.recordAccess(TG, ['m1'], new Date())],
        ['list', () => store.list(localGrant(LOCAL))],
        ['coldPut', () => store.coldPut(TG, m)],
        ['coldPutMany', () => store.coldPutMany(TG, [m])],
        ['coldGet', () => store.coldGet(TG, 'm1')],
        ['expireMany', () => store.expireMany(TG, [m], new Date())],
        ['setTier', () => store.setTier(TG, 'm1', 'hot')],
        ['getCursor', () => store.getCursor(TG, 'k')],
        ['setCursor', () => store.setCursor(TG, 'k', 'v')],
      ];
      for (const [method, call] of calls) {
        const outcome = await call().then(
          () => 'resolved',
          () => 'rejected',
        );
        expect(`${method}: ${outcome}`).toBe(`${method}: rejected`);
      }
    });
  });

  describe(`store isolation v2: ${name}`, () => {
    it('isolation.every-method-every-other-scope', async () => {
      expect(await isolationViolations(make)).toEqual([]);
    });

    // Per-commit budget; OORT_ISOLATION_SEEDS raises it for a nightly run.
    const seeds = Number(process.env['OORT_ISOLATION_SEEDS'] ?? 12);
    it(`isolation.non-interference-${seeds}-seeds`, async () => {
      for (let seed = 1; seed <= seeds; seed++) {
        expect(await nonInterference(make, seed, 60)).toBeNull();
      }
    }, 120_000);
  });
}
