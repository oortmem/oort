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
import type { Memory } from './model.js';
import { localScope } from './scope.js';

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
      await store.upsert(m);
      expect(await store.get('m1')).toEqual(m);
      expect(await store.get('missing')).toBeNull();

      const updated = { ...m, text: 'The auth service listens on port 9090' };
      await store.upsert(updated);
      expect(await store.get('m1')).toEqual(updated);
    });

    it('upsert-many-roundtrip', async () => {
      const a = makeMemory({ id: 'a', text: 'first', embedding: vec(1, 2, 3, 4) });
      const b = makeMemory({ id: 'b', text: 'second' });
      await store.upsertMany([a, b]);
      expect(await store.get('a')).toEqual(a);
      expect(await store.get('b')).toEqual(b);

      const a2 = { ...a, text: 'first, revised', embedding: vec(4, 3, 2, 1) };
      const c = makeMemory({ id: 'c', text: 'third', embedding: vec(0, 0, 0, 1) });
      await store.upsertMany([a2, c]);
      expect(await store.get('a')).toEqual(a2);
      expect(await store.get('b')).toEqual(b);
      expect(await store.get('c')).toEqual(c);
      await expect(store.upsertMany([])).resolves.toBeUndefined();
    });

    it('upsert-warm-drops-cold-copy', async () => {
      const m = makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) });
      await store.coldPut(m);
      const main = await store.get('c1');
      if (main === null) throw new Error('coldPut lost the main record');

      // Re-upserting while still cold keeps the cold copy.
      await store.upsert(main);
      expect((await store.coldGet('c1'))?.embedding).toEqual(vec(1, 2, 3, 4));

      await store.upsert({ ...main, embedding: vec(1, 2, 3, 4), tier: 'warm' });
      expect(await store.coldGet('c1')).toBeNull();
      expect((await store.get('c1'))?.tier).toBe('warm');

      await store.coldPut(makeMemory({ id: 'c2' }));
      await store.upsertMany([{ ...makeMemory({ id: 'c2' }), tier: 'hot' }]);
      expect(await store.coldGet('c2')).toBeNull();
    });

    it('lexical-finds-exact-identifier', async () => {
      await store.upsert(
        makeMemory({ id: 'target', text: 'Requests now route through auth-service-8080 only' }),
      );
      await store.upsert(makeMemory({ id: 'near', text: 'The auth service used port 3000' }));
      await store.upsert(makeMemory({ id: 'unrelated', text: 'The billing job runs nightly' }));
      const hits = await store.lexical('auth-service-8080', LOCAL, 10);
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
      await store.coldPut(m);
      const hits = await store.lexical('auth-service-8080', LOCAL, 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ id: 'c1', tier: 'cold' });
    });

    it('dense-returns-nearest', async () => {
      await store.upsert(makeMemory({ id: 'x', embedding: vec(100, 0, 0, 0) }));
      await store.upsert(makeMemory({ id: 'y', embedding: vec(0, 100, 0, 0) }));
      await store.upsert(makeMemory({ id: 'xy', embedding: vec(70, 70, 0, 0) }));
      const q = vec(100, 10, 0, 0);
      expect(ids(await store.dense(q, LOCAL, 10))).toEqual(['x', 'xy', 'y']);
      expect(ids(await store.dense(q, LOCAL, 2))).toEqual(['x', 'xy']);
    });

    it('dense-excludes-cold', async () => {
      await store.upsert(makeMemory({ id: 'warm', embedding: vec(0, 100, 0, 0) }));
      await store.upsert(makeMemory({ id: 'bare' }));
      await store.coldPut(makeMemory({ id: 'cold', embedding: vec(100, 0, 0, 0) }));
      const hits = await store.dense(vec(100, 0, 0, 0), LOCAL, 10);
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
      await store.upsert(makeMemory({ id: 'mine', text, embedding }));
      for (const [id, scope] of Object.entries(others)) {
        await store.upsert(makeMemory({ id, text, embedding, scope }));
      }
      expect(ids(await store.lexical('auth-service-8080', LOCAL, 10))).toEqual(['mine']);
      expect(ids(await store.dense(embedding, LOCAL, 10))).toEqual(['mine']);
      expect(ids(await store.list(LOCAL))).toEqual(['mine']);

      const none: ScopeFilter = { ...LOCAL, projectIds: [] };
      expect(await store.lexical('auth-service-8080', none, 10)).toEqual([]);
      expect(await store.dense(embedding, none, 10)).toEqual([]);
      expect(await store.list(none)).toEqual([]);
    });

    it('dense-rejects-dimension-mismatch', async () => {
      await store.upsert(makeMemory({ id: 'four', embedding: vec(1, 2, 3, 4) }));
      const wrong = new Int8Array(CONFORMANCE_DIMENSION + 1).fill(1);
      const err: unknown = await store.dense(wrong, LOCAL, 10).then(
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
      await store.upsert(makeMemory({ id: 'global', text, embedding, scope: localScope() }));
      await store.upsert(makeMemory({ id: 'p1', text, embedding, scope: localScope('p1') }));
      await store.upsert(makeMemory({ id: 'p2', text, embedding, scope: localScope('p2') }));
      const filter: ScopeFilter = { ...LOCAL, projectIds: [null, 'p1'] };
      const sorted = (xs: { id: string }[]) => ids(xs).sort();
      expect(sorted(await store.lexical('auth-service-8080', filter, 10))).toEqual([
        'global',
        'p1',
      ]);
      expect(sorted(await store.dense(embedding, filter, 10))).toEqual(['global', 'p1']);
      expect(sorted(await store.list(filter))).toEqual(['global', 'p1']);
      expect(ids(await store.list({ ...LOCAL, projectIds: ['p2'] }))).toEqual(['p2']);
    });

    it('record-access-increments-only-listed', async () => {
      await store.upsert(makeMemory({ id: 'a' }));
      await store.upsert(makeMemory({ id: 'b' }));
      await store.upsert(makeMemory({ id: 'c' }));
      const at = new Date('2026-11-03T12:00:00.000Z');
      await store.recordAccess(['a', 'c', 'unknown'], at);
      for (const id of ['a', 'c']) {
        const log = (await store.get(id))?.accessLog;
        expect(log?.count).toBe(1);
        expect(log?.recent).toEqual([at.toISOString()]);
      }
      expect((await store.get('b'))?.accessLog.count).toBe(0);

      await store.recordAccess(['a'], new Date('2026-11-03T13:00:00.000Z'));
      expect((await store.get('a'))?.accessLog.count).toBe(2);
    });

    it('cold-roundtrip-preserves-embedding', async () => {
      const m = makeMemory({ id: 'c1', text: 'A long claim', embedding: vec(5, -6, 7, -8) });
      await store.coldPut(m);
      const cold = await store.coldGet('c1');
      expect(cold?.text).toBe('A long claim');
      expect(cold?.embedding).toEqual(vec(5, -6, 7, -8));
      const main = await store.get('c1');
      expect(main?.tier).toBe('cold');
      expect(main?.embedding).toBeUndefined();
      expect(main?.stub).toBe(m.stub);
      expect(await store.coldGet('missing')).toBeNull();
    });

    it('set-tier', async () => {
      const m = makeMemory({ id: 'm1', embedding: vec(1, 2, 3, 4) });
      await store.upsert(m);
      await store.setTier('m1', 'hot');
      expect(await store.get('m1')).toEqual({ ...m, tier: 'hot' });
      await expect(store.setTier('missing', 'hot')).resolves.toBeUndefined();
    });

    it('cursor-roundtrip', async () => {
      expect(await store.getCursor('import:session-1')).toBeNull();
      await store.setCursor('import:session-1', '42');
      expect(await store.getCursor('import:session-1')).toBe('42');
      await store.setCursor('import:session-1', '43');
      expect(await store.getCursor('import:session-1')).toBe('43');
      expect(await store.getCursor('import:session-2')).toBeNull();
    });

    it('forget-removes-everywhere', async () => {
      await store.upsert(makeMemory({ id: 'warm', text: 'auth-service-8080 warm' }));
      await store.coldPut(
        makeMemory({ id: 'cold', stub: 'auth-service-8080 cold', embedding: vec(1, 2, 3, 4) }),
      );
      await store.forget('warm');
      await store.forget('cold');
      expect(await store.get('warm')).toBeNull();
      expect(await store.get('cold')).toBeNull();
      expect(await store.coldGet('cold')).toBeNull();
      expect(await store.lexical('auth-service-8080', LOCAL, 10)).toEqual([]);
      expect(await store.list(LOCAL, { validOnly: false })).toEqual([]);
      await expect(store.forget('never-existed')).resolves.toBeUndefined();
    });

    it('list-valid-only-default', async () => {
      await store.upsert(
        makeMemory({ id: 'old', updatedAt: '2026-11-01T00:00:00.000Z', tier: 'hot' }),
      );
      await store.upsert(
        makeMemory({
          id: 'superseded',
          updatedAt: '2026-11-02T00:00:00.000Z',
          validTo: '2026-11-02T00:00:00.000Z',
        }),
      );
      await store.upsert(makeMemory({ id: 'new', updatedAt: '2026-11-03T00:00:00.000Z' }));
      expect(ids(await store.list(LOCAL))).toEqual(['new', 'old']);
      expect(ids(await store.list(LOCAL, { validOnly: false }))).toEqual([
        'new',
        'superseded',
        'old',
      ]);
      expect(ids(await store.list(LOCAL, { tier: 'hot' }))).toEqual(['old']);
    });

    it('list-valid-only-uses-isCurrent', async () => {
      await store.upsert(makeMemory({ id: 'future', validTo: '2999-01-01T00:00:00.000Z' }));
      await store.upsert(
        makeMemory({
          id: 'past',
          validFrom: '2000-01-01T00:00:00.000Z',
          validTo: '2000-06-01T00:00:00.000Z',
        }),
      );
      await store.upsert(
        makeMemory({ id: 'expired', expiredAt: '2026-11-01T00:00:00.000Z', endReason: 'expired' }),
      );
      expect(ids(await store.list(LOCAL)).sort()).toEqual(['future']);
      expect(ids(await store.list(LOCAL, { validOnly: false })).sort()).toEqual([
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
      await store.upsert(m);
      await store.close();
      const calls: [string, () => Promise<unknown>][] = [
        ['upsert', () => store.upsert(m)],
        ['upsertMany', () => store.upsertMany([m])],
        ['get', () => store.get('m1')],
        ['forget', () => store.forget('m1')],
        ['lexical', () => store.lexical('memory', LOCAL, 10)],
        ['dense', () => store.dense(vec(1, 2, 3, 4), LOCAL, 10)],
        ['recordAccess', () => store.recordAccess(['m1'], new Date())],
        ['list', () => store.list(LOCAL)],
        ['coldPut', () => store.coldPut(m)],
        ['coldGet', () => store.coldGet('m1')],
        ['setTier', () => store.setTier('m1', 'hot')],
        ['getCursor', () => store.getCursor('k')],
        ['setCursor', () => store.setCursor('k', 'v')],
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
}
