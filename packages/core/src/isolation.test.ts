import { describe, expect, it } from 'vitest';
import type { MemoryStore } from './adapters.js';
import { Grant, localGrant } from './grant.js';
import { isolationViolations, nonInterference, soleGrantFor } from './isolation.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';

/**
 * A correct store with one leak added: `break(inner, seen)` returns the
 * overrides, where `seen` holds every record ever written (what a buggy
 * store would reach without checking the grant).
 */
function broken(
  leak: (inner: MemoryStore, seen: Map<string, Memory>) => Partial<MemoryStore>,
): () => Promise<MemoryStore> {
  return async () => {
    const inner = createMemoryStore();
    const seen = new Map<string, Memory>();
    const base: MemoryStore = {
      ...inner,
      async upsert(g, m) {
        await inner.upsert(g, m);
        seen.set(m.id, m);
      },
      async upsertMany(g, ms) {
        await inner.upsertMany(g, ms);
        for (const m of ms) seen.set(m.id, m);
      },
    };
    return { ...base, ...leak(inner, seen) };
  };
}

describe('isolation suite catches broken stores (mutation check)', () => {
  it('isolation.catches-unscoped-get', async () => {
    const make = broken((inner, seen) => ({
      async get(_g, id) {
        const m = seen.get(id);
        return m === undefined ? null : inner.get(soleGrantFor(m), id);
      },
    }));
    expect((await isolationViolations(make)).some((v) => v.includes('get returned it'))).toBe(true);
  });

  it('isolation.catches-post-filtering-left-to-the-caller', async () => {
    // Lexical search over every record, as if the caller were meant to filter.
    const make = broken((_inner, seen) => ({
      async lexical(_g, q, k) {
        const words = q.toLowerCase().split(/\s+/);
        return [...seen.values()]
          .filter((m) => words.some((w) => m.text.toLowerCase().includes(w)))
          .slice(0, k)
          .map((m) => ({ id: m.id, score: 1, tier: m.tier }));
      },
    }));
    expect((await isolationViolations(make)).some((v) => v.includes('lexical returned it'))).toBe(
      true,
    );
  });

  it('isolation.catches-unscoped-mutation', async () => {
    // setTier applied through the record's own grant, whoever asked.
    const make = broken((inner, seen) => ({
      async setTier(_g, id, tier, snap) {
        const m = seen.get(id);
        return m === undefined ? false : inner.setTier(soleGrantFor(m), id, tier, snap);
      },
    }));
    const v = await isolationViolations(make);
    expect(v.some((x) => x.includes('setTier reported a write'))).toBe(true);
    expect(v.some((x) => x.includes('changed through a grant'))).toBe(true);
  });

  it('isolation.catches-shared-cursor-namespace', async () => {
    const shared = new Map<string, string>();
    const make = broken(() => ({
      async getCursor(_g, key) {
        return shared.get(key) ?? null;
      },
      async setCursor(_g, key, value) {
        shared.set(key, value);
      },
    }));
    shared.clear();
    expect((await isolationViolations(make)).some((v) => v.startsWith('cursor:'))).toBe(true);
  });

  it('isolation.non-interference-catches-a-cross-tenant-write', async () => {
    // recordAccess through the record's own grant: B's access lands on A's memories.
    const make = broken((inner, seen) => ({
      async recordAccess(_g, ids, at) {
        for (const id of ids) {
          const m = seen.get(id);
          if (m !== undefined) await inner.recordAccess(soleGrantFor(m), [id], at);
        }
      },
    }));
    let caught: string | null = null;
    for (let seed = 1; seed <= 30 && caught === null; seed++) {
      caught = await nonInterference(make, seed, 80);
    }
    expect(caught).toMatch(/^seed \d+: A's step \d+ differs/);
  });

  it('isolation.correct-store-passes', async () => {
    expect(await isolationViolations(async () => createMemoryStore())).toEqual([]);
    expect(await nonInterference(async () => createMemoryStore(), 7, 80)).toBeNull();
  });
});

describe('grants', () => {
  const p = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };

  it('grant.is-frozen-and-nominal', () => {
    const g = localGrant({ ...p, projectIds: ['pa'] });
    expect(Grant.is(g)).toBe(true);
    expect(Grant.is({ ...g })).toBe(false);
    expect(
      Object.isFrozen(g) && Object.isFrozen(g.read) && Object.isFrozen(g.read.projectIds),
    ).toBe(true);
    expect(() => (g.read.projectIds as (string | null)[]).push(null)).toThrow(TypeError);
  });

  it('grant.read-and-write-share-a-principal', () => {
    expect(() =>
      localGrant(
        { ...p, projectIds: ['pa'] },
        { write: { ...p, agentId: 'x', projectIds: ['pa'] } },
      ),
    ).toThrow(RangeError);
  });

  it('grant.fuzzes-scope-edge-cases', () => {
    for (const bad of ['', ' '.slice(1)]) {
      expect(() => localGrant({ ...p, orgId: bad, projectIds: [] })).toThrow(RangeError);
      expect(() => localGrant({ ...p, projectIds: [bad] })).toThrow(RangeError);
    }
    for (const bad of [undefined, 42, {}] as unknown[]) {
      expect(() => localGrant({ ...p, projectIds: [bad as string] })).toThrow(RangeError);
      expect(() => localGrant({ ...p, customerId: bad as string, projectIds: [] })).toThrow(
        RangeError,
      );
    }
    expect(() => localGrant({ ...p, projectIds: 'all' as unknown as string[] })).toThrow(TypeError);
  });

  it('grant.cursor-keys-cannot-forge-a-namespace', async () => {
    const s = createMemoryStore();
    const g = localGrant({ ...p, projectIds: [null] });
    await expect(s.setCursor(g, '\u001f["x","y","z"]\u001fk', 'v')).rejects.toThrow(RangeError);
  });
});
