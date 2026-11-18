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
import type { MemoryStore, MemoryWriter, ScopeFilter } from './adapters.js';
import { forgetMemory } from './forget.js';
import { occurredFor } from './observe.js';
import { factInterval, startBefore } from './temporal.js';
import { GrantError, localGrant, nodeGrant, principalGrant, type Grant } from './grant.js';
import { isCurrent, type Decision, type Memory, type Scope } from './model.js';
import type { NearQuery, Place, SpatialFilter } from './place.js';
import type { Occurrence } from './event-time.js';
import type { Feedback } from './feedback.js';
import { labelOrigin } from './judgment.js';
import type { Prediction } from './prediction.js';
import { localScope } from './scope.js';
import { isolationViolations, nonInterference } from './isolation.js';
import {
  EPISODE_RAW_SCAN,
  EXPLICIT_RAW_SCAN,
  RAW_SCAN_FACTOR,
  rawScanLimit,
  type LinksProbe,
  type NeighbourOptions,
} from './links.js';

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

    it('levels.judgment-label-origin-roundtrips', async () => {
      // How a judgment arrived is kept exactly. One written before origins were kept has none: it
      // reads `agent` when an agent recorded it and no person confirmed it, else `integration`.
      const judgment = {
        subject: { summary: 'Post claims a cure' },
        verdict: 'rejected',
        verdicts: ['approved', 'rejected'],
        reason: 'No cited source.',
        criteria: [],
        domain: 'content',
        by: 'ada',
        decidedAt: '2026-01-01T00:00:00.000Z',
        via: 'mcp' as const,
      };
      const labelled = makeMemory({
        id: 'judgment-labelled',
        scope: localScope(undefined),
        type: 'judgment',
        judgment: {
          ...judgment,
          origin: 'interactive',
          proposedOrigin: 'agent',
          confirmed: { at: '2026-01-02T00:00:00.000Z', by: 'ada' },
        },
      });
      const connector = makeMemory({
        id: 'judgment-connector',
        scope: localScope(undefined),
        type: 'judgment',
        judgment: {
          ...judgment,
          via: 'sdk',
          origin: 'connector',
          reviewer: 'grace',
          upstream: { system: 'jira', actor: 'grace@example.test' },
        },
      });
      const old = makeMemory({
        id: 'judgment-old',
        scope: localScope(undefined),
        type: 'judgment',
        judgment: { ...judgment, via: 'cli' },
      });
      const oldAgent = makeMemory({
        id: 'judgment-old-agent',
        scope: localScope(undefined),
        type: 'judgment',
        judgment,
      });
      const oldConfirmed = makeMemory({
        id: 'judgment-old-confirmed',
        scope: localScope(undefined),
        type: 'judgment',
        judgment: { ...judgment, confirmed: { at: '2026-01-02T00:00:00.000Z', by: 'ada' } },
      });
      for (const m of [labelled, connector, old, oldAgent, oldConfirmed]) await store.upsert(TG, m);
      expect(await store.get(TG, 'judgment-labelled')).toEqual(labelled);
      expect(await store.get(TG, 'judgment-connector')).toEqual(connector);
      const got = await store.get(TG, 'judgment-old');
      expect(got).toEqual(old);
      expect(got?.judgment?.origin).toBeUndefined();
      expect(labelOrigin(got?.judgment)).toBe('integration');
      const agentRow = await store.get(TG, 'judgment-old-agent');
      expect(agentRow).toEqual(oldAgent);
      expect(agentRow?.judgment?.origin).toBeUndefined();
      expect(labelOrigin(agentRow?.judgment)).toBe('agent');
      const listed = await store.list(TG, { validOnly: false, embeddings: false });
      expect(Object.fromEntries(listed.map((m) => [m.id, labelOrigin(m.judgment)]))).toMatchObject({
        'judgment-labelled': 'interactive',
        'judgment-connector': 'connector',
        'judgment-old': 'integration',
        'judgment-old-agent': 'agent',
        'judgment-old-confirmed': 'integration',
      });
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
      expect(await S().unlink(TG, 'a', 'b', AGENT)).toEqual({ removed: false, blocked: true });
      expect(await listed(TG, 'a')).toEqual({ links: [], blocked: ['b'], hidden: 0 });
      expect(await listed(TG, 'b')).toEqual({ links: [], blocked: ['a'], hidden: 0 });
      expect(await rows.links()).toEqual([
        { kind: 'blocked', a: 'a', b: 'b', assertedBy: 'agent' },
      ]);
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

    it('links.an-agent-cannot-remove-a-block-a-person-asserted', async () => {
      await seed(at('a'), at('b'));
      expect(await S().unlink(TG, 'a', 'b', USER)).toEqual({ removed: false, blocked: true });
      expect(await S().link(TG, 'a', 'b', AGENT)).toEqual({
        linked: false,
        unblocked: false,
        assertedBy: 'agent',
        refused: 'asserted-by-user',
      });
      expect(await rows.links()).toEqual([{ kind: 'blocked', a: 'a', b: 'b', assertedBy: 'user' }]);
      // A person's link still removes it.
      expect(await S().link(TG, 'a', 'b', USER)).toEqual({
        linked: true,
        unblocked: true,
        assertedBy: 'user',
      });
      // And an agent's own block is an agent's to remove.
      await S().unlink(TG, 'a', 'b', USER);
      await seed(at('c'), at('d'));
      await S().unlink(TG, 'c', 'd', AGENT);
      expect(await S().link(TG, 'c', 'd', AGENT)).toMatchObject({ linked: true, unblocked: true });
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

    // One hop for recall (CON-149): `neighbours` returns ids, and only what the reader may reach.
    const src = (sessionId: string, turnRef?: string) => ({
      harness: 'test',
      sessionId,
      ...(turnRef !== undefined && { turnRef }),
      decisions: [],
    });
    const ALL = ['explicit', 'episode', 'about'] as const;
    const hop = async (
      g: Grant,
      seeds: string[],
      o: Partial<NeighbourOptions> = {},
    ): Promise<{ list: string[]; skipped: boolean }> => {
      const r = await store.neighbours!(g, seeds, { kinds: ALL, ...o });
      return {
        list: r.neighbours.map((n) => `${n.from}>${n.id}:${n.kind}`).sort(),
        skipped: r.skipped === true,
      };
    };
    const reached = async (g: Grant, seeds: string[], o: Partial<NeighbourOptions> = {}) =>
      (await hop(g, seeds, o)).list;

    it('neighbours.explicit-links-lead-both-ways-by-who-asserted-them', async () => {
      expect(typeof store.neighbours).toBe('function');
      await seed(at('a'), at('b'), at('c'), at('d'));
      await S().link(TG, 'a', 'b', USER);
      await S().link(TG, 'c', 'a', AGENT);
      expect(await reached(TG, ['a'])).toEqual(['a>b:explicit', 'a>c:explicit']);
      expect(await reached(TG, ['b', 'c'])).toEqual(['b>a:explicit', 'c>a:explicit']);
      expect(await reached(TG, ['a'], { explicitBy: 'user' })).toEqual(['a>b:explicit']);
      expect(await reached(TG, ['c'], { explicitBy: 'user' })).toEqual([]);
      expect(await reached(TG, ['a'], { kinds: ['about', 'episode'] })).toEqual([]);
      expect(await reached(TG, ['a'], { kinds: [] })).toEqual([]);
      expect(await reached(TG, ['d', 'nope'])).toEqual([]);
      const r = await store.neighbours!(TG, ['a'], { kinds: ['explicit'] });
      expect(r.neighbours.map((n) => n.weight)).toEqual([1, 1]);
      // Ids, a kind, a seed, a weight and who asserted the link: nothing of the memory itself.
      expect(Object.keys(r.neighbours[0]!).sort()).toEqual([
        'assertedBy',
        'from',
        'id',
        'kind',
        'weight',
      ]);
      expect(r.neighbours.map((n) => [n.id, n.assertedBy])).toEqual([
        ['b', 'user'],
        ['c', 'agent'],
      ]);
    });

    it('neighbours.about-weighs-a-shared-entity-by-its-fan', async () => {
      await seed(
        at('a', { entities: ['auth-service', 'Postgres'] }),
        at('b', { entities: ['Auth-Service'] }),
        at('c', { entities: ['auth-service', 'postgres'] }),
        at('d', { entities: ['redis'] }),
      );
      const r = await store.neighbours!(TG, ['a'], { kinds: ['about'], fMax: 50 });
      const w = Object.fromEntries(r.neighbours.map((n) => [n.id, n.weight]));
      const fan3 = 1 - Math.log(3) / Math.log(50);
      const fan2 = 1 - Math.log(2) / Math.log(50);
      expect(Object.keys(w).sort()).toEqual(['b', 'c']);
      expect(w['b']).toBeCloseTo(fan3, 10);
      // Two shared entities combine as a noisy-or.
      expect(w['c']).toBeCloseTo(1 - (1 - fan3) * (1 - fan2), 10);
      expect(await reached(TG, ['d'])).toEqual([]);
    });

    it('neighbours.a-hub-entity-relates-nothing', async () => {
      // fMax 3: an entity in 3 or more readable memories spreads nothing.
      await seed(
        at('a', { entities: ['repo', 'rare'] }),
        at('b', { entities: ['repo', 'rare'] }),
        at('c', { entities: ['repo'] }),
      );
      expect(await reached(TG, ['a'], { fMax: 3 })).toEqual(['a>b:about']);
      const one = await store.neighbours!(TG, ['a'], { kinds: ['about'], fMax: 3 });
      expect(one.neighbours[0]!.weight).toBeCloseTo(1 - Math.log(2) / Math.log(3), 10);
      await seed(at('d', { entities: ['rare'] }));
      expect(await reached(TG, ['a'], { fMax: 3 })).toEqual([]);
      expect(await reached(TG, ['a'], { fMax: 4 })).toEqual([
        'a>b:about',
        'a>c:about',
        'a>d:about',
      ]);
    });

    it('neighbours.rows-outside-the-grant-change-nothing-for-the-reader', async () => {
      // Two readers of one entity. Whatever the entity holds outside the first reader's grant,
      // that reader gets the same neighbours with the same weights: otherwise a neighbour that
      // appears or vanishes would tell it how much there is that it cannot read.
      await seed(at('a', { entities: ['rare'] }), at('b', { entities: ['rare'] }));
      const narrow = localGrant({ ...LOCAL, projectIds: [null] });
      const about = async (g: Grant) =>
        (await store.neighbours!(g, ['a'], { kinds: ['about'], fMax: 3 })).neighbours;
      const before = await about(narrow);
      expect(before).toEqual([
        { id: 'b', kind: 'about', from: 'a', weight: 1 - Math.log(2) / Math.log(3) },
      ]);
      // Far past the hub cutoff (fMax 3), and newer than every readable row.
      for (let i = 0; i < 40; i++) {
        await seed(at(`p${i}`, { entities: ['rare'] }, planet('p2')));
        if (i === 0 || i === 11 || i === 12 || i === 39)
          expect(await about(narrow)).toEqual(before);
      }
      // The reader who reads them all sees a hub; the narrow reader's answer never moved.
      expect(await about(TG)).toEqual([]);
      expect(await about(narrow)).toEqual(before);
      // The same holds for the caps: unreadable links and turns do not use up a reader's places.
      await seed(at('x'), at('y'));
      await S().link(TG, 'x', 'y', USER);
      for (let i = 0; i < 40; i++) await S().link(TG, 'x', `p${i}`, USER);
      expect(await reached(narrow, ['x'], { kinds: ['explicit'] })).toEqual(['x>y:explicit']);
      await seed(at('s1', { source: src('s9', 't1') }));
      for (let i = 0; i < 40; i++)
        await seed(at(`q${i}`, { source: src('s9', 't2') }, planet('p2')));
      await seed(at('s2', { source: src('s9', 't2') }));
      expect(await reached(narrow, ['s1'], { kinds: ['episode'] })).toEqual(['s1>s2:episode']);
    });

    it('neighbours.a-raw-scan-bound-skips-the-entity-and-says-so', async () => {
      // The work per entity is bounded whatever the grant: past RAW_SCAN_FACTOR × fMax rows of an
      // entity in the node, the entity is skipped for this call and the result says so. Nothing
      // is returned from a cut-off read.
      await seed(at('a', { entities: ['huge', 'small'] }), at('b', { entities: ['huge'] }));
      await seed(at('c', { entities: ['small'] }));
      const narrow = localGrant({ ...LOCAL, projectIds: [null] });
      const about = (g: Grant) => hop(g, ['a'], { kinds: ['about'], fMax: 3 });
      const whole = { list: ['a>b:about', 'a>c:about'], skipped: false };
      expect(await about(narrow)).toEqual(whole);
      // Up to the bound, rows the reader cannot read change nothing for it.
      const fill = async (from: number, to: number) => {
        for (let i = from; i < to; i++)
          await seed(at(`u${i}`, { entities: ['huge'] }, planet('p2')));
      };
      expect(rawScanLimit(3)).toBe(RAW_SCAN_FACTOR * 3);
      await fill(0, rawScanLimit(3) - 2);
      expect(await about(narrow)).toEqual(whole);
      // One row more: `huge` is skipped and reported; `small` is still read in full.
      await fill(rawScanLimit(3) - 2, rawScanLimit(3) - 1);
      expect(await about(narrow)).toEqual({ list: ['a>c:about'], skipped: true });
    });

    it('neighbours.a-raw-scan-bound-skips-too-many-explicit-links-of-one-asserter', async () => {
      await seed(at('a'), at('b'), at('c'), at('d'));
      await S().link(TG, 'a', 'b', AGENT);
      await S().link(TG, 'c', 'd', AGENT);
      const narrow = localGrant({ ...LOCAL, projectIds: [null] });
      const explicit = (g: Grant) => hop(g, ['a', 'c'], { kinds: ['explicit'] });
      const whole = { list: ['a>b:explicit', 'c>d:explicit'], skipped: false };
      const link = async (from: number, to: number) => {
        const ms = Array.from({ length: to - from }, (_, i) =>
          at(`u${from + i}`, {}, planet('p2')),
        );
        await store.upsertManyLinked!(
          TG,
          ms,
          ms.map((m) => ['a', m.id] as const),
          AGENT,
        );
      };
      await link(0, EXPLICIT_RAW_SCAN - 1);
      expect(await explicit(narrow)).toEqual(whole);
      // One link more on `a`: its agent links are skipped, never cut short; `c` is unaffected.
      await link(EXPLICIT_RAW_SCAN - 1, EXPLICIT_RAW_SCAN);
      expect(await explicit(narrow)).toEqual({ list: ['c>d:explicit'], skipped: true });
      expect(await explicit(TG)).toEqual({ list: ['c>d:explicit'], skipped: true });
    });

    it("neighbours.an-agent's-links-never-suppress-a-person's", async () => {
      // A memory with one link confirmed at a terminal, and then more agent-written links than
      // the bound, all newer: the person's link is still read, by itself and beside the rest.
      await seed(at('a'), at('mine'));
      await S().link(TG, 'a', 'mine', USER);
      const flood = async (n: number, tag: string) => {
        const ms = Array.from({ length: n }, (_, i) => at(`${tag}${i}`));
        await store.upsertManyLinked!(
          TG,
          ms,
          ms.map((m) => ['a', m.id] as const),
          AGENT,
        );
      };
      // Under the bound: the caps are per asserter, so 30 newer agent links leave it its place.
      await flood(30, 'x');
      const some = await store.neighbours!(TG, ['a'], { kinds: ['explicit'] });
      expect(some.skipped).toBeUndefined();
      expect(some.neighbours[0]).toEqual({
        id: 'mine',
        kind: 'explicit',
        from: 'a',
        weight: 1,
        assertedBy: 'user',
      });
      expect(some.neighbours.filter((n) => n.assertedBy === 'agent')).toHaveLength(16);
      // Past the bound: the agent's links are skipped and reported; the person's are not.
      await flood(EXPLICIT_RAW_SCAN, 'y');
      expect(await hop(TG, ['a'], { kinds: ['explicit'] })).toEqual({
        list: ['a>mine:explicit'],
        skipped: true,
      });
      expect(await hop(TG, ['a'], { kinds: ['explicit'], explicitBy: 'user' })).toEqual({
        list: ['a>mine:explicit'],
        skipped: false,
      });
    });

    it('neighbours.rows-in-another-node-never-count-toward-a-bound', async () => {
      // The work bounds are per node. Another node that shares the session id and the entity key
      // (another agent's Star here) changes neither this reader's neighbours nor `skipped`.
      const star: Address = { level: 'agent', orgId: 'local', agentId: 'claude-code' };
      const wide = nodesGrant(nodeOf(planet()), nodeOf(star));
      const shared = { entities: ['thing'] };
      await seed(
        at('a', { ...shared, source: src('s1', 't1') }),
        at('b', { ...shared, source: src('s1', 't2') }),
      );
      const whole = { list: ['a>b:about', 'a>b:episode'], skipped: false };
      const kinds = ['episode', 'about'] as const;
      expect(await hop(TG, ['a'], { kinds, fMax: 3 })).toEqual(whole);
      const many = Math.max(EPISODE_RAW_SCAN, rawScanLimit(3)) + 8;
      await store.upsertMany(
        wide,
        Array.from({ length: many }, (_, i) =>
          at(`s${i}`, { ...shared, source: src('s1', i % 2 === 0 ? 't1' : 't2') }, star),
        ),
      );
      expect(await hop(TG, ['a'], { kinds, fMax: 3 })).toEqual(whole);
      expect(await hop(wide, ['a'], { kinds, fMax: 3 })).toEqual(whole);
      // In its own node the bound does apply: the seed's turns hold more than the bound.
      expect(await hop(wide, ['s0'], { kinds: ['episode'] })).toEqual({ list: [], skipped: true });
      // Exactly at the bound the read is made; one memory more and it is skipped.
      for (let i = 0; i < EPISODE_RAW_SCAN - 1; i++)
        await seed(at(`e${i}`, { source: src('s1', 't2') }, planet('p2')));
      const narrow = localGrant({ ...LOCAL, projectIds: [null] });
      expect(await hop(narrow, ['a'], { kinds: ['episode'] })).toEqual({
        list: ['a>b:episode'],
        skipped: false,
      });
      await seed(at('extra', { source: src('s1', 't2') }, planet('p2')));
      expect(await hop(narrow, ['a'], { kinds: ['episode'] })).toEqual({
        list: [],
        skipped: true,
      });
    });

    it('neighbours.episode-reaches-three-turns-forward-weighted', async () => {
      await seed(
        ...['t1', 't2', 't3', 't4', 't5', 't6'].map((t) => at(t, { source: src('s1', t) })),
        at('t3b', { source: src('s1', 't3') }),
        at('other', { source: src('s2', 't3') }),
      );
      const r = await store.neighbours!(TG, ['t3'], { kinds: ['episode'] });
      const w = Object.fromEntries(r.neighbours.map((n) => [n.id, n.weight]));
      expect(Object.keys(w).sort()).toEqual(['t1', 't2', 't3b', 't4', 't5', 't6']);
      expect(w['t3b']).toBe(1);
      expect(w['t4']).toBeCloseTo(Math.exp(-1 / 3), 10);
      expect(w['t2']).toBeCloseTo(Math.exp(-1 / 3) / 2, 10);
      expect(w['t6']).toBeCloseTo(Math.exp(-1), 10);
      expect(await reached(TG, ['t1'])).toEqual([
        't1>t2:episode',
        't1>t3:episode',
        't1>t3b:episode',
        't1>t4:episode',
      ]);
    });

    it('neighbours.never-leave-the-grant-the-node-or-a-hive', async () => {
      const star: Address = { level: 'agent', orgId: 'local', agentId: 'claude-code' };
      const hive: Address = { level: 'hive', orgId: 'local', hiveId: 'team' };
      const wide = nodesGrant(nodeOf(planet()), nodeOf(star), nodeOf(hive));
      const shared = { entities: ['auth-service'], source: src('s1', 't1') };
      await seed(at('a', shared, planet('p1')), at('b', shared, planet('p2')));
      await seed(at('c', shared, planet('p1')));
      await store.upsert(wide, at('s', shared, star));
      await store.upsert(wide, at('h1', shared, hive));
      await store.upsert(wide, at('h2', shared, hive));
      await S().link(TG, 'a', 'b', USER);
      await S().link(TG, 'a', 'c', USER);
      const every = ['a>b:about', 'a>b:episode', 'a>b:explicit'];
      const inP1 = ['a>c:about', 'a>c:episode', 'a>c:explicit'];
      // The whole Planet, and the Star and the hive beside it: only the Planet's own memories.
      expect(await reached(wide, ['a'])).toEqual([...every, ...inP1].sort());
      // A reader of project p1 only: b is not reached by any kind, a person's link included.
      const p1 = localGrant({ ...LOCAL, projectIds: ['p1'] });
      expect(await reached(p1, ['a'])).toEqual(inP1);
      expect(await reached(p1, ['a'], { explicitBy: 'user' })).toEqual(inP1);
      // A seed it cannot read contributes nothing, as an unknown id does.
      expect(await reached(p1, ['b'])).toEqual([]);
      // Nothing is gathered from or inside a hive node.
      expect(await reached(wide, ['h1', 'h2'])).toEqual([]);
      expect(await reached(wide, ['s'])).toEqual([]);
    });

    it('neighbours.skip-blocked-pairs-and-ended-memories', async () => {
      const shared = { entities: ['auth-service'], source: src('s1', 't1') };
      await seed(at('a', shared), at('b', shared), at('old', shared), at('gone', shared));
      await S().link(TG, 'a', 'old', USER);
      await S().link(TG, 'a', 'gone', USER);
      await S().unlink(TG, 'a', 'b', USER);
      // b shares an entity and a session with a, but the pair is blocked.
      expect((await reached(TG, ['a'])).filter((x) => x.startsWith('a>b'))).toEqual([]);
      expect(await reached(TG, ['b'])).not.toContain('b>a:about');
      const now = new Date().toISOString();
      const old = (await store.get(TG, 'old'))!;
      await store.upsertMany(TG, [
        at('new', { supersedes: 'old' }),
        { ...old, supersededBy: 'new', validTo: now, endReason: 'superseded', expiredAt: now },
      ]);
      await store.expireMany(TG, [(await store.get(TG, 'gone'))!], new Date());
      expect(await reached(TG, ['a'], { currentOnly: true })).toEqual([]);
      // Another view may still ask for them: the explicit link and the episode outlive the end.
      expect(await reached(TG, ['a'], { kinds: ['explicit'] })).toEqual([
        'a>gone:explicit',
        'a>old:explicit',
      ]);
    });

    it('neighbours.stay-inside-the-requested-place', async () => {
      if (store.spatial !== true) return;
      const shared = { entities: ['toolbox'] };
      await seed(
        at('a', { ...shared, place: { nodeId: 'site:hq/room:B' } }),
        at('in', { ...shared, place: { nodeId: 'site:hq/room:B/shelf:3' } }),
        at('out', { ...shared, place: { nodeId: 'site:hq/room:A' } }),
        at('bare', shared),
      );
      await S().link(TG, 'a', 'out', USER);
      expect(await reached(TG, ['a'], { spatial: { within: 'room:B' } })).toEqual(['a>in:about']);
      expect(await reached(TG, ['a'])).toHaveLength(4);
    });

    it('neighbours.stop-at-the-budget-and-say-so', async () => {
      await seed(
        at('a', { entities: ['one', 'two'], source: src('s1', 't1') }),
        at('b', { entities: ['one'], source: src('s1', 't2') }),
        at('c', { entities: ['two'] }),
        at('d'),
      );
      await S().link(TG, 'a', 'd', USER);
      // A clock that advances 1 ms each time it is read: the checks are before each kind and each
      // entity, so a budget of n ms allows a fixed number of them.
      const ticking = () => {
        let t = 0;
        return () => t++;
      };
      expect(await hop(TG, ['a'], { budgetMs: 1, clock: ticking() })).toEqual({
        list: [],
        skipped: true,
      });
      expect(await hop(TG, ['a'], { budgetMs: 2, clock: ticking() })).toEqual({
        list: ['a>d:explicit'],
        skipped: true,
      });
      expect(await hop(TG, ['a'], { budgetMs: 4, clock: ticking() })).toEqual({
        list: ['a>b:episode', 'a>d:explicit'],
        skipped: true,
      });
      expect(await hop(TG, ['a'], { budgetMs: 5, clock: ticking() })).toEqual({
        list: ['a>b:about', 'a>b:episode', 'a>d:explicit'],
        skipped: true,
      });
      const whole = ['a>b:about', 'a>b:episode', 'a>c:about', 'a>d:explicit'];
      expect(await hop(TG, ['a'], { budgetMs: 50, clock: ticking() })).toEqual({
        list: whole,
        skipped: false,
      });
      expect(await hop(TG, ['a'], { budgetMs: 0, clock: ticking() })).toEqual({
        list: whole,
        skipped: false,
      });
    });

    it('neighbours.keep-each-read-bounded', async () => {
      const many = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, '0')}`);
      await seed(at('a', { entities: ['thing'] }));
      for (const id of many) {
        await seed(at(id, { entities: ['thing'] }));
        await S().link(TG, 'a', id, AGENT);
      }
      const r = await store.neighbours!(TG, ['a'], { kinds: ALL, fMax: 50 });
      const of = (kind: string) => r.neighbours.filter((n) => n.kind === kind).map((n) => n.id);
      // The newest first: 16 explicit links and 20 memories per entity.
      expect(of('explicit').sort()).toEqual(many.slice(-16));
      expect(of('about').sort()).toEqual(many.slice(-20));
    });
  });
}

/**
 * Event time: the suite a store with `occurrences: true` must pass, on top of
 * `storeConformance`. `Memory.occurred` round-trips exactly and is checked on write; `occurredIn`
 * returns the memories with an occurrence overlapping the range, inside the grant and the spatial
 * filter, stated occurrences first, then nearest the range's middle, then by id, at most k.
 */
export function occurrenceConformance(name: string, make: () => Promise<MemoryStore>): void {
  describe(`store event time: ${name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await make();
    });

    afterEach(async () => {
      await store.close();
    });

    const DAY = 86_400_000;
    const day = (iso: string, days = 1): Occurrence => ({
      from: `${iso}T00:00:00.000Z`,
      to: new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY).toISOString(),
      precision: days === 1 ? 'day' : 'span',
      source: 'explicit',
    });
    const said = (iso: string): Occurrence => ({ ...day(iso), source: 'mention' });
    const at = (id: string, occurred: Occurrence[] | undefined, extra: Partial<Memory> = {}) =>
      makeMemory({ id, ...(occurred !== undefined && { occurred }), ...extra });
    const range = (from: string, to: string) => ({
      from: `${from}T00:00:00.000Z`,
      to: `${to}T00:00:00.000Z`,
    });
    const read = async (from: string, to: string, k = 50, g: Grant = TG) =>
      ids(await store.occurredIn!(g, range(from, to), k));

    it('occurrences.store-says-it-keeps-them', () => {
      expect(store.occurrences).toBe(true);
      expect(typeof store.occurredIn).toBe('function');
    });

    it('occurrences.roundtrip-exactly-and-a-rewrite-replaces-them', async () => {
      const m = at('m', [day('2023-05-20', 2), said('2023-05-22')]);
      await store.upsert(TG, m);
      expect(await store.get(TG, 'm')).toEqual(m);
      expect((await store.list(TG, { validOnly: false }))[0]?.occurred).toEqual(m.occurred);
      expect(await read('2023-05-21', '2023-05-22')).toEqual(['m']);
      // Rewritten with other occurrences: only the new ones are read.
      await store.upsert(TG, at('m', [said('2024-01-01')]));
      expect(await read('2023-05-01', '2023-06-01')).toEqual([]);
      expect(await read('2024-01-01', '2024-01-02')).toEqual(['m']);
      // Rewritten without any: none.
      await store.upsert(TG, at('m', undefined));
      expect((await store.get(TG, 'm'))?.occurred).toBeUndefined();
      expect(await read('2024-01-01', '2024-01-02')).toEqual([]);
    });

    it('occurrences.are-checked-on-write', async () => {
      const bad = (occurred: unknown) => ({ ...at('bad', undefined), occurred }) as Memory;
      for (const o of [
        'soon',
        [{ ...day('2023-05-20'), to: '2023-05-19T00:00:00.000Z' }],
        [{ ...day('2023-05-20'), source: 'guess' }],
        [{ ...day('2023-05-20'), precision: 'hour' }],
        [day('2020-01-01', 400)],
        [{ ...day('2023-05-20'), extra: 1 }],
      ]) {
        await expect(store.upsert(TG, bad(o))).rejects.toThrow(RangeError);
      }
      await expect(store.upsertMany(TG, [at('ok', [day('2023-01-01')]), bad('x')])).rejects.toThrow(
        RangeError,
      );
      expect(await store.get(TG, 'bad')).toBeNull();
      expect(await store.get(TG, 'ok')).toBeNull();
    });

    it('occurrences.a-range-read-returns-overlaps-only', async () => {
      await store.upsert(TG, at('before', [day('2023-05-19')]));
      await store.upsert(TG, at('first', [day('2023-05-20')]));
      await store.upsert(TG, at('last', [day('2023-05-21')]));
      await store.upsert(TG, at('after', [day('2023-05-22')]));
      await store.upsert(TG, at('bare', undefined));
      // `from` inclusive, `to` exclusive, on both sides.
      expect((await read('2023-05-20', '2023-05-22')).sort()).toEqual(['first', 'last']);
      expect(await read('2023-05-22', '2023-05-22')).toEqual([]);
      expect(await read('2023-05-23', '2023-05-30')).toEqual([]);
    });

    it('occurrences.a-long-occurrence-is-found-from-its-far-end', async () => {
      // A year-long occurrence overlaps a range near its end: the bounded read still finds it.
      await store.upsert(TG, at('year', [{ ...day('2022-01-01', 365), precision: 'year' }]));
      expect(await read('2022-12-30', '2022-12-31')).toEqual(['year']);
      expect(await read('2023-01-01', '2023-01-02')).toEqual([]);
    });

    it('occurrences.stated-first-then-nearest-the-middle-then-id-and-k', async () => {
      await store.upsert(TG, at('m-mid', [said('2023-05-15')]));
      await store.upsert(TG, at('s-edge', [day('2023-05-02')]));
      await store.upsert(TG, at('s-mid', [day('2023-05-16')]));
      await store.upsert(TG, at('s-mid-b', [day('2023-05-16')]));
      // Its stated occurrence counts, not its mention near the middle.
      await store.upsert(TG, at('both', [day('2023-05-31'), said('2023-05-16')]));
      expect(await read('2023-05-01', '2023-06-01')).toEqual([
        's-mid',
        's-mid-b',
        's-edge',
        'both',
        'm-mid',
      ]);
      expect(await read('2023-05-01', '2023-06-01', 2)).toEqual(['s-mid', 's-mid-b']);
      const scored = await store.occurredIn!(TG, range('2023-05-01', '2023-06-01'), 50);
      // Higher score first.
      for (let i = 1; i < scored.length; i++) {
        expect(scored[i]!.score).toBeLessThanOrEqual(scored[i - 1]!.score);
      }
    });

    it('occurrences.read-inside-the-grant-and-the-spatial-filter', async () => {
      const other = { ...localScope(), projectId: 'other' };
      await store.upsert(TG, at('here', [day('2023-05-20')]));
      await store.upsert(TG, at('there', [day('2023-05-20')], { scope: other }));
      expect(await read('2023-05-20', '2023-05-21', 50, localGrant(LOCAL))).toEqual(['here']);
      expect((await read('2023-05-20', '2023-05-21')).sort()).toEqual(['here', 'there']);
      if (store.spatial === true) {
        await store.upsert(TG, at('placed', [day('2023-05-20')], { place: { nodeId: 'room:B' } }));
        const hits = await store.occurredIn!(TG, range('2023-05-20', '2023-05-21'), 50, {
          spatial: { within: 'room:B' },
        });
        expect(ids(hits)).toEqual(['placed']);
      }
    });

    it('occurrences.forget-removes-them-and-cold-keeps-them', async () => {
      await store.upsert(TG, at('gone', [day('2023-05-20')]));
      await store.forget(TG, 'gone');
      expect(await read('2023-05-20', '2023-05-21')).toEqual([]);
      const cold = await seedCold(
        store,
        at('cold', [day('2023-05-20')], { embedding: vec(1, 2, 3, 4) }),
      );
      expect(await read('2023-05-20', '2023-05-21')).toEqual([cold.id]);
      expect((await store.get(TG, 'cold'))?.occurred).toEqual(cold.occurred);
    });

    /**
     * A memory remembered with a date, and a later one that restates it, each with the event time
     * and validity bounds the write path reads from its text. `forgetMemory` rewrites the later
     * one (with a writer that answers `rewritten`) and must leave no date that only the forgotten
     * text stated, in the memory or in `occurredIn`. `how.refinedFrom` writes the later one with
     * that text first and refines it to `restating`; `how.newer` writes a newer memory that
     * supersedes it, or with `how.corrects` corrects it, as `observe` writes each.
     */
    const forgetRestated = async (
      restating: string,
      rewritten: string,
      first = 'The deploy of build 2.4 was on 2026-10-01.',
      entities = ['deploy'],
      how: { newer?: string; corrects?: boolean; refinedFrom?: string } = {},
    ) => {
      const turn = new Date('2026-11-02T10:00:00.000Z');
      const wrote = (answer: string): Decision => ({
        stage: 'write',
        question: 'action',
        answer,
        probability: 1,
      });
      const intervalRead = (b: { validFrom?: string; validTo?: string }): Decision[] =>
        b.validFrom === undefined && b.validTo === undefined
          ? []
          : [
              {
                stage: 'temporal',
                question: 'interval',
                answer: `${b.validFrom ?? 'turn'} .. ${b.validTo ?? 'open'}`,
                probability: 1,
              },
            ];
      const remembered = (id: string, text: string, extra: Partial<Memory> = {}) => {
        const bounds = factInterval(text, turn);
        const occurred = occurredFor(text, turn);
        return makeMemory({
          id,
          text,
          stub: text.toLowerCase().replace(/\.$/, ''),
          entities,
          validFrom: startBefore(bounds.validFrom ?? turn.toISOString(), bounds.validTo ?? null),
          validTo: bounds.validTo ?? null,
          createdAt: turn.toISOString(),
          updatedAt: turn.toISOString(),
          ...(occurred !== undefined && { occurred }),
          source: { harness: 'test', decisions: [...intervalRead(bounds), wrote('ADD')] },
          ...extra,
        });
      };
      const original = remembered('original', first, { supersededBy: 'later' });
      let later = remembered('later', how.refinedFrom ?? restating, { supersedes: 'original' });
      if (how.refinedFrom !== undefined) {
        // Refined in place: bounds its new text sets, else the earlier ones carried over.
        const b = factInterval(restating, turn);
        const to = b.validTo ?? later.validTo;
        const occurred = occurredFor(restating, turn);
        later = {
          ...later,
          text: restating,
          stub: restating.toLowerCase().replace(/\.$/, ''),
          validFrom: startBefore(b.validFrom ?? later.validFrom, to),
          validTo: to,
          ...(occurred !== undefined && { occurred }),
          source: {
            ...later.source,
            decisions: [
              ...later.source.decisions,
              ...intervalRead(b),
              { stage: 'refine', question: 'previous-text', answer: later.text, probability: 1 },
              wrote('REFINE'),
            ],
          },
        };
      }
      const writes = [original, later];
      if (how.newer !== undefined && how.corrects === true) {
        // A correction keeps bounds its own text sets, else takes the prior's; the prior keeps
        // its validity and ends by reason.
        const b = factInterval(how.newer, turn);
        const to = b.validTo ?? later.validTo;
        const n = remembered('newer', how.newer, {
          supersedes: 'later',
          validFrom: startBefore(b.validFrom ?? later.validFrom, to),
          validTo: to,
        });
        later = {
          ...later,
          expiredAt: turn.toISOString(),
          endReason: 'corrected',
          supersededBy: 'newer',
        };
        writes.splice(1, 1, later, n);
      } else if (how.newer !== undefined) {
        // A newer fact supersedes it, closing it where the newer one starts, as observe does.
        const n = remembered('newer', how.newer, { supersedes: 'later' });
        later = {
          ...later,
          validTo:
            Date.parse(n.validFrom) > Date.parse(later.validFrom) ? n.validFrom : later.validFrom,
          endReason: 'superseded',
          supersededBy: 'newer',
        };
        writes.splice(1, 1, later, n);
      }
      await store.upsertMany(TG, writes);
      const write: MemoryWriter = {
        write: () => Promise.reject(new Error('not used')),
        rewriteCurrent: async (m) => ({
          text: rewritten,
          stub: rewritten.toLowerCase().replace(/\.$/, ''),
          entities: m.entities,
          type: m.type,
        }),
      };
      const outcome = await forgetMemory({ store, write }, TG, 'original');
      expect(outcome.rewritten).toEqual([{ id: 'later', text: rewritten }]);
      return {
        turn,
        before: later,
        later: (await store.get(TG, 'later'))!,
        newer: await store.get(TG, 'newer'),
      };
    };

    it('occurrences.forget-rewrite-drops-a-date-only-the-forgotten-text-stated', async () => {
      const { turn, before, later } = await forgetRestated(
        'The deploy on 2026-10-01 used build 2.5.',
        'The deploy used build 2.5.',
      );
      expect(before.occurred?.[0]).toEqual(day('2026-10-01'));
      expect(await read('2026-10-01', '2026-10-02')).toEqual([]);
      // The day it was said stays: the rewritten text was still said then.
      expect(later.occurred).toEqual(occurredFor('The deploy used build 2.5.', turn));
      expect(later.occurred?.map((o) => o.source)).toEqual(['mention']);
      expect(await read('2026-11-02', '2026-11-03')).toEqual(['later']);
    });

    it('occurrences.forget-rewrite-keeps-a-date-the-new-text-states', async () => {
      const text = 'The deploy was redone on 2026-10-08 with build 2.5.';
      const { turn, later } = await forgetRestated(
        'The deploy on 2026-10-01 was redone on 2026-10-08 with build 2.5.',
        text,
      );
      expect(later.occurred).toEqual(occurredFor(text, turn));
      expect(later.occurred?.[0]).toEqual(day('2026-10-08'));
      expect(await read('2026-10-01', '2026-10-02')).toEqual([]);
      expect(await read('2026-10-08', '2026-10-09')).toEqual(['later']);
    });

    it('occurrences.forget-rewrite-drops-a-validity-bound-only-the-forgotten-text-set', async () => {
      const { turn, before, later } = await forgetRestated(
        'The release moved from 2026-10-01 to 2026-10-08.',
        'The release is 2026-10-08.',
        'The release is on 2026-10-01.',
        ['release'],
      );
      // Written valid from 2026-10-01 to the end of 2026-10-08, read from the restating text.
      expect([before.validFrom, before.validTo]).toEqual([
        '2026-10-01T00:00:00.000Z',
        '2026-10-09T00:00:00.000Z',
      ]);
      expect(isCurrent(before, new Date('2026-10-02T12:00:00.000Z'))).toBe(true);
      // The new text sets no bound: valid from the turn it was written in, with no end.
      expect([later.validFrom, later.validTo]).toEqual([turn.toISOString(), null]);
      expect(isCurrent(later, new Date('2026-10-02T12:00:00.000Z'))).toBe(false);
      expect(isCurrent(later, new Date('2026-11-03T00:00:00.000Z'))).toBe(true);
    });

    it('occurrences.forget-rewrite-drops-a-start-moved-before-a-forgotten-end', async () => {
      const { turn, before, later } = await forgetRestated(
        'The freeze ran until 2026-10-01 and has ended.',
        'The freeze has ended.',
        'The freeze runs until 2026-10-01.',
        ['freeze'],
      );
      // The end was already past, so the start was moved back a day before it.
      expect([before.validFrom, before.validTo]).toEqual([
        '2026-10-01T00:00:00.000Z',
        '2026-10-02T00:00:00.000Z',
      ]);
      expect([later.validFrom, later.validTo]).toEqual([turn.toISOString(), null]);
    });

    it('occurrences.forget-rewrite-keeps-the-end-a-newer-fact-gave', async () => {
      const { before, later } = await forgetRestated(
        'The freeze, as before until 2026-11-30, now also blocks hotfixes.',
        'The freeze now also blocks hotfixes.',
        'The freeze runs until 2026-11-30.',
        ['freeze'],
        { newer: 'Starting 2026-12-01 the freeze is lifted.' },
      );
      // Its text's end and the newer fact's start are the same midnight.
      expect(before.validTo).toBe('2026-12-01T00:00:00.000Z');
      expect(later.validTo).toBe(before.validTo);
      expect(later.supersededBy).toBe('newer');
      const after = new Date('2026-12-02T00:00:00.000Z');
      expect(isCurrent(later, after)).toBe(false);
      expect(isCurrent((await store.get(TG, 'newer'))!, after)).toBe(true);
    });

    it('occurrences.forget-rewrite-never-leaves-the-end-before-the-start', async () => {
      const { later } = await forgetRestated(
        'The freeze, set until 2026-12-01 before, ran until 2026-10-15.',
        'The freeze ran until 2026-10-15.',
        'The freeze is set until 2026-12-01.',
        ['freeze'],
      );
      expect(later.validTo).toBe('2026-10-16T00:00:00.000Z');
      expect(Date.parse(later.validFrom)).toBeLessThan(Date.parse(later.validTo!));
    });

    it('occurrences.forget-rewrite-gives-its-new-end-to-a-correction-that-copied-it', async () => {
      const { before, later, newer } = await forgetRestated(
        'The freeze, still until 2026-12-01, now blocks hotfixes.',
        'The freeze now blocks hotfixes.',
        'The freeze runs until 2026-12-01.',
        ['freeze'],
        { newer: 'Correction: it blocks hotfixes and merges.', corrects: true },
      );
      expect(before.validTo).toBe('2026-12-02T00:00:00.000Z');
      // The corrected memory's end came from its own text: read again, there is none.
      expect(later.validTo).toBeNull();
      expect(later.endReason).toBe('corrected');
      // The correction set no end of its own and copied that one: it gets the new end, and keeps
      // its text.
      expect(newer?.validTo).toBeNull();
      expect(newer?.text).toBe('Correction: it blocks hotfixes and merges.');
      expect(isCurrent(newer!, new Date('2026-12-03T00:00:00.000Z'))).toBe(true);
    });

    it('occurrences.forget-rewrite-reads-an-end-a-refine-carried-over', async () => {
      const { before, later } = await forgetRestated(
        'The 2026-12-01 freeze also blocks hotfixes.',
        'The freeze also blocks hotfixes.',
        'The freeze runs until 2026-12-01.',
        ['freeze'],
        { refinedFrom: 'The freeze still runs until 2026-12-01.' },
      );
      // The refined text sets no end; the end came with the text before it.
      expect(before.validTo).toBe('2026-12-02T00:00:00.000Z');
      expect(later.validTo).toBeNull();
      expect(isCurrent(later, new Date('2026-12-03T00:00:00.000Z'))).toBe(true);
    });
  });
}

