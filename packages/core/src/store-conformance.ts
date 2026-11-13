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
import {
  addressed,
  addressOf,
  authorOf,
  canonicalMemory,
  GALAXY_ROOT,
  nodeOf,
  type Address,
  type Author,
  type NodeRef,
  type Provenance,
} from './address.js';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import { GrantError, localGrant, nodeGrant, principalGrant, type Grant } from './grant.js';
import type { Memory, Scope } from './model.js';
import type { NearQuery, Place, SpatialFilter } from './place.js';
import { localScope } from './scope.js';
import { isolationViolations, nonInterference } from './isolation.js';
import type { LinksProbe } from './links.js';

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

    it('temporal-fields-roundtrip', async () => {
      // CON-34/49: confirmation, correction and the new decision stages survive a round trip.
      const m = makeMemory({
        id: 't1',
        text: 'auth listens on port 3000',
        embedding: vec(1, 2, 3, 4),
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-02-01T00:00:00.000Z',
        expiredAt: '2026-01-15T00:00:00.000Z',
        endReason: 'corrected',
        lastConfirmedAt: '2026-01-10T08:30:00.000Z',
        supersededBy: 't2',
        source: {
          harness: 'test',
          turnRef: 'turn-9',
          decisions: [
            { stage: 'gate', question: 'volatile', answer: 'yes', probability: 0.8 },
            {
              stage: 'temporal',
              question: 'interval',
              answer: 'turn .. 2026-02-01',
              probability: 1,
            },
            {
              stage: 'temporal',
              question: 'writer-date',
              answer: '2026-01-02 -> 2026-01-03',
              probability: 1,
            },
            {
              stage: 'refine',
              question: 'previous-text',
              answer: 'auth on 3000',
              probability: 0.7,
            },
            { stage: 'write', question: 'action', answer: 'CORRECT', probability: 0.9 },
          ],
        },
      });
      await store.upsert(TG, m);
      expect(await store.get(TG, 't1')).toEqual(m);
    });

    it('refine-in-place-of-a-cold-record-stays-consistent', async () => {
      // A REFINE rewrites a cold memory in place and promotes it: the cold copy goes, so a later
      // hydration cannot bring the old wording back.
      const m = makeMemory({ id: 'r1', text: 'auth on port 3000', embedding: vec(1, 2, 3, 4) });
      await seedCold(store, m);
      const cold = await store.get(TG, 'r1');
      if (cold === null) throw new Error('coldPut lost the main record');
      expect(cold.tier).toBe('cold');
      const refined: Memory = {
        ...cold,
        text: 'auth on port 3000 over TLS',
        stub: 'auth port TLS',
        embedding: vec(4, 3, 2, 1),
        tier: 'warm',
        lastConfirmedAt: '2026-01-10T00:00:00.000Z',
        updatedAt: '2026-01-10T00:00:00.000Z',
      };
      await store.upsert(TG, refined);
      expect(await store.get(TG, 'r1')).toEqual(refined);
      expect(await store.coldGet(TG, 'r1')).toBeNull();
      expect((await store.lexical(TG, 'TLS', 5)).map((h) => h.id)).toEqual(['r1']);
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

    it('upsert-many-if-unchanged-skips-a-changed-record (CON-144)', async () => {
      if (store.upsertManyIfUnchanged === undefined) return;
      const a = makeMemory({ id: 'a', text: 'old a', updatedAt: '2026-01-01T00:00:00.000Z' });
      const b = makeMemory({ id: 'b', text: 'old b', updatedAt: '2026-01-01T00:00:00.000Z' });
      await store.upsertMany(TG, [a, b]);
      // Another writer changes b after the snapshot was taken.
      await store.upsert(TG, { ...b, text: 'changed b', updatedAt: '2026-01-02T00:00:00.000Z' });
      const r = await store.upsertManyIfUnchanged(TG, [
        { next: { ...a, text: 'new a' }, was: a },
        { next: { ...b, text: 'new b' }, was: b },
        { next: makeMemory({ id: 'gone' }), was: makeMemory({ id: 'gone' }) },
      ]);
      expect(r.skipped.sort()).toEqual(['b', 'gone']);
      expect((await store.get(TG, 'a'))?.text).toBe('new a');
      expect((await store.get(TG, 'b'))?.text).toBe('changed b');
      expect(await store.get(TG, 'gone')).toBeNull();
      // Outside the grant reads as missing: skipped, never a GrantError.
      const none = localGrant({ ...LOCAL, projectIds: [] });
      const out = await store.upsertManyIfUnchanged(none, [
        { next: { ...a, text: 'hijack' }, was: a },
      ]);
      expect(out.skipped).toEqual(['a']);
      expect((await store.get(TG, 'a'))?.text).toBe('new a');
    });

    it('dense-zero-vector-matches-nothing (CON-141)', async () => {
      await store.upsert(TG, makeMemory({ id: 'x', embedding: vec(100, 0, 0, 0) }));
      await store.upsert(TG, makeMemory({ id: 'zero', embedding: vec(0, 0, 0, 0) }));
      // Not kept: the memory is stored without a vector.
      expect((await store.get(TG, 'zero'))?.embedding).toBeUndefined();
      expect(ids(await store.dense(localGrant(LOCAL), vec(0, 100, 0, 0), 10))).toEqual(['x']);
      expect(await store.dense(localGrant(LOCAL), vec(0, 0, 0, 0), 10)).toEqual([]);
    });

    it('scope-excludes-other-org-customer-agent', async () => {
      const text = 'Deploys go through auth-service-8080';
      const embedding = vec(1, 1, 1, 1);
      const others = {
        'other-org': { ...localScope(), orgId: 'another-org' },
        'other-customer': { ...localScope(), customerId: 'someone-else' },
      };
      await store.upsert(TG, makeMemory({ id: 'mine', text, embedding }));
      for (const [id, scope] of Object.entries(others)) {
        await store.upsert(grantFor(scope), makeMemory({ id, text, embedding, scope }));
      }
      // Another agent's Star is private to it (CON-62).
      const star: NodeRef = { level: 'agent', orgId: 'local', agentId: 'another-agent' };
      await store.upsert(
        nodesGrant(star),
        memoryAt('other-agent', star as Address, { agentId: 'another-agent' }, { text, embedding }),
      );
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

    it('list-pinned-only-and-without-embeddings', async () => {
      await store.upsert(TG, makeMemory({ id: 'pin', pinned: true, embedding: vec(1, 2, 3, 4) }));
      await store.upsert(TG, makeMemory({ id: 'hot', tier: 'hot', embedding: vec(1, 2, 3, 4) }));
      await store.upsert(TG, makeMemory({ id: 'plain', embedding: vec(1, 2, 3, 4) }));
      expect(ids(await store.list(localGrant(LOCAL), { pinned: true }))).toEqual(['pin']);
      expect(ids(await store.list(localGrant(LOCAL), { pinned: true, tier: 'hot' }))).toEqual([]);
      // Callers that only read text and metadata (SessionStart) skip the embedding fetch.
      const bare = await store.list(localGrant(LOCAL), { embeddings: false });
      expect(bare).toHaveLength(3);
      for (const m of bare) expect(m.embedding).toBeUndefined();
      const full = await store.list(localGrant(LOCAL), { tier: 'hot' });
      expect(full[0]?.embedding).toEqual(vec(1, 2, 3, 4));
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

    it(`isolation.non-interference-multi-node-${seeds}-seeds`, async () => {
      for (let seed = 1; seed <= seeds; seed++) {
        expect(await nonInterference(make, seed, 60, { multiNode: true })).toBeNull();
      }
    }, 120_000);

    it(`isolation.non-interference-peer-agents-${seeds}-seeds`, async () => {
      // CON-62: another agent of the same person, working in its own Star, never reaches mine.
      for (let seed = 1; seed <= seeds; seed++) {
        expect(await nonInterference(make, seed, 60, { peers: true })).toBeNull();
      }
    }, 120_000);
  });

  levelConformance(name, make);
}

/** The owner every level case belongs to or reads as: the local principal. */
const OWNER = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };

/**
 * The grant every local caller had before CON-62: the owner's Planet, restricted to memories its
 * own agent wrote. Kept to prove data written before levels reads back unchanged.
 */
const PRE_LEVEL: Grant = nodeGrant({
  principal: OWNER,
  read: [
    {
      node: { level: 'user', orgId: 'local', customerId: 'self' },
      projectIds: 'all',
      authorAgentId: 'claude-code',
    },
  ],
});

const PROVENANCE: Provenance = {
  derivedFrom: [{ vault: 'acct:1', memoryId: 'src-1' }],
  contributors: [
    {
      memberRef: 'mem-1',
      agentId: 'claude-code',
      at: '2026-11-01T00:00:00.000Z',
      action: 'asserted',
    },
  ],
  support: { members: 1, agents: 1 },
  gate: { policyVersion: 'p1', mode: 'confirmed' },
};

/** One memory per level (and a Planet memory by another agent), each with a distinct embedding. */
export const LEVEL_CASES: {
  name: string;
  address: Address;
  author: Author;
  provenance?: Provenance;
}[] = [
  {
    name: 'planet-other-author',
    address: { level: 'user', orgId: 'local', customerId: 'self', projectId: 'p1' },
    author: { agentId: 'cursor' },
  },
  {
    name: 'star',
    address: { level: 'agent', orgId: 'local', agentId: 'cursor', projectId: 'p1' },
    author: { agentId: 'cursor' },
  },
  {
    name: 'orbit',
    address: {
      level: 'agent-user',
      orgId: 'org:acme',
      agentId: 'support-bot',
      customerId: 'end-user-1',
    },
    author: { agentId: 'support-bot' },
  },
  {
    name: 'flyby',
    address: {
      level: 'run',
      orgId: 'local',
      agentId: 'claude-code',
      runId: 'run-1',
      customerId: 'self',
    },
    author: { agentId: 'claude-code' },
  },
  {
    name: 'flyby-no-customer',
    address: { level: 'run', orgId: 'local', agentId: 'claude-code', runId: 'run-2' },
    author: { agentId: 'claude-code' },
  },
  {
    name: 'constellation',
    address: { level: 'hive', orgId: 'org:acme', hiveId: 'checkout', projectId: 'p1' },
    author: { agentId: 'claude-code', accountRef: 'acct:1' },
    provenance: PROVENANCE,
  },
  {
    name: 'galaxy',
    address: { level: 'hive', orgId: 'org:acme', hiveId: GALAXY_ROOT },
    author: { agentId: 'claude-code' },
  },
];

/** A memory at `address` by `author` (scope filled to match). */
export function memoryAt(
  id: string,
  address: Address,
  author: Author,
  overrides: Partial<Memory> = {},
): Memory {
  return makeMemory({ id, ...addressed(address, author), ...overrides });
}

/** Read and write every project of `nodes` (no author restriction). */
export function nodesGrant(...nodes: NodeRef[]): Grant {
  return nodeGrant({
    principal: OWNER,
    read: nodes.map((node) => ({ node, projectIds: 'all' as const })),
  });
}

function render(m: Memory | null): string {
  return m === null
    ? 'null'
    : JSON.stringify({ ...m, embedding: m.embedding === undefined ? null : [...m.embedding] });
}

/**
 * Levels (CON-61): every address round-trips, illegal ones are refused, grants
 * over node sets see exactly their nodes, and memories written before levels
 * (and every pre-level grant) behave exactly as they did.
 */
function levelConformance(name: string, make: () => Promise<MemoryStore>): void {
  describe(`store levels: ${name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await make();
    });

    afterEach(async () => {
      await store.close();
    });

    const cases = () =>
      LEVEL_CASES.map((c, i) => {
        const m = memoryAt(`lv-${c.name}`, c.address, c.author, {
          text: `levelprobe ${c.name} text`,
          stub: `levelprobe ${c.name}`,
          embedding: vec(i + 1, 1, -1, 2),
          ...(c.provenance !== undefined && { provenance: c.provenance }),
        });
        return { ...c, m, g: nodesGrant(nodeOf(c.address)) };
      });

    it('levels.planet-memories-keep-their-shape', async () => {
      const m = makeMemory({ id: 'legacy', scope: localScope('p1'), embedding: vec(1, 2, 3, 4) });
      await store.upsert(TG, m);
      const got = await store.get(TG, 'legacy');
      expect(got).toEqual(m);
      expect(got !== null && ('address' in got || 'author' in got || 'provenance' in got)).toBe(
        false,
      );
      expect(addressOf(got as Memory)).toEqual({
        level: 'user',
        orgId: 'local',
        customerId: 'self',
        projectId: 'p1',
      });
      expect(authorOf(got as Memory)).toEqual({ agentId: 'claude-code' });
    });

    it('levels.judgment-roundtrips', async () => {
      // CON-71: a judgment memory keeps its `judgment` record exactly, cold copy included.
      const m = makeMemory({
        id: 'judgment-1',
        scope: localScope(undefined),
        type: 'judgment',
        pinned: true,
        embedding: vec(4, 3, 2, 1),
        judgment: {
          subject: { summary: 'Post claims a cure', ref: 'https://example.test/p/1' },
          verdict: 'rejected',
          verdicts: ['approved', 'rejected'],
          reason: 'No cited source.\nSecond line, verbatim.',
          criteria: ['no-source'],
          domain: 'content',
          by: 'ada',
          decidedAt: '2026-01-01T00:00:00.000Z',
          via: 'cli',
          withdrawn: { at: '2026-02-01T00:00:00.000Z', by: 'ada' },
        },
      });
      await store.upsert(TG, m);
      expect(await store.get(TG, 'judgment-1')).toEqual(m);
      const plain = makeMemory({ id: 'plain-1', scope: localScope(undefined) });
      await store.upsert(TG, plain);
      expect('judgment' in ((await store.get(TG, 'plain-1')) as Memory)).toBe(false);
      expect((await store.coldPut(TG, m)).skipped).toEqual([]);
      expect(await store.coldGet(TG, 'judgment-1')).toEqual(m);
    });

    it('levels.every-level-roundtrips', async () => {
      for (const c of cases()) {
        await store.upsert(c.g, c.m);
        const got = await store.get(c.g, c.m.id);
        expect(got, c.name).toEqual(canonicalMemory(c.m));
        expect(addressOf(got as Memory), c.name).toEqual(c.address);
        expect(authorOf(got as Memory), c.name).toEqual(c.author);
        expect(got?.provenance ?? null, c.name).toEqual(c.provenance ?? null);
        expect(ids(await store.list(c.g)), c.name).toEqual([c.m.id]);
        expect(ids(await store.lexical(c.g, 'levelprobe', 10)), c.name).toEqual([c.m.id]);
        expect(ids(await store.dense(c.g, c.m.embedding as Int8Array, 10)), c.name).toEqual([
          c.m.id,
        ]);
        const snapshot = (await store.get(c.g, c.m.id)) as Memory;
        expect((await store.coldPut(c.g, snapshot)).skipped, c.name).toEqual([]);
        expect(await store.coldGet(c.g, c.m.id), c.name).toEqual(canonicalMemory(snapshot));
        expect((await store.get(c.g, c.m.id))?.tier, c.name).toBe('cold');
      }
    });

    it('levels.pre-level-grants-see-no-other-level', async () => {
      for (const c of cases()) await store.upsert(c.g, c.m);
      for (const c of cases()) expect(await store.get(PRE_LEVEL, c.m.id), c.name).toBeNull();
      expect(await store.list(PRE_LEVEL, { validOnly: false })).toEqual([]);
      expect(await store.lexical(PRE_LEVEL, 'levelprobe', 50)).toEqual([]);
      expect(await store.dense(PRE_LEVEL, vec(1, 1, -1, 2), 50)).toEqual([]);
    });

    it('levels.local-grants-see-the-planet-and-their-own-star', async () => {
      // CON-62: a person's agents share the Planet; each agent's Star is its own.
      for (const c of cases()) await store.upsert(c.g, c.m);
      const ccStar: Address = { level: 'agent', orgId: 'local', agentId: 'claude-code' };
      await store.upsert(
        nodesGrant(ccStar),
        memoryAt('cc-star', ccStar, { agentId: 'claude-code' }, { text: 'levelprobe cc star' }),
      );
      const asClaude = [TG, localGrant({ ...OWNER, projectIds: ['p1', null] })];
      for (const g of asClaude) {
        expect(ids(await store.list(g, { validOnly: false })).sort()).toEqual([
          'cc-star',
          'lv-planet-other-author',
        ]);
        expect(ids(await store.lexical(g, 'levelprobe', 50)).sort()).toEqual([
          'cc-star',
          'lv-planet-other-author',
        ]);
        expect(await store.get(g, 'lv-star')).toBeNull();
        expect(await store.setTier(g, 'lv-star', 'hot')).toBe(false);
      }
      const asCursor = localGrant({ ...OWNER, agentId: 'cursor', projectIds: ['p1', null] });
      expect(ids(await store.list(asCursor, { validOnly: false })).sort()).toEqual([
        'lv-planet-other-author',
        'lv-star',
      ]);
      expect(await store.get(asCursor, 'cc-star')).toBeNull();
      expect(ids(await store.dense(asCursor, vec(2, 1, -1, 2), 50))).not.toContain('cc-star');
    });

    it('levels.existing-data-unchanged', async () => {
      const legacy = [
        makeMemory({ id: 'old-1', text: 'levelprobe orbit one', embedding: vec(1, 1, -1, 2) }),
        makeMemory({
          id: 'old-2',
          text: 'levelprobe orbit two',
          scope: localScope('p1'),
          embedding: vec(2, 1, -1, 2),
          pinned: true,
        }),
        makeMemory({ id: 'old-3', text: 'levelprobe orbit three', scope: localScope('p2') }),
      ];
      await store.upsertMany(TG, legacy);
      await seedCold(
        store,
        makeMemory({ id: 'old-4', text: 'levelprobe cold', embedding: vec(3, 1, -1, 2) }),
      );
      const g = PRE_LEVEL;
      const view = async () => {
        const out: string[] = [];
        for (const id of ['old-1', 'old-2', 'old-3', 'old-4']) {
          out.push(render(await store.get(g, id)), render(await store.coldGet(g, id)));
        }
        out.push((await store.list(g, { validOnly: false })).map(render).join('|'));
        out.push(JSON.stringify(await store.dense(g, vec(1, 1, -1, 2), 10)));
        // bm25 scores use table-wide statistics: compare which memories match.
        out.push(
          ids(await store.lexical(g, 'levelprobe orbit', 50))
            .sort()
            .join(','),
        );
        return out;
      };
      const before = await view();
      for (const c of cases()) await store.upsert(c.g, c.m);
      expect(await view()).toEqual(before);
    });

    it('levels.illegal-addresses-are-refused', async () => {
      const bad: [string, Partial<Memory>][] = [
        [
          'planet without customer',
          { address: { level: 'user', orgId: 'local' } as unknown as Address },
        ],
        [
          'constellation with a customer',
          {
            address: {
              level: 'hive',
              orgId: 'o',
              hiveId: 'h',
              customerId: 'c',
            } as unknown as Address,
          },
        ],
        [
          'star with a customer',
          {
            address: {
              level: 'agent',
              orgId: 'o',
              agentId: 'a',
              customerId: 'c',
            } as unknown as Address,
          },
        ],
        [
          'flyby without run',
          { address: { level: 'run', orgId: 'o', agentId: 'a' } as unknown as Address },
        ],
        ['unknown level', { address: { level: 'team', orgId: 'o' } as unknown as Address }],
        ['empty owner', { address: { level: 'hive', orgId: '', hiveId: 'h' } }],
        [
          'unknown field',
          { address: { level: 'hive', orgId: 'o', hiveId: 'h', extra: 1 } as unknown as Address },
        ],
        ['empty author', { author: { agentId: '' } }],
        [
          'scope that is not the address',
          { address: { level: 'agent', orgId: 'local', agentId: 'cursor' }, scope: localScope() },
        ],
      ];
      const all = nodesGrant(
        { level: 'user', orgId: 'local', customerId: 'self' },
        { level: 'hive', orgId: 'o', hiveId: 'h' },
        { level: 'agent', orgId: 'local', agentId: 'cursor' },
      );
      for (const [what, overrides] of bad) {
        const m = makeMemory({ id: 'bad', ...overrides });
        await expect(store.upsert(all, m), what).rejects.toThrow(RangeError);
        const ok = makeMemory({ id: 'ok' });
        await expect(store.upsertMany(all, [ok, m]), what).rejects.toThrow(RangeError);
        expect(await store.get(all, 'ok'), what).toBeNull();
        expect(await store.get(all, 'bad'), what).toBeNull();
      }
    });

    it('levels.address-and-author-are-fixed-per-id', async () => {
      const [star, hive] = [LEVEL_CASES[1], LEVEL_CASES[5]] as const;
      const g = nodesGrant(nodeOf(star!.address), nodeOf(hive!.address));
      const m = memoryAt('fixed', star!.address, star!.author);
      await store.upsert(g, m);
      const moved = memoryAt('fixed', hive!.address, hive!.author);
      await expect(store.upsert(g, moved)).rejects.toThrow(GrantError);
      const reauthored = memoryAt('fixed', star!.address, {
        agentId: 'cursor',
        accountRef: 'acct:2',
      });
      await expect(store.upsert(g, reauthored)).rejects.toThrow(GrantError);
      expect(await store.get(g, 'fixed')).toEqual(canonicalMemory(m));
    });

    it('levels.author-restriction-is-exact', async () => {
      const planet: NodeRef = { level: 'user', orgId: 'local', customerId: 'self' };
      const mine = makeMemory({ id: 'by-cc', text: 'authorprobe one' });
      const theirs = memoryAt(
        'by-cursor',
        { level: 'user', orgId: 'local', customerId: 'self' },
        { agentId: 'cursor' },
        { text: 'authorprobe two' },
      );
      const everyone = nodesGrant(planet);
      await store.upsertMany(everyone, [mine, theirs]);
      expect(ids(await store.lexical(everyone, 'authorprobe', 10)).sort()).toEqual([
        'by-cc',
        'by-cursor',
      ]);
      expect(ids(await store.lexical(PRE_LEVEL, 'authorprobe', 10))).toEqual(['by-cc']);
      // The local grant shares the Planet among the person's agents (CON-62).
      expect(ids(await store.lexical(TG, 'authorprobe', 10)).sort()).toEqual([
        'by-cc',
        'by-cursor',
      ]);
      const cursor = nodeGrant({
        principal: { ...OWNER, agentId: 'cursor' },
        read: [{ node: planet, projectIds: 'all', authorAgentId: 'cursor' }],
      });
      expect(ids(await store.lexical(cursor, 'authorprobe', 10))).toEqual(['by-cursor']);
      expect(await store.get(cursor, 'by-cc')).toBeNull();
    });

    it('levels.multi-node-grant-reads-across-owners', async () => {
      const all = cases();
      for (const c of all) await store.upsert(c.g, c.m);
      const own = makeMemory({ id: 'own', text: 'levelprobe own', embedding: vec(9, 1, -1, 2) });
      await store.upsert(TG, own);
      const hive = all.find((c) => c.name === 'constellation')!;
      const galaxy = all.find((c) => c.name === 'galaxy')!;
      const star = all.find((c) => c.name === 'star')!;
      // My Planet (as before levels) plus a Constellation of another owner, read-only.
      const g = nodeGrant({
        principal: OWNER,
        read: [...TG.readNodes, { node: nodeOf(hive.address), projectIds: ['p1'] }],
        write: TG.writeNodes,
      });
      const other = all.find((c) => c.name === 'planet-other-author')!;
      const visible = ['own', other.m.id, hive.m.id].sort();
      expect(ids(await store.list(g, { validOnly: false })).sort()).toEqual(visible);
      expect(ids(await store.lexical(g, 'levelprobe', 50)).sort()).toEqual(visible);
      const dense = await store.dense(g, vec(9, 1, -1, 2), 50);
      expect(ids(dense).sort()).toEqual(visible);
      expect(dense.map((h) => h.score)).toEqual(dense.map((h) => h.score).sort((a, b) => b - a));
      expect(ids(await store.dense(g, vec(9, 1, -1, 2), 1))).toEqual(['own']);
      expect(await store.get(g, hive.m.id)).toEqual(canonicalMemory(hive.m));
      for (const c of [galaxy, star]) expect(await store.get(g, c.m.id)).toBeNull();
      // The hive side is read-only.
      expect(await store.setTier(g, hive.m.id, 'hot')).toBe(false);
      await store.forget(g, hive.m.id);
      expect(await store.get(hive.g, hive.m.id)).not.toBeNull();
      await expect(
        store.upsert(g, memoryAt('new-hive', hive.address, hive.author)),
      ).rejects.toThrow(GrantError);
      // A project outside the pattern stays out.
      const hiveP2 = memoryAt(
        'hive-p2',
        { ...hive.address, projectId: 'p2' } as Address,
        hive.author,
      );
      await store.upsert(hive.g, hiveP2);
      expect(await store.get(g, 'hive-p2')).toBeNull();
    });
  });
}

/**
 * Spatial memory (CON-84): the suite a store with `spatial: true` must pass, on top of
 * `storeConformance`. A place round-trips exactly and is checked on write; `within` and `near`
 * apply inside `lexical` and `dense` before k is taken, inside the grant; memories without a place
 * are unaffected; coordinates from another map or frame are never compared.
 */
export function spatialConformance(name: string, make: () => Promise<MemoryStore>): void {
  describe(`store spatial: ${name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await make();
    });

    afterEach(async () => {
      await store.close();
    });

    const G = () => localGrant(LOCAL);
    const text = 'the red toolbox is here';
    const embedding = vec(10, 10, 10, 10);
    const at = (id: string, place: Place | undefined, extra: Partial<Memory> = {}): Memory =>
      makeMemory({ id, text, stub: `toolbox ${id}`, embedding, ...(place && { place }), ...extra });
    const near = (x: number, y: number, radius: number, extra: Partial<NearQuery> = {}) => ({
      near: { mapId: 'hq', pose: { x, y }, radius, ...extra },
    });
    const both = async (f: SpatialFilter, k = 50): Promise<[string[], string[]]> => [
      ids(await store.lexical(G(), 'toolbox', k, { spatial: f })).sort(),
      ids(await store.dense(G(), embedding, k, { spatial: f })).sort(),
    ];

    it('spatial.store-says-it-filters', () => {
      expect(store.spatial).toBe(true);
    });

    it('spatial.place-roundtrips-exactly', async () => {
      const place: Place = {
        nodeId: 'site:hq/floor:2/room:B/shelf:B3',
        mapId: 'hq',
        mapVersion: 7,
        frame: 'map',
        pose: { x: 4.25, y: -1.5, z: 0.9, yaw: 1.57 },
        extent: { dx: 1.2, dy: 0.4, dz: 0.3 },
        geo: { lat: 59.33, lon: 18.06, alt: 12 },
        sigma: 0.05,
      };
      const m = at('p', place);
      await store.upsert(TG, m);
      expect(await store.get(TG, 'p')).toEqual(m);
      expect((await store.list(TG))[0]?.place).toEqual(place);
      // Rewritten without a place, it has none, and no filter finds it.
      await store.upsert(TG, at('p', undefined));
      expect((await store.get(TG, 'p'))?.place).toBeUndefined();
      expect(await both({ within: 'room:B' })).toEqual([[], []]);
      expect(await both(near(4, -1, 5))).toEqual([[], []]);
    });

    it('spatial.place-is-checked-on-write', async () => {
      const bad = {
        ...at('bad', undefined),
        place: { mapId: 'hq', pose: { x: Number.NaN, y: 1 } },
      };
      await expect(store.upsert(TG, bad as Memory)).rejects.toThrow(RangeError);
      await expect(
        store.upsertMany(TG, [at('ok', { nodeId: 'a' }), bad as Memory]),
      ).rejects.toThrow(RangeError);
      expect(await store.get(TG, 'bad')).toBeNull();
      expect(await store.get(TG, 'ok')).toBeNull();
    });

    it('spatial.within-keeps-whole-segments-and-what-is-below', async () => {
      await store.upsert(TG, at('a', { nodeId: 'site:hq/room:A' }));
      await store.upsert(TG, at('b', { nodeId: 'site:hq/room:B' }));
      await store.upsert(TG, at('b3', { nodeId: 'site:hq/room:B/shelf:B3' }));
      await store.upsert(TG, at('b2', { nodeId: 'site:hq/room:B2' }));
      await store.upsert(TG, at('bare', undefined));
      expect(await both({ within: 'room:B' })).toEqual([
        ['b', 'b3'],
        ['b', 'b3'],
      ]);
      expect(await both({ within: 'room:B/shelf:B3' })).toEqual([['b3'], ['b3']]);
      expect(await both({ within: 'site:hq' })).toEqual([
        ['a', 'b', 'b2', 'b3'],
        ['a', 'b', 'b2', 'b3'],
      ]);
      expect(await both({ within: 'room:C' })).toEqual([[], []]);
      // Nothing that looks like a pattern is one.
      expect(await both({ within: 'room:%' })).toEqual([[], []]);
      expect(await both({ within: 'room:_' })).toEqual([[], []]);
    });

    it('spatial.near-keeps-the-radius-on-the-same-map-and-frame', async () => {
      await store.upsert(TG, at('origin', { mapId: 'hq', pose: { x: 0, y: 0 } }));
      await store.upsert(TG, at('three', { mapId: 'hq', pose: { x: 3, y: 0 } }));
      await store.upsert(TG, at('ten', { mapId: 'hq', pose: { x: 10, y: 0 } }));
      await store.upsert(
        TG,
        at('room', { mapId: 'hq', pose: { x: 20, y: 0 }, extent: { dx: 8, dy: 8 } }),
      );
      await store.upsert(TG, at('lab', { mapId: 'lab', pose: { x: 0, y: 0 } }));
      await store.upsert(TG, at('utm', { mapId: 'hq', frame: 'utm', pose: { x: 0, y: 0 } }));
      await store.upsert(TG, at('named', { nodeId: 'room:B' }));
      await store.upsert(TG, at('bare', undefined));
      expect(await both(near(0, 0, 1))).toEqual([['origin'], ['origin']]);
      expect(await both(near(0, 0, 3))).toEqual([
        ['origin', 'three'],
        ['origin', 'three'],
      ]);
      // The region counts, not its centre: 15 is 1 m from a box spanning 16 to 24.
      expect(await both(near(15, 0, 1.5))).toEqual([['room'], ['room']]);
      expect(await both(near(0, 0, 1, { mapId: 'lab' }))).toEqual([['lab'], ['lab']]);
      expect(await both(near(0, 0, 1, { frame: 'utm' }))).toEqual([['utm'], ['utm']]);
      expect(await both(near(0, 0, 1000, { mapId: 'elsewhere' }))).toEqual([[], []]);
    });

    it('spatial.z-counts-when-both-have-it', async () => {
      await store.upsert(TG, at('floor', { mapId: 'hq', pose: { x: 0, y: 0, z: 0 } }));
      await store.upsert(TG, at('shelf', { mapId: 'hq', pose: { x: 0, y: 0, z: 2 } }));
      await store.upsert(TG, at('flat', { mapId: 'hq', pose: { x: 0, y: 0 } }));
      expect(await both(near(0, 0, 0.5, { pose: { x: 0, y: 0, z: 2 } }))).toEqual([
        ['flat', 'shelf'],
        ['flat', 'shelf'],
      ]);
      expect(await both(near(0, 0, 0.5))).toEqual([
        ['flat', 'floor', 'shelf'],
        ['flat', 'floor', 'shelf'],
      ]);
    });

    it('spatial.both-filters-must-hold', async () => {
      await store.upsert(TG, at('bnear', { nodeId: 'room:B', mapId: 'hq', pose: { x: 1, y: 0 } }));
      await store.upsert(TG, at('bfar', { nodeId: 'room:B', mapId: 'hq', pose: { x: 9, y: 0 } }));
      await store.upsert(TG, at('anear', { nodeId: 'room:A', mapId: 'hq', pose: { x: 1, y: 1 } }));
      expect(await both({ within: 'room:B', ...near(0, 0, 2) })).toEqual([['bnear'], ['bnear']]);
    });

    it('spatial.memories-without-a-place-are-unaffected', async () => {
      await store.upsert(TG, at('placed', { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } }));
      await store.upsert(TG, at('bare', undefined));
      const all = [
        ids(await store.lexical(G(), 'toolbox', 10)).sort(),
        ids(await store.dense(G(), embedding, 10)).sort(),
      ];
      expect(all).toEqual([
        ['bare', 'placed'],
        ['bare', 'placed'],
      ]);
      expect(await both({})).toEqual(all);
    });

    it('spatial.k-is-taken-after-the-filter', async () => {
      // Twenty better matches outside the region must not crowd out the one inside it.
      for (let i = 0; i < 20; i++) {
        await store.upsert(
          TG,
          makeMemory({
            id: `out${i}`,
            text: 'toolbox toolbox toolbox',
            stub: 'toolbox',
            entities: ['toolbox'],
            embedding,
            place: { nodeId: 'room:A', mapId: 'hq', pose: { x: 50 + i, y: 0 } },
          }),
        );
      }
      await store.upsert(
        TG,
        makeMemory({
          id: 'inside',
          text: 'a toolbox among many other unrelated words in a long sentence',
          stub: 'shelf',
          embedding: vec(10, -10, 10, -10),
          place: { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } },
        }),
      );
      expect(await both({ within: 'room:B' }, 3)).toEqual([['inside'], ['inside']]);
      expect(await both(near(0, 0, 1), 3)).toEqual([['inside'], ['inside']]);
    });

    it('spatial.the-filter-stays-inside-the-grant', async () => {
      const place: Place = { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } };
      await store.upsert(TG, at('mine', place));
      await store.upsert(TG, at('p2', place, { scope: localScope('p2') }));
      const star: NodeRef = { level: 'agent', orgId: 'local', agentId: 'another-agent' };
      await store.upsert(
        nodesGrant(star),
        memoryAt(
          'theirs',
          star as Address,
          { agentId: 'another-agent' },
          { text, embedding, place },
        ),
      );
      expect(await both({ within: 'room:B' })).toEqual([['mine'], ['mine']]);
      expect(await both(near(0, 0, 1))).toEqual([['mine'], ['mine']]);
    });

    it('spatial.cold-memories-match-by-stub-only-lexically', async () => {
      await seedCold(store, at('cold', { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } }));
      expect(await both({ within: 'room:B' })).toEqual([['cold'], []]);
      expect(await both(near(0, 0, 1))).toEqual([['cold'], []]);
      expect((await store.get(TG, 'cold'))?.place?.nodeId).toBe('room:B');
    });

    it('spatial.a-move-or-a-forget-updates-the-index', async () => {
      await store.upsert(TG, at('box', { nodeId: 'room:A', mapId: 'hq', pose: { x: 0, y: 0 } }));
      await store.upsert(TG, at('box', { nodeId: 'room:B', mapId: 'hq', pose: { x: 30, y: 0 } }));
      expect(await both(near(0, 0, 1))).toEqual([[], []]);
      expect(await both({ within: 'room:A' })).toEqual([[], []]);
      expect(await both(near(30, 0, 1))).toEqual([['box'], ['box']]);
      await store.forget(TG, 'box');
      expect(await both(near(30, 0, 1))).toEqual([[], []]);
      await store.upsert(TG, at('new', undefined));
      expect(await both(near(30, 0, 1))).toEqual([[], []]);
    });
  });
}