/** A valid pending prediction at the local Planet, with test defaults. */
export function makePrediction(overrides: Partial<Prediction> & { id: string }): Prediction {
  return {
    scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    item: { summary: 'Post claims a cure without a source', domain: 'content' },
    domain: 'content',
    outcome: 'suggested',
    verdict: 'rejected',
    probability: 0.8,
    verdicts: ['approved', 'rejected'],
    precedentIds: ['j1', 'j2'],
    criteria: ['no-source'],
    similarity: 'lexical',
    threshold: 0.7,
    revision: 0,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    expiresAt: '2026-12-16T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * The prediction records of a store with `predictions: true`: write guards, grant isolation,
 * the status and citing filters, newest-first order, and that a prediction is never a memory.
 */
export function predictionsConformance(name: string, make: () => Promise<MemoryStore>): void {
  describe(`store predictions: ${name}`, () => {
    let store: MemoryStore;
    type S = Required<
      Pick<MemoryStore, 'putPrediction' | 'getPrediction' | 'listPredictions' | 'forgetPrediction'>
    >;
    let s: S;

    beforeEach(async () => {
      store = await make();
      expect(store.predictions).toBe(true);
      s = store as MemoryStore & S;
    });

    afterEach(async () => {
      await store.close();
    });

    const other: Grant = principalGrant({ orgId: 'other', customerId: 'c', agentId: 'a' });

    it('predictions.put-get-roundtrip', async () => {
      const p = makePrediction({ id: 'p1', item: { summary: 'One', details: 'More', ref: 'x#1' } });
      expect(await s.putPrediction(TG, p)).toBe(true);
      expect(await s.getPrediction(TG, 'p1')).toEqual(p);
      expect(await s.getPrediction(TG, 'nope')).toBeNull();
    });

    it('predictions.label-origin-roundtrips', async () => {
      // A resolve keeps how it arrived. One written before origins were kept reads `agent` when an
      // agent resolved it and no person confirmed it, else `integration`.
      const resolution = {
        verdict: 'approved',
        criteria: [],
        by: 'ada',
        at: '2026-11-16T11:00:00.000Z',
        via: 'mcp' as const,
        agrees: false,
      };
      const confirmed = makePrediction({
        id: 'p1',
        resolution: {
          ...resolution,
          origin: 'interactive',
          proposedOrigin: 'agent',
          confirmed: { at: '2026-11-16T11:30:00.000Z', by: 'ada' },
        },
      });
      const sdk = makePrediction({
        id: 'p2',
        resolution: { ...resolution, via: 'sdk', origin: 'integration', reviewer: 'grace' },
      });
      const old = makePrediction({ id: 'p3', resolution: { ...resolution, via: 'cli' } });
      const oldAgent = makePrediction({ id: 'p4', resolution });
      const oldConfirmed = makePrediction({
        id: 'p5',
        resolution: { ...resolution, confirmed: { at: '2026-11-16T11:30:00.000Z', by: 'ada' } },
      });
      for (const p of [confirmed, sdk, old, oldAgent, oldConfirmed]) {
        expect(await s.putPrediction(TG, p)).toBe(true);
      }
      expect(await s.getPrediction(TG, 'p1')).toEqual(confirmed);
      expect(await s.getPrediction(TG, 'p2')).toEqual(sdk);
      const got = await s.getPrediction(TG, 'p3');
      expect(got).toEqual(old);
      expect(labelOrigin(got?.resolution)).toBe('integration');
      const agentRow = await s.getPrediction(TG, 'p4');
      expect(agentRow).toEqual(oldAgent);
      expect(labelOrigin(agentRow?.resolution)).toBe('agent');
      const listed = await s.listPredictions(TG, { status: 'resolved' });
      expect(Object.fromEntries(listed.map((p) => [p.id, labelOrigin(p.resolution)]))).toEqual({
        p1: 'interactive',
        p2: 'integration',
        p3: 'integration',
        p4: 'agent',
        p5: 'integration',
      });
    });

    it('predictions.revision-guard', async () => {
      const p = makePrediction({ id: 'p1' });
      expect(await s.putPrediction(TG, p, { revision: null })).toBe(true);
      // Inserting again with `revision: null` fails: the id exists.
      expect(await s.putPrediction(TG, p, { revision: null })).toBe(false);
      const next = { ...p, revision: 1, verdict: 'approved' };
      expect(await s.putPrediction(TG, next, { revision: 5 })).toBe(false);
      expect((await s.getPrediction(TG, 'p1'))?.verdict).toBe('rejected');
      expect(await s.putPrediction(TG, next, { revision: 0 })).toBe(true);
      expect(await s.putPrediction(TG, { ...p, revision: 1 }, { revision: 0 })).toBe(false);
      expect((await s.getPrediction(TG, 'p1'))?.verdict).toBe('approved');
    });

    it('predictions.outside-the-grant-looks-missing', async () => {
      await s.putPrediction(TG, makePrediction({ id: 'p1' }));
      expect(await s.getPrediction(other, 'p1')).toBeNull();
      expect(await s.listPredictions(other)).toEqual([]);
      expect(await s.forgetPrediction(other, 'p1')).toBe(false);
      // Another grant cannot write a record at an address it does not cover.
      await expect(s.putPrediction(other, makePrediction({ id: 'p2' }))).rejects.toBeInstanceOf(
        GrantError,
      );
      // Nor take over an id that lives elsewhere.
      const theirs = makePrediction({
        id: 'p1',
        scope: { orgId: 'other', customerId: 'c', agentId: 'a' },
      });
      expect(await s.putPrediction(other, theirs)).toBe(false);
      expect(await s.getPrediction(TG, 'p1')).not.toBeNull();
    });

    it('predictions.list-filters-and-order', async () => {
      const resolution = {
        verdict: 'approved',
        criteria: [],
        by: 'ada',
        at: '2026-11-16T12:00:00.000Z',
        via: 'cli' as const,
        agrees: false,
        judgmentId: 'j9',
      };
      await s.putPrediction(TG, makePrediction({ id: 'a', createdAt: '2026-11-16T10:00:00.000Z' }));
      await s.putPrediction(
        TG,
        makePrediction({ id: 'b', createdAt: '2026-11-16T11:00:00.000Z', resolution }),
      );
      await s.putPrediction(
        TG,
        makePrediction({ id: 'c', createdAt: '2026-11-16T11:00:00.000Z', precedentIds: ['j3'] }),
      );
      expect(ids(await s.listPredictions(TG))).toEqual(['c', 'b', 'a']);
      expect(ids(await s.listPredictions(TG, { status: 'pending' }))).toEqual(['c', 'a']);
      expect(ids(await s.listPredictions(TG, { status: 'resolved' }))).toEqual(['b']);
      expect(ids(await s.listPredictions(TG, { citing: 'j1' }))).toEqual(['b', 'a']);
      expect(ids(await s.listPredictions(TG, { citing: 'j9' }))).toEqual(['b']);
      expect(ids(await s.listPredictions(TG, { limit: 2 }))).toEqual(['c', 'b']);
      expect(ids(await s.listPredictions(TG, { idPrefix: 'b' }))).toEqual(['b']);
      expect(ids(await s.listPredictions(TG, { idPrefix: '%' }))).toEqual([]);
      expect(ids(await s.listPredictions(TG, { idPrefix: '_' }))).toEqual([]);
      expect(ids(await s.listPredictions(TG, { domain: 'content' }))).toEqual(['c', 'b', 'a']);
      expect(ids(await s.listPredictions(TG, { domain: 'legal' }))).toEqual([]);
      // Pending and not expired at that time; a resolved one is never "expired".
      expect(
        ids(
          await s.listPredictions(TG, {
            status: 'pending',
            unexpiredAt: '2026-12-16T10:00:00.000Z',
          }),
        ),
      ).toEqual([]);
      expect(ids(await s.listPredictions(TG, { unexpiredAt: '2027-01-01T00:00:00.000Z' }))).toEqual(
        ['b'],
      );
    });

    it('predictions.the-limit-applies-after-the-grant', async () => {
      const theirs = { orgId: 'other', customerId: 'c', agentId: 'a' };
      for (let i = 0; i < 5; i++) {
        await s.putPrediction(
          other,
          makePrediction({ id: `o${i}`, scope: theirs, createdAt: '2026-11-17T00:00:00.000Z' }),
        );
      }
      await s.putPrediction(TG, makePrediction({ id: 'a' }));
      await s.putPrediction(TG, makePrediction({ id: 'b' }));
      expect(ids(await s.listPredictions(TG, { limit: 2 }))).toEqual(['b', 'a']);
      expect(ids(await s.listPredictions(TG, { idPrefix: 'o' }))).toEqual([]);
    });

    it('predictions.purge-citing-reaches-every-address-and-keeps-no-text', async () => {
      const theirs = { orgId: 'other', customerId: 'c', agentId: 'a' };
      await s.putPrediction(
        TG,
        makePrediction({ id: 'mine', item: { summary: 'zanzibar mine' }, precedentIds: ['j1'] }),
      );
      await s.putPrediction(
        other,
        makePrediction({
          id: 'theirs',
          scope: theirs,
          item: { summary: 'zanzibar theirs' },
          precedentIds: ['j1'],
        }),
      );
      await s.putPrediction(TG, makePrediction({ id: 'apart', precedentIds: ['j2'] }));
      const at = new Date('2026-11-16T12:00:00.000Z');
      const r = await store.purgePredictionsCiting!(TG, 'j1', 'grace', at);
      expect([...r.purged].sort()).toEqual(['mine', 'theirs']);
      expect(r.leftover).toEqual([]);
      for (const [g, id] of [
        [TG, 'mine'],
        [other, 'theirs'],
      ] as const) {
        const p = (await s.getPrediction(g, id))!;
        expect(p.purged).toEqual({ at: at.toISOString(), by: 'grace' });
        expect(JSON.stringify(p)).not.toContain('zanzibar');
      }
      expect((await s.getPrediction(TG, 'apart'))?.purged).toBeUndefined();
      // Purged ones are not purged again.
      expect((await store.purgePredictionsCiting!(TG, 'j1', 'grace', at)).purged).toEqual([]);
    });

    it('predictions.prune-and-count-pending', async () => {
      const theirs = { orgId: 'other', customerId: 'c', agentId: 'a' };
      const resolution = {
        verdict: 'approved',
        criteria: [],
        by: 'ada',
        at: '2026-11-16T12:00:00.000Z',
        via: 'cli' as const,
        agrees: false,
      };
      await s.putPrediction(
        TG,
        makePrediction({ id: 'old1', expiresAt: '2026-11-01T00:00:00.000Z' }),
      );
      await s.putPrediction(
        TG,
        makePrediction({ id: 'old2', expiresAt: '2026-11-02T00:00:00.000Z' }),
      );
      await s.putPrediction(
        TG,
        makePrediction({ id: 'oldDone', expiresAt: '2026-11-01T00:00:00.000Z', resolution }),
      );
      await s.putPrediction(TG, makePrediction({ id: 'live' }));
      await s.putPrediction(
        other,
        makePrediction({ id: 'theirsOld', scope: theirs, expiresAt: '2026-11-01T00:00:00.000Z' }),
      );
      expect(await store.countPendingPredictions!(makePrediction({ id: 'x' }))).toBe(3);
      const now = new Date('2026-11-16T00:00:00.000Z');
      expect(await store.pruneExpiredPredictions!(now, 2)).toBe(2);
      expect(await store.pruneExpiredPredictions!(now, 100)).toBe(1);
      expect(await store.pruneExpiredPredictions!(now, 100)).toBe(0);
      // Resolved ones are kept, at any age.
      expect(ids(await s.listPredictions(TG))).toEqual(['oldDone', 'live'].sort().reverse());
      expect(await s.getPrediction(other, 'theirsOld')).toBeNull();
      expect(await store.countPendingPredictions!(makePrediction({ id: 'x' }))).toBe(1);
      expect(await store.countPendingPredictions!(makePrediction({ id: 'x', scope: theirs }))).toBe(
        0,
      );
    });

    it('predictions.forget-removes-the-record', async () => {
      await s.putPrediction(TG, makePrediction({ id: 'p1' }));
      expect(await s.forgetPrediction(TG, 'p1')).toBe(true);
      expect(await s.getPrediction(TG, 'p1')).toBeNull();
      expect(await s.listPredictions(TG)).toEqual([]);
      expect(await s.forgetPrediction(TG, 'p1')).toBe(false);
    });

    it('predictions.forget-with-expect-deletes-only-the-revision-read', async () => {
      await s.putPrediction(TG, makePrediction({ id: 'p1', revision: 3 }));
      expect(await s.forgetPrediction(TG, 'p1', { revision: 2 })).toBe(false);
      expect((await s.getPrediction(TG, 'p1'))?.revision).toBe(3);
      expect(await s.forgetPrediction(TG, 'p1', { revision: 3 })).toBe(true);
      expect(await s.getPrediction(TG, 'p1')).toBeNull();
      expect(await s.forgetPrediction(TG, 'p1', { revision: 3 })).toBe(false);
    });

    it('predictions.pending-is-counted-per-author-at-a-node-in-every-project', async () => {
      const planet: Address = { level: 'user', orgId: 'local', customerId: 'self' };
      const by = (agentId: string) => addressed(planet, { agentId });
      await s.putPrediction(TG, makePrediction({ id: 'a1', ...by('claude-code') }));
      await s.putPrediction(TG, makePrediction({ id: 'b1', ...by('cursor') }));
      await s.putPrediction(TG, makePrediction({ id: 'b2', ...by('cursor') }));
      expect(await s.listPredictions(TG)).toHaveLength(3);
      expect(
        await store.countPendingPredictions!(makePrediction({ id: 'x', ...by('claude-code') })),
      ).toBe(1);
      expect(
        await store.countPendingPredictions!(makePrediction({ id: 'x', ...by('cursor') })),
      ).toBe(2);
      expect(
        await store.countPendingPredictions!(makePrediction({ id: 'x', ...by('codex') })),
      ).toBe(0);
      // At the node, in every project: binding predictions to projects does not multiply the cap.
      const inB = addressed({ ...planet, projectId: 'proj-b' }, { agentId: 'cursor' });
      await s.putPrediction(TG, makePrediction({ id: 'b3', ...inB }));
      expect(await store.countPendingPredictions!(makePrediction({ id: 'x', ...inB }))).toBe(3);
      expect(
        await store.countPendingPredictions!(makePrediction({ id: 'x', ...by('cursor') })),
      ).toBe(3);
    });

    it('predictions.the-caps-are-counted-in-the-write', async () => {
      const planet: Address = { level: 'user', orgId: 'local', customerId: 'self' };
      const at = (agentId: string, projectId?: string) =>
        addressed({ ...planet, ...(projectId !== undefined && { projectId }) }, { agentId });
      const caps = { pendingCap: 2, addressPendingCap: 3 };
      const put = (id: string, agentId: string, projectId?: string) =>
        s.putPrediction(
          TG,
          makePrediction({ id, ...at(agentId, projectId) }),
          { revision: null },
          caps,
        );
      expect(await put('a1', 'claude-code')).toBe(true);
      expect(await put('a2', 'claude-code', 'proj-b')).toBe(true);
      // Its author's cap, across projects.
      expect(await put('a3', 'claude-code', 'proj-c')).toBe('pending-cap');
      expect(await put('b1', 'cursor')).toBe(true);
      // Every author together: the node's cap.
      expect(await put('c1', 'codex', 'proj-d')).toBe('pending-cap');
      expect(await s.listPredictions(TG)).toHaveLength(3);
      // A write without caps is not checked.
      expect(await s.putPrediction(TG, makePrediction({ id: 'c2', ...at('codex') }))).toBe(true);
      // Concurrent writers never pass the node's cap.
      const more = await Promise.all(
        ['d1', 'd2', 'd3'].map((id, i) =>
          s.putPrediction(
            TG,
            makePrediction({ id, ...at(`agent-${i}`) }),
            { revision: null },
            { addressPendingCap: 5 },
          ),
        ),
      );
      expect(more.filter((w) => w === true)).toHaveLength(1);
    });

    it('predictions.are-not-memories', async () => {
      await s.putPrediction(TG, makePrediction({ id: 'p1', item: { summary: 'zebra quokka' } }));
      expect(await store.get(TG, 'p1')).toBeNull();
      expect(await store.list(TG, { validOnly: false })).toEqual([]);
      expect(await store.lexical(TG, 'zebra quokka', 10)).toEqual([]);
    });
  });
}

/** A valid open `wrong` feedback row at the local Planet, with test defaults. */
export function makeFeedback(overrides: Partial<Feedback> & { id: string }): Feedback {
  return {
    scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    memoryId: 'm1',
    signal: 'wrong',
    note: 'The port moved to 8080',
    by: 'ada',
    via: 'cli',
    status: 'open',
    revision: 0,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * The recall feedback rows of a store with `feedback: true`: write guards and what a write that
 * did not land says, grant and project isolation, the filters and newest-first order, the pending
 * cap and the once-a-day `helped` key inside the write, no row about a memory the store does not
 * hold, and that forgetting a memory removes every row about it, at every address, rows other
 * principals wrote included.
 */
export function feedbackConformance(name: string, make: () => Promise<MemoryStore>): void {
  describe(`store feedback: ${name}`, () => {
    let store: MemoryStore;
    type S = Required<
      Pick<
        MemoryStore,
        'putFeedback' | 'getFeedback' | 'listFeedback' | 'purgeFeedbackFor' | 'countPendingFeedback'
      >
    >;
    let s: S;

    beforeEach(async () => {
      store = await make();
      expect(store.feedback).toBe(true);
      s = store as MemoryStore & S;
      // Feedback is about a memory the store holds.
      await store.upsert(TG, makeMemory({ id: 'm1' }));
      await store.upsert(TG, makeMemory({ id: 'm2' }));
    });

    afterEach(async () => {
      await store.close();
    });

    const theirs = { orgId: 'other', customerId: 'c', agentId: 'a' };
    const other: Grant = principalGrant(theirs);

    it('feedback.put-get-roundtrip', async () => {
      const f = makeFeedback({ id: 'f1', query: 'which port' });
      expect(await s.putFeedback(TG, f)).toBe('written');
      expect(await s.getFeedback(TG, 'f1')).toEqual(f);
      expect(await s.getFeedback(TG, 'nope')).toBeNull();
    });

    it('feedback.label-origin-roundtrips', async () => {
      // A row keeps how it arrived. One written before origins were kept reads `agent` when an
      // agent gave it and no person confirmed it, else `integration`.
      const confirmed = makeFeedback({
        id: 'f1',
        via: 'mcp',
        origin: 'interactive',
        proposedOrigin: 'agent',
        confirmed: { at: '2026-11-16T11:00:00.000Z', by: 'ada' },
      });
      const connector = makeFeedback({
        id: 'f2',
        via: 'sdk',
        origin: 'connector',
        reviewer: 'grace',
        upstream: { system: 'zendesk', actor: 'grace' },
      });
      const old = makeFeedback({ id: 'f3' });
      const oldAgent = makeFeedback({ id: 'f4', via: 'mcp', status: 'pending' });
      const oldConfirmed = makeFeedback({
        id: 'f5',
        via: 'mcp',
        confirmed: { at: '2026-11-16T11:00:00.000Z', by: 'ada' },
      });
      for (const f of [confirmed, connector, old, oldAgent, oldConfirmed]) {
        expect(await s.putFeedback(TG, f)).toBe('written');
      }
      expect(await s.getFeedback(TG, 'f1')).toEqual(confirmed);
      expect(await s.getFeedback(TG, 'f2')).toEqual(connector);
      const got = await s.getFeedback(TG, 'f3');
      expect(got).toEqual(old);
      expect(labelOrigin(got ?? undefined)).toBe('integration');
      const agentRow = await s.getFeedback(TG, 'f4');
      expect(agentRow).toEqual(oldAgent);
      expect(labelOrigin(agentRow ?? undefined)).toBe('agent');
      const listed = await s.listFeedback(TG);
      expect(Object.fromEntries(listed.map((f) => [f.id, labelOrigin(f)]))).toEqual({
        f1: 'interactive',
        f2: 'connector',
        f3: 'integration',
        f4: 'agent',
        f5: 'integration',
      });
    });

    it('feedback.revision-guard', async () => {
      const f = makeFeedback({ id: 'f1' });
      expect(await s.putFeedback(TG, f, { revision: null })).toBe('written');
      expect(await s.putFeedback(TG, f, { revision: null })).toBe('conflict');
      const next = { ...f, status: 'dismissed' as const, revision: 1 };
      expect(await s.putFeedback(TG, next, { revision: 5 })).toBe('conflict');
      expect((await s.getFeedback(TG, 'f1'))?.status).toBe('open');
      expect(await s.putFeedback(TG, next, { revision: 0 })).toBe('written');
      // The second of two writers that read revision 0 loses.
      expect(
        await s.putFeedback(TG, { ...f, status: 'retired', revision: 1 }, { revision: 0 }),
      ).toBe('conflict');
      expect((await s.getFeedback(TG, 'f1'))?.status).toBe('dismissed');
    });

    it('feedback.no-new-row-about-a-memory-the-store-does-not-hold', async () => {
      expect(await s.putFeedback(TG, makeFeedback({ id: 'f1', memoryId: 'gone' }))).toBe(
        'memory-gone',
      );
      expect(await s.getFeedback(TG, 'f1')).toBeNull();
      // A row written before its memory was forgotten went with it; nothing brings it back.
      await s.putFeedback(TG, makeFeedback({ id: 'f2' }));
      await store.forget(TG, 'm1');
      expect(
        await s.putFeedback(TG, makeFeedback({ id: 'f2', revision: 1 }), { revision: 0 }),
      ).toBe('conflict');
      expect(await s.getFeedback(TG, 'f2')).toBeNull();
    });

    it('feedback.outside-the-grant-looks-missing', async () => {
      await s.putFeedback(TG, makeFeedback({ id: 'f1' }));
      expect(await s.getFeedback(other, 'f1')).toBeNull();
      expect(await s.listFeedback(other)).toEqual([]);
      expect(await s.listFeedback(other, { memoryIds: ['m1'] })).toEqual([]);
      await expect(s.putFeedback(other, makeFeedback({ id: 'f2' }))).rejects.toBeInstanceOf(
        GrantError,
      );
      // Nor take over an id that lives elsewhere.
      expect(await s.putFeedback(other, makeFeedback({ id: 'f1', scope: theirs }))).toBe(
        'conflict',
      );
      expect((await s.getFeedback(TG, 'f1'))?.scope.orgId).toBe('local');
    });

    it('feedback.a-row-bound-to-a-project-is-read-only-where-that-project-is', async () => {
      const local = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
      const inA = makeFeedback({ id: 'fa', scope: { ...local, projectId: 'proj-a' } });
      expect(await s.putFeedback(TG, inA)).toBe('written');
      await s.putFeedback(TG, makeFeedback({ id: 'fg' }));
      const a = localGrant({ ...local, projectIds: ['proj-a', null] });
      const b = localGrant({ ...local, projectIds: ['proj-b', null] });
      expect(ids(await s.listFeedback(a))).toEqual(['fg', 'fa']);
      expect(ids(await s.listFeedback(b))).toEqual(['fg']);
      expect(ids(await s.listFeedback(b, { memoryIds: ['m1'] }))).toEqual(['fg']);
      expect(ids(await s.listFeedback(b, { idPrefix: 'f' }))).toEqual(['fg']);
      expect(await s.getFeedback(b, 'fa')).toBeNull();
      expect(await s.getFeedback(a, 'fa')).not.toBeNull();
      await expect(
        s.putFeedback(b, { ...inA, status: 'dismissed', revision: 1 }, { revision: 0 }),
      ).rejects.toBeInstanceOf(GrantError);
    });

    it('feedback.list-filters-and-order', async () => {
      await s.putFeedback(TG, makeFeedback({ id: 'a', createdAt: '2026-11-16T10:00:00.000Z' }));
      await s.putFeedback(
        TG,
        makeFeedback({
          id: 'b',
          memoryId: 'm2',
          signal: 'helped',
          status: 'recorded',
          createdAt: '2026-11-16T11:00:00.000Z',
        }),
      );
      await s.putFeedback(
        TG,
        makeFeedback({
          id: 'c',
          signal: 'stale',
          status: 'pending',
          via: 'mcp',
          createdAt: '2026-11-16T11:00:00.000Z',
        }),
      );
      expect(ids(await s.listFeedback(TG))).toEqual(['c', 'b', 'a']);
      expect(ids(await s.listFeedback(TG, { status: 'open' }))).toEqual(['a']);
      expect(ids(await s.listFeedback(TG, { status: ['open', 'pending'] }))).toEqual(['c', 'a']);
      expect(ids(await s.listFeedback(TG, { memoryIds: ['m1'] }))).toEqual(['c', 'a']);
      expect(ids(await s.listFeedback(TG, { memoryIds: ['m2', 'zz'] }))).toEqual(['b']);
      expect(ids(await s.listFeedback(TG, { memoryIds: [] }))).toEqual([]);
      expect(ids(await s.listFeedback(TG, { signal: 'helped' }))).toEqual(['b']);
      expect(ids(await s.listFeedback(TG, { idPrefix: 'a' }))).toEqual(['a']);
      expect(ids(await s.listFeedback(TG, { idPrefix: '%' }))).toEqual([]);
      expect(ids(await s.listFeedback(TG, { idPrefix: '_' }))).toEqual([]);
      expect(ids(await s.listFeedback(TG, { limit: 2 }))).toEqual(['c', 'b']);
      expect(
        ids(await s.listFeedback(TG, { memoryIds: ['m1'], status: 'open', signal: 'wrong' })),
      ).toEqual(['a']);
      expect(
        ids(await s.listFeedback(TG, { memoryIds: ['m1', 'm2'], status: ['open', 'recorded'] })),
      ).toEqual(['b', 'a']);
      expect(ids(await s.listFeedback(TG, { status: 'open', signal: 'stale' }))).toEqual([]);
    });

    it('feedback.the-limit-applies-after-the-grant', async () => {
      for (let i = 0; i < 5; i++) {
        await s.putFeedback(
          other,
          makeFeedback({ id: `o${i}`, scope: theirs, createdAt: '2026-11-17T00:00:00.000Z' }),
        );
      }
      await s.putFeedback(TG, makeFeedback({ id: 'a' }));
      await s.putFeedback(TG, makeFeedback({ id: 'b' }));
      expect(ids(await s.listFeedback(TG, { limit: 2 }))).toEqual(['b', 'a']);
      expect(ids(await s.listFeedback(TG, { memoryIds: ['m1'], limit: 1 }))).toEqual(['b']);
    });

    it('feedback.purge-for-a-memory-reaches-every-address', async () => {
      await s.putFeedback(TG, makeFeedback({ id: 'mine', note: 'zanzibar mine' }));
      await s.putFeedback(
        other,
        makeFeedback({ id: 'theirs', scope: theirs, note: 'zanzibar theirs', via: 'mcp' }),
      );
      await s.putFeedback(TG, makeFeedback({ id: 'apart', memoryId: 'm2' }));
      // A grant that cannot change the memory removes nothing, not even its own rows.
      expect((await s.purgeFeedbackFor(other, 'm1')).removed).toEqual([]);
      expect(await s.getFeedback(other, 'theirs')).not.toBeNull();
      const r = await s.purgeFeedbackFor(TG, 'm1');
      expect([...r.removed].sort()).toEqual(['mine', 'theirs']);
      expect(r.leftover).toEqual([]);
      expect(await s.getFeedback(TG, 'mine')).toBeNull();
      expect(await s.getFeedback(other, 'theirs')).toBeNull();
      expect(await s.getFeedback(TG, 'apart')).not.toBeNull();
      expect((await s.purgeFeedbackFor(TG, 'm1')).removed).toEqual([]);
    });

    it('feedback.forget-removes-the-rows-about-the-memory-at-every-address', async () => {
      await s.putFeedback(TG, makeFeedback({ id: 'mine' }));
      await s.putFeedback(other, makeFeedback({ id: 'theirs', scope: theirs }));
      await s.putFeedback(TG, makeFeedback({ id: 'apart', memoryId: 'm2' }));
      // A grant that cannot change the memory forgets nothing, and no feedback goes.
      await store.forget(other, 'm1');
      expect(await s.getFeedback(TG, 'mine')).not.toBeNull();
      await store.forget(TG, 'm1');
      expect(await s.getFeedback(TG, 'mine')).toBeNull();
      expect(await s.getFeedback(other, 'theirs')).toBeNull();
      expect(ids(await s.listFeedback(TG))).toEqual(['apart']);
    });

    it('feedback.pending-is-counted-per-author-at-a-node-and-capped-in-the-write', async () => {
      const planet: Address = { level: 'user', orgId: 'local', customerId: 'self' };
      const by = (agentId: string) => addressed(planet, { agentId });
      const pending = { status: 'pending' as const, via: 'mcp' as const };
      const cap = { pendingCap: 2 };
      const put = (id: string, agentId: string, extra: Partial<Feedback> = pending) =>
        s.putFeedback(TG, makeFeedback({ id, ...extra, ...by(agentId) }), undefined, cap);
      expect(await put('a1', 'claude-code')).toBe('written');
      expect(await put('b1', 'cursor')).toBe('written');
      expect(await put('b2', 'cursor')).toBe('written');
      expect(await put('b3', 'cursor')).toBe('pending-cap');
      // At the node, in every project: an agent at the cap in one project is refused in another.
      const inB = addressed({ ...planet, projectId: 'proj-b' }, { agentId: 'cursor' });
      expect(
        await s.putFeedback(TG, makeFeedback({ id: 'b5', ...pending, ...inB }), undefined, cap),
      ).toBe('pending-cap');
      expect(await s.countPendingFeedback(makeFeedback({ id: 'x', ...inB }))).toBe(2);
      // The cap counts pending rows only, and only for a new pending row.
      expect(await put('b4', 'cursor', {})).toBe('written');
      const at = (agentId: string) => makeFeedback({ id: 'x', ...by(agentId) });
      expect(await s.countPendingFeedback(at('claude-code'))).toBe(1);
      expect(await s.countPendingFeedback(at('cursor'))).toBe(2);
      expect(await s.countPendingFeedback(at('codex'))).toBe(0);
      expect(await s.countPendingFeedback(makeFeedback({ id: 'x', scope: theirs }))).toBe(0);
      // Concurrent writers never pass the cap.
      const many = await Promise.all(Array.from({ length: 6 }, (_, i) => put(`c${i}`, 'codex')));
      expect(many.filter((w) => w === 'written')).toHaveLength(2);
    });

    it('feedback.all-authors-together-are-capped-at-the-node', async () => {
      const planet: Address = { level: 'user', orgId: 'local', customerId: 'self' };
      const at = (agentId: string, projectId?: string) =>
        addressed({ ...planet, ...(projectId !== undefined && { projectId }) }, { agentId });
      const pending = { status: 'pending' as const, via: 'mcp' as const };
      const caps = { pendingCap: 10, addressPendingCap: 3 };
      const put = (id: string, agentId: string, projectId?: string) =>
        s.putFeedback(
          TG,
          makeFeedback({ id, ...pending, ...at(agentId, projectId) }),
          undefined,
          caps,
        );
      expect(await put('a1', 'claude-code')).toBe('written');
      expect(await put('b1', 'cursor', 'proj-b')).toBe('written');
      expect(await put('c1', 'codex', 'proj-c')).toBe('written');
      expect(await put('d1', 'zed')).toBe('pending-cap');
      expect(await put('d2', 'zed', 'proj-d')).toBe('pending-cap');
      // A person's row is not pending: the cap does not apply to it.
      expect(
        await s.putFeedback(TG, makeFeedback({ id: 'e1', ...at('zed') }), undefined, caps),
      ).toBe('written');
      // Concurrent writers by different authors never pass it.
      const many = await Promise.all(
        ['f1', 'f2', 'f3'].map((id, i) =>
          s.putFeedback(TG, makeFeedback({ id, ...pending, ...at(`agent-${i}`) }), undefined, {
            addressPendingCap: 4,
          }),
        ),
      );
      expect(many.filter((w) => w === 'written')).toHaveLength(1);
    });

    it('feedback.one-row-holds-a-helped-key', async () => {
      const key = 'm1|ada|2026-11-16';
      const helped = (id: string) =>
        makeFeedback({ id, signal: 'helped', status: 'recorded', applied: true, helpedKey: key });
      const all = await Promise.all(
        ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => s.putFeedback(TG, helped(id))),
      );
      expect(all.filter((w) => w === 'written')).toHaveLength(1);
      expect(all.filter((w) => w === 'helped-today')).toHaveLength(4);
      const [winner] = await s.listFeedback(TG, { signal: 'helped' });
      // The row that holds it may write itself again; another day is another key.
      expect(await s.putFeedback(TG, { ...winner!, revision: 1 }, { revision: 0 })).toBe('written');
      expect(await s.putFeedback(TG, { ...helped('h6'), helpedKey: 'm1|ada|2026-11-17' })).toBe(
        'written',
      );
      // A row that lets the key go frees it.
      const { helpedKey: _k, ...released } = winner!;
      expect(
        await s.putFeedback(TG, { ...released, applied: false, revision: 2 }, { revision: 1 }),
      ).toBe('written');
      expect(await s.putFeedback(TG, helped('h7'))).toBe('written');
    });

    it('feedback.is-not-a-memory', async () => {
      await s.putFeedback(TG, makeFeedback({ id: 'f1', note: 'zebra quokka' }));
      expect(await store.get(TG, 'f1')).toBeNull();
      expect(ids(await store.list(TG, { validOnly: false })).sort()).toEqual(['m1', 'm2']);
      expect(await store.lexical(TG, 'zebra quokka', 10)).toEqual([]);
    });
  });
}

/**
 * Twenty resolved predictions, by hand:
 *
 * | band       | probabilities (agrees)                          | n | agreed | agreement | mean   |
 * | [0.9, 1]   | .95 T, .92 T, .91 T, .97 F, 1 T                 | 5 | 4      | 0.8       | 0.95   |
 * | [0.8, 0.9) | .85 T, .82 T, .87 F, .82 T                      | 4 | 3      | 0.75      | 0.84   |
 * | [0.7, 0.8) | .75 T, .7 F, .79 F                              | 3 | 1      | 0.333     | 0.747  |
 * | [0.6, 0.7) | .65 T, .6 F                                     | 2 | 1      | 0.5       | 0.625  |
 * | [0.5, 0.6) | .55 F, .5 T                                     | 2 | 1      | 0.5       | 0.525  |
 * | [0, 0.5)   | .4 F, .3 F                                      | 2 | 0      | 0         | 0.35   |
 *
 * Two more had no predicted verdict (needs the expert, no precedents). Overall: 18 predicted,
 * 10 agreed (0.556). Suggested (probability at or above the 0.7 threshold): 12, 8 agreed
 * (0.667); coverage 12 of 20 (0.6). Criteria: `satire` on .75 T, .7 F, .79 F, .55 F, .4 F
 * (5, 4 disagreed, 0.8); `no-source` on the nine at 0.8 and above (9, 2 disagreed, 0.222).
 */
export function livePredictionFixtures(
  scope: Scope = { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
): Prediction[] {
  const rows: [number | null, boolean | null, string[]][] = [
    [0.95, true, ['no-source']],
    [0.92, true, ['no-source']],
    [0.91, true, ['no-source']],
    [0.97, false, ['no-source']],
    [1, true, ['no-source']],
    [0.85, true, ['no-source']],
    [0.82, true, ['no-source']],
    [0.87, false, ['no-source']],
    [0.82, true, ['no-source']],
    [0.75, true, ['satire']],
    [0.7, false, ['satire']],
    [0.79, false, ['satire']],
    [0.65, true, []],
    [0.6, false, []],
    [0.55, false, ['satire']],
    [0.5, true, []],
    [0.4, false, ['satire']],
    [0.3, false, []],
    [null, null, []],
    [null, null, []],
  ];
  const out = rows.map(([p, agrees, criteria], i): Prediction => {
    const at = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    return makePrediction({
      scope,
      id: `fixture-${String(i).padStart(2, '0')}`,
      createdAt: at,
      updatedAt: at,
      outcome: p === null ? 'needs-expert' : p >= 0.7 ? 'suggested' : 'needs-expert',
      ...(p === null
        ? { why: 'no-precedents' as const }
        : p < 0.7 && { why: 'low-confidence' as const }),
      verdict: p === null ? null : 'rejected',
      probability: p,
      criteria,
      resolution: {
        verdict: agrees === false ? 'approved' : 'rejected',
        criteria: [],
        by: 'ada',
        at,
        via: 'cli',
        agrees,
      },
    });
  });
  // One agent-recorded resolve nobody confirmed (left out) and one still pending.
  out.push(
    makePrediction({
      scope,
      id: 'fixture-agent',
      probability: 0.99,
      resolution: {
        verdict: 'approved',
        criteria: [],
        by: 'ada',
        at: '2026-11-16T12:00:00.000Z',
        via: 'mcp',
        agrees: false,
      },
    }),
    makePrediction({ scope, id: 'fixture-pending', expiresAt: '2099-01-01T00:00:00.000Z' }),
  );
  return out;
}