/**
 * Memory relationships (CON-148, design `docs/design/2026-11-12-memory-relationships.md`): the
 * suite a store with `links: true` must pass, on top of `storeConformance`. `probe` reads the
 * store's own rows, so the suite can prove that nothing of a forgotten memory is left.
 *
 * It covers `link`, `unlink` and `linksOf` (who asserted each link, blocks, the write grant on both
 * ends, the same-node and no-`hive` rules, the grant on every listed link), the cascade on
 * `forget`, an upsert that keeps links and rewrites the entity index, superseded and expired
 * memories leaving the entity index, and episode positions.
 */
export function linksConformance(
  name: string,
  make: () => Promise<MemoryStore>,
  probe: (store: MemoryStore) => LinksProbe,
): void {
  describe(`store links: ${name}`, () => {
    let store: MemoryStore;
    let rows: LinksProbe;

    beforeEach(async () => {
      store = await make();
      rows = probe(store);
    });

    afterEach(async () => {
      await store.close();
    });

    const AGENT = { assertedBy: 'agent' } as const;
    const USER = { assertedBy: 'user' } as const;
    const planet = (projectId?: string): Address => ({
      level: 'user',
      orgId: 'local',
      customerId: 'self',
      ...(projectId !== undefined && { projectId }),
    });
    const me: Author = { agentId: 'claude-code' };
    const at = (id: string, overrides: Partial<Memory> = {}, address = planet()) =>
      memoryAt(id, address, me, overrides);
    const seed = async (...ms: Memory[]) => {
      for (const m of ms) await store.upsert(TG, m);
    };
    const S = (): Required<Pick<MemoryStore, 'link' | 'unlink' | 'linksOf'>> => {
      const s = store as Required<MemoryStore>;
      return {
        link: s.link.bind(s),
        unlink: s.unlink.bind(s),
        linksOf: s.linksOf.bind(s),
      };
    };
    const listed = async (g: Grant, id: string) => {
      const l = await S().linksOf(g, id);
      return l === null
        ? null
        : {
            links: l.links.map((x) => [x.kind, x.id, x.direction, x.assertedBy ?? null]),
            blocked: l.blocked,
            hidden: l.hidden,
          };
    };
    const entitiesOf = async (id: string) =>
      (await rows.entities())
        .filter((r) => r.id === id)
        .map((r) => r.entity)
        .sort();

    it('links.store-says-it-links', () => {
      expect(store.links).toBe(true);
      expect(typeof store.link).toBe('function');
      expect(typeof store.unlink).toBe('function');
      expect(typeof store.linksOf).toBe('function');
    });

    it('links.link-lists-both-ends-with-who-asserted-it', async () => {
      await seed(at('a'), at('b'));
      expect(await S().link(TG, 'a', 'b', AGENT)).toEqual({
        linked: true,
        unblocked: false,
        assertedBy: 'agent',
      });
      expect(await listed(TG, 'a')).toEqual({
        links: [['explicit', 'b', 'both', 'agent']],
        blocked: [],
        hidden: 0,
      });
      expect(await listed(TG, 'b')).toEqual({
        links: [['explicit', 'a', 'both', 'agent']],
        blocked: [],
        hidden: 0,
      });
      // Stored once, whichever way round it was asked.
      expect((await S().link(TG, 'b', 'a', AGENT))?.linked).toBe(false);
      expect(await rows.links()).toEqual([
        { kind: 'explicit', a: 'a', b: 'b', assertedBy: 'agent' },
      ]);
      // A person's assertion replaces an agent's, and an agent never weakens it.
      expect(await S().link(TG, 'a', 'b', USER)).toEqual({
        linked: true,
        unblocked: false,
        assertedBy: 'user',
      });
      expect(await S().link(TG, 'b', 'a', AGENT)).toEqual({
        linked: false,
        unblocked: false,
        assertedBy: 'user',
      });
      expect((await listed(TG, 'b'))?.links).toEqual([['explicit', 'a', 'both', 'user']]);
      const [l] = (await S().linksOf(TG, 'a'))!.links;
      expect(Number.isNaN(Date.parse(l!.createdAt))).toBe(false);
    });

    it('links.refuses-exactly-as-for-a-missing-id', async () => {
      const star: Address = { level: 'agent', orgId: 'local', agentId: 'claude-code' };
      const hive: Address = { level: 'hive', orgId: 'local', hiveId: 'team' };
      await seed(at('a'), at('b'), at('p2', {}, planet('p2')));
      const both = nodesGrant(nodeOf(planet()), nodeOf(star), nodeOf(hive));
      await store.upsert(both, at('s', {}, star));
      await store.upsert(both, at('h1', {}, hive));
      await store.upsert(both, at('h2', {}, hive));
      // Reads every project of the Planet, writes only global memories.
      const narrow = nodeGrant({
        principal: OWNER,
        read: [{ node: nodeOf(planet()), projectIds: 'all' }],
        write: [{ node: nodeOf(planet()), projectIds: [null] }],
      });
      const refused: [Grant, string, string][] = [
        [TG, 'a', 'nope'],
        [TG, 'nope', 'a'],
        [TG, 'a', 'a'],
        [narrow, 'a', 'p2'], // p2 is read, not written
        [both, 'a', 's'], // two nodes: the Planet and a Star
        [both, 'h1', 'h2'], // a hive node
      ];
      for (const [g, x, y] of refused) {
        expect(await S().link(g, x, y, USER)).toBeNull();
        expect(await S().unlink(g, x, y, USER)).toBeNull();
      }
      expect(await rows.links()).toEqual([]);
      // The narrow grant can link the two it writes.
      expect((await S().link(narrow, 'a', 'b', AGENT))?.linked).toBe(true);
    });

    it('links.unlink-removes-the-link', async () => {
      await seed(at('a'), at('b'));
      await S().link(TG, 'a', 'b', AGENT);
      expect(await S().unlink(TG, 'b', 'a', AGENT)).toEqual({ removed: true, blocked: false });
      expect(await listed(TG, 'a')).toEqual({ links: [], blocked: [], hidden: 0 });
      expect(await rows.links()).toEqual([]);
    });

    it('links.unlinking-an-unlinked-pair-blocks-it-and-linking-it-unblocks', async () => {
      await seed(at('a'), at('b'));
      expect(await S().unlink(TG, 'a', 'b', USER)).toEqual({ removed: false, blocked: true });
      expect(await listed(TG, 'a')).toEqual({ links: [], blocked: ['b'], hidden: 0 });
      expect(await listed(TG, 'b')).toEqual({ links: [], blocked: ['a'], hidden: 0 });
      expect(await rows.links()).toEqual([{ kind: 'blocked', a: 'a', b: 'b', assertedBy: 'user' }]);
      // Again: still one block.
      expect(await S().unlink(TG, 'b', 'a', AGENT)).toEqual({ removed: false, blocked: true });
      expect(await rows.links()).toHaveLength(1);
      expect(await S().link(TG, 'b', 'a', AGENT)).toEqual({
        linked: true,
        unblocked: true,
        assertedBy: 'agent',
      });
      expect(await listed(TG, 'a')).toEqual({
        links: [['explicit', 'b', 'both', 'agent']],
        blocked: [],
        hidden: 0,
      });
    });

    it('links.unlink-blocks-a-pair-an-index-forms', async () => {
      // A shared entity (`about`) or session (`episode`) would bring the pair back: blocked too.
      await seed(
        at('a', { entities: ['payments-db'] }),
        at('b', { entities: ['Payments-DB'] }),
        at('c', { source: { harness: 'test', sessionId: 's1', decisions: [] } }),
        at('d', { source: { harness: 'test', sessionId: 's1', decisions: [] } }),
      );
      await S().link(TG, 'a', 'b', USER);
      await S().link(TG, 'c', 'd', USER);
      expect(await S().unlink(TG, 'a', 'b', USER)).toEqual({ removed: true, blocked: true });
      expect(await S().unlink(TG, 'c', 'd', USER)).toEqual({ removed: true, blocked: true });
      expect((await listed(TG, 'a'))?.blocked).toEqual(['b']);
      expect((await listed(TG, 'd'))?.blocked).toEqual(['c']);
    });

    it('links.forget-leaves-no-row-of-the-memory', async () => {
      await seed(
        at('a', {
          entities: ['payments-db', 'checkout'],
          source: { harness: 'test', sessionId: 's1', decisions: [] },
        }),
        at('b', { entities: ['payments-db'] }),
        at('c'),
        at('d'),
      );
      await S().link(TG, 'a', 'b', USER);
      await S().unlink(TG, 'c', 'a', AGENT); // a block
      await S().link(TG, 'c', 'd', AGENT);
      await store.forget(TG, 'a');
      expect(await listed(TG, 'b')).toEqual({ links: [], blocked: [], hidden: 0 });
      expect(await listed(TG, 'c')).toEqual({
        links: [['explicit', 'd', 'both', 'agent']],
        blocked: [],
        hidden: 0,
      });
      expect(await rows.links()).toEqual([
        { kind: 'explicit', a: 'c', b: 'd', assertedBy: 'agent' },
      ]);
      expect(await rows.entities()).toEqual([{ id: 'b', entity: 'payments-db' }]);
      expect((await rows.episodes()).map((e) => e.id)).toEqual([]);
      expect(await rows.orphans()).toBe(0);
      expect(await S().linksOf(TG, 'a')).toBeNull();
    });

    it('links.upsert-keeps-links-and-rewrites-the-entity-index', async () => {
      await seed(at('a', { entities: ['Postgres', 'port'] }), at('b'));
      await S().link(TG, 'a', 'b', USER);
      expect(await entitiesOf('a')).toEqual(['port', 'postgres']);
      const m = (await store.get(TG, 'a'))!;
      await store.upsert(TG, { ...m, text: 'the port is 8080', entities: ['port', '8080'] });
      await store.upsertMany(TG, [{ ...m, text: 'the port is 9090', entities: ['port', '9090'] }]);
      expect((await listed(TG, 'a'))?.links).toEqual([['explicit', 'b', 'both', 'user']]);
      expect(await entitiesOf('a')).toEqual(['9090', 'port']);
      // A cold memory that is still current keeps its links and its index rows.
      await store.coldPut(TG, (await store.get(TG, 'a'))!);
      expect((await store.get(TG, 'a'))?.tier).toBe('cold');
      expect((await listed(TG, 'a'))?.links).toEqual([['explicit', 'b', 'both', 'user']]);
      expect(await entitiesOf('a')).toEqual(['9090', 'port']);
    });

    it('links.superseded-and-expired-memories-leave-the-entity-index', async () => {
      await seed(at('old', { entities: ['port'] }), at('gone', { entities: ['port'] }), at('b'));
      await S().link(TG, 'old', 'b', USER);
      const old = (await store.get(TG, 'old'))!;
      const now = new Date().toISOString();
      // A supersede: the new memory and the old one's end in one batch.
      await store.upsertMany(TG, [
        at('new', { entities: ['port'], supersedes: 'old' }),
        { ...old, supersededBy: 'new', validTo: now, endReason: 'superseded', expiredAt: now },
      ]);
      expect(await entitiesOf('old')).toEqual([]);
      expect(await entitiesOf('new')).toEqual(['port']);
      const gone = (await store.get(TG, 'gone'))!;
      expect((await store.expireMany(TG, [gone], new Date())).skipped).toEqual([]);
      expect(await entitiesOf('gone')).toEqual([]);
      // Ending a memory never ends its explicit links.
      expect((await listed(TG, 'old'))?.links).toEqual([['explicit', 'b', 'both', 'user']]);
      expect(await rows.entities()).toEqual([{ id: 'new', entity: 'port' }]);
    });

    it('links.entity-keys-are-normalised-and-bounded', async () => {
      const many = Array.from({ length: 20 }, (_, i) => `entity ${String(i).padStart(2, '0')}`);
      await seed(
        at('a', { entities: ['  Payments \t DB ', 'payments db', 'X', 'ＡＰＩ', 'x'.repeat(129)] }),
        at('b', { entities: many }),
      );
      expect(await entitiesOf('a')).toEqual(['api', 'payments db']);
      expect(await entitiesOf('b')).toEqual(many.slice(0, 16));
    });

    it('links.hive-memories-get-no-index-rows', async () => {
      const hive: Address = { level: 'hive', orgId: 'local', hiveId: 'team' };
      const g = nodesGrant(nodeOf(hive));
      await store.upsert(
        g,
        at(
          'h',
          {
            entities: ['payments-db'],
            source: { harness: 'test', sessionId: 's1', decisions: [] },
          },
          hive,
        ),
      );
      expect(await rows.entities()).toEqual([]);
      expect(await rows.episodes()).toEqual([]);
    });

    it('links.listed-links-follow-the-grant', async () => {
      await seed(at('a', {}, planet('p1')), at('b', {}, planet('p2')), at('c', {}, planet('p1')));
      await S().link(TG, 'a', 'b', USER);
      await S().link(TG, 'a', 'c', AGENT);
      await S().unlink(TG, 'c', 'b', USER);
      const p1 = localGrant({ ...LOCAL, projectIds: ['p1'] });
      expect(await listed(p1, 'a')).toEqual({
        links: [['explicit', 'c', 'both', 'agent']],
        blocked: [],
        hidden: 1,
      });
      // A block's other end it cannot read is neither listed nor counted.
      expect(await listed(p1, 'c')).toEqual({
        links: [['explicit', 'a', 'both', 'agent']],
        blocked: [],
        hidden: 0,
      });
      expect(await S().linksOf(p1, 'b')).toBeNull();
      expect(await listed(TG, 'b')).toEqual({
        links: [['explicit', 'a', 'both', 'user']],
        blocked: ['c'],
        hidden: 0,
      });
      // It cannot link to a memory it cannot read either.
      expect(await S().link(p1, 'c', 'b', USER)).toBeNull();
    });

    it('links.episode-positions-follow-the-session', async () => {
      const src = (sessionId: string | undefined, turnRef?: string) => ({
        harness: 'test',
        ...(sessionId !== undefined && { sessionId }),
        ...(turnRef !== undefined && { turnRef }),
        decisions: [],
      });
      await seed(
        at('t1a', { source: src('s1', 't1') }),
        at('t1b', { source: src('s1', 't1') }), // another fact of the same turn
        at('t2', { source: src('s1', 't2') }),
        at('none', { source: src(undefined) }),
        at('s2', { source: src('s2', 't1') }),
        at('t3', { source: src('s1') }),
      );
      const seqs = async () =>
        Object.fromEntries((await rows.episodes()).map((e) => [e.id, [e.session, e.seq]]));
      expect(await seqs()).toEqual({
        t1a: ['s1', 1],
        t1b: ['s1', 1],
        t2: ['s1', 2],
        s2: ['s2', 1],
        t3: ['s1', 3],
      });
      // A rewrite in place keeps its position.
      const m = (await store.get(TG, 't1a'))!;
      await store.upsert(TG, { ...m, text: 'refined' });
      expect((await seqs())['t1a']).toEqual(['s1', 1]);
    });

    it('links.an-agent-cannot-unlink-a-link-a-person-asserted', async () => {
      // Otherwise two agent calls (unlink, then link) would turn a person's link into an agent's.
      await seed(at('a'), at('b'));
      await S().link(TG, 'a', 'b', USER);
      expect(await S().unlink(TG, 'a', 'b', AGENT)).toEqual({
        removed: false,
        blocked: false,
        refused: 'asserted-by-user',
      });
      expect(await rows.links()).toEqual([
        { kind: 'explicit', a: 'a', b: 'b', assertedBy: 'user' },
      ]);
      expect(await S().link(TG, 'a', 'b', AGENT)).toMatchObject({ assertedBy: 'user' });
      expect(await S().unlink(TG, 'a', 'b', USER)).toMatchObject({ removed: true });
      expect((await rows.links()).filter((l) => l.kind === 'explicit')).toEqual([]);
    });

    it('links.upsert-many-linked-writes-memories-and-links-together', async () => {
      const r = await store.upsertManyLinked!(
        TG,
        [at('a'), at('b'), at('c')],
        [
          ['a', 'b'],
          ['a', 'nope'],
          ['c', 'c'],
        ],
        AGENT,
      );
      expect(r).toEqual({ linked: 1 });
      expect(await rows.links()).toEqual([
        { kind: 'explicit', a: 'a', b: 'b', assertedBy: 'agent' },
      ]);
      // One memory outside the grant: nothing is written, memories or links.
      const narrow = nodeGrant({ principal: OWNER, read: [], write: [] });
      await expect(
        store.upsertManyLinked!(narrow, [at('d'), at('e')], [['d', 'e']], AGENT),
      ).rejects.toThrow();
      expect(await store.get(TG, 'd')).toBeNull();
      expect(await rows.links()).toHaveLength(1);
    });
  });
}
