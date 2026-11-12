import { appendAccess } from './activation.js';
import type { GuardedWriteResult, Hit, MemoryStore } from './adapters.js';
import { canonicalMemory } from './address.js';
import {
  assertGrant,
  cursorKey,
  grantReads,
  grantWrites,
  GrantError,
  sameRecordAddress,
  type Grant,
} from './grant.js';
import { isCurrent, type Memory, type Tier } from './model.js';
import { checkPlace, hasSpatialFilter, matchesSpatial, type SpatialFilter } from './place.js';
import { tokenizeLexical as tokens } from './tokenize.js';

export interface MemoryStoreOptions {
  /**
   * ACT-R decay used when folding access logs in `recordAccess`. The store
   * needs it because `appendAccess` compacts old accesses into a sum that is
   * only valid for one `d`; pass the same `d` the engine's activation uses.
   */
  d?: number;
  /** Clock for `list`'s validity filter; defaults to `new Date()`. */
  now?: () => Date;
}

function cosine(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Best score first; ties go to the newer `updatedAt`, then to the smaller id. */
function rank(scored: { m: Memory; score: number }[], k: number): Hit[] {
  return scored
    .sort(
      (x, y) =>
        y.score - x.score ||
        Date.parse(y.m.updatedAt) - Date.parse(x.m.updatedAt) ||
        (x.m.id < y.m.id ? -1 : x.m.id > y.m.id ? 1 : 0),
    )
    .slice(0, Math.max(k, 0))
    .map(({ m, score }) => ({ id: m.id, score, tier: m.tier }));
}

/**
 * An in-memory `MemoryStore`: a test double and reference implementation of
 * the contract, not a production store. Records are cloned on the way in and
 * out so callers cannot mutate stored state.
 */
export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  const d = opts.d ?? 0.5;
  const clock = opts.now ?? (() => new Date());
  const main = new Map<string, Memory>();
  const cold = new Map<string, Memory>();
  const cursors = new Map<string, string>();
  let closed = false;

  function open(): void {
    if (closed) throw new Error('memory store is closed');
  }

  /** Stores `m` (already cloned); a non-cold write drops the cold copy. */
  function put(m: Memory): void {
    main.set(m.id, m);
    if (m.tier !== 'cold') cold.delete(m.id);
  }

  /** What `grant` reads, and with a spatial filter only what passes it (CON-84). */
  function scoped(grant: Grant, spatial?: SpatialFilter): Memory[] {
    const f = hasSpatialFilter(spatial) ? spatial : undefined;
    return [...main.values()].filter(
      (m) => grantReads(grant, m) && (f === undefined || matchesSpatial(m, f)),
    );
  }

  /** The live record if `grant` may read it; `undefined` for unknown and out-of-grant alike. */
  function readable(grant: Grant, id: string): Memory | undefined {
    const m = main.get(id);
    return m !== undefined && grantReads(grant, m) ? m : undefined;
  }

  /** The live record if `grant` may change it. */
  function writable(grant: Grant, id: string): Memory | undefined {
    const m = main.get(id);
    return m !== undefined && grantWrites(grant, m) ? m : undefined;
  }

  /**
   * Every check `upsert` makes, before anything is written: a legal address
   * that matches the scope (`RangeError` otherwise), inside `grant.write`,
   * and the same address, author and scope as any record already under the id.
   * Returns the record as stored.
   */
  function checkWrite(grant: Grant, m: Memory, existing: Memory | undefined): Memory {
    const c = canonicalMemory(m);
    if (c.place !== undefined) c.place = checkPlace(c.place);
    else delete c.place;
    if (!grantWrites(grant, c)) throw new GrantError();
    if (existing !== undefined && !sameRecordAddress(existing, c)) throw new GrantError();
    return c;
  }

  /** True while the live record still matches the snapshot a guarded write was computed from. */
  function unchanged(live: Memory | undefined, snap: Pick<Memory, 'updatedAt' | 'tier'>) {
    return live !== undefined && live.updatedAt === snap.updatedAt && live.tier === snap.tier;
  }

  /** The last entry per id, in first-seen order. */
  function lastPerId(ms: Memory[]): Memory[] {
    return [...new Map(ms.map((m) => [m.id, m])).values()];
  }

  /** Atomic trivially: validates and clones every snapshot before writing any. */
  async function coldPutMany(grant: Grant, snapshots: Memory[]): Promise<GuardedWriteResult> {
    open();
    assertGrant(grant);
    const dims = new Set(
      snapshots.flatMap((m) => (m.embedding === undefined ? [] : [m.embedding.length])),
    );
    if (dims.size > 1) throw new RangeError('coldPutMany: embeddings differ in dimension');
    const skipped: string[] = [];
    for (const snap of lastPerId(snapshots).map((x) => structuredClone(x))) {
      const live = writable(grant, snap.id);
      if (snap.tier === 'cold' || live === undefined || !unchanged(live, snap)) {
        skipped.push(snap.id);
        continue;
      }
      cold.set(snap.id, snap);
      delete live.embedding;
      live.tier = 'cold';
    }
    return { skipped };
  }

  async function expireMany(
    grant: Grant,
    snapshots: Memory[],
    at: Date,
  ): Promise<GuardedWriteResult> {
    open();
    assertGrant(grant);
    const iso = at.toISOString();
    const skipped: string[] = [];
    for (const snap of lastPerId(snapshots)) {
      const live = writable(grant, snap.id);
      if (live === undefined || !unchanged(live, snap) || live.expiredAt !== null) {
        skipped.push(snap.id);
        continue;
      }
      live.expiredAt = iso;
      live.endReason ??= 'expired';
    }
    return { skipped };
  }

  return {
    spatial: true,

    async upsert(grant, m) {
      open();
      assertGrant(grant);
      const c = structuredClone(m);
      put(checkWrite(grant, c, main.get(c.id)));
    },

    /** Atomic trivially: checks and clones every record before writing any. */
    async upsertMany(grant, ms) {
      open();
      assertGrant(grant);
      const cs = ms.map((x) => structuredClone(x));
      // Later entries may move an id the batch itself created: check against
      // the batch's own earlier entries as well as the store.
      const batch = new Map<string, Memory>();
      const checked: Memory[] = [];
      for (const c of cs) {
        const ok = checkWrite(grant, c, batch.get(c.id) ?? main.get(c.id));
        batch.set(c.id, ok);
        checked.push(ok);
      }
      for (const c of checked) put(c);
    },

    async get(grant, id) {
      open();
      assertGrant(grant);
      const m = readable(grant, id);
      return m === undefined ? null : structuredClone(m);
    },

    async forget(grant, id) {
      open();
      assertGrant(grant);
      if (writable(grant, id) === undefined) return;
      main.delete(id);
      cold.delete(id);
    },

    /**
     * Not BM25: scores by how many distinct query tokens appear (exact token
     * match) in text + stub + entities, or in stub + entities only for cold
     * memories, mirroring a store that keeps only those indexed when cold.
     */
    async lexical(grant, q, k, searchOpts) {
      open();
      assertGrant(grant);
      const query = new Set(tokens(q));
      if (query.size === 0) return [];
      const scored: { m: Memory; score: number }[] = [];
      for (const m of scoped(grant, searchOpts?.spatial)) {
        const fields =
          m.tier === 'cold' ? [m.stub, ...m.entities] : [m.text, m.stub, ...m.entities];
        const doc = new Set(tokens(fields.join(' ')));
        let score = 0;
        for (const t of query) if (doc.has(t)) score++;
        if (score > 0) scored.push({ m, score });
      }
      return rank(scored, k);
    },

    async dense(grant, v, k, searchOpts) {
      open();
      assertGrant(grant);
      const scored: { m: Memory; score: number }[] = [];
      for (const m of scoped(grant, searchOpts?.spatial)) {
        if (m.tier === 'cold' || m.embedding === undefined) continue;
        if (m.embedding.length !== v.length) {
          throw new RangeError(
            `dense: query vector has ${v.length} dimensions, store embeddings have ${m.embedding.length} (memory ${m.id})`,
          );
        }
        scored.push({ m, score: cosine(v, m.embedding) });
      }
      return rank(scored, k);
    },

    async recordAccess(grant, ids, at) {
      open();
      assertGrant(grant);
      for (const id of ids) {
        const m = readable(grant, id);
        if (m !== undefined) m.accessLog = appendAccess(m.accessLog, at, { d });
      }
    },

    async list(grant, listOpts = {}) {
      open();
      assertGrant(grant);
      const validOnly = listOpts.validOnly ?? true;
      const now = clock();
      return scoped(grant)
        .filter((m) => !validOnly || isCurrent(m, now))
        .filter((m) => listOpts.tier === undefined || m.tier === listOpts.tier)
        .filter((m) => listOpts.pinned !== true || m.pinned)
        .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
        .map((m) => {
          if (listOpts.embeddings !== false) return structuredClone(m);
          const { embedding: _e, ...rest } = m;
          return structuredClone(rest);
        });
    },

    expireMany,

    coldPut: (grant, m) => coldPutMany(grant, [m]),

    coldPutMany,

    async coldGet(grant, id) {
      open();
      assertGrant(grant);
      if (readable(grant, id) === undefined) return null;
      const m = cold.get(id);
      return m === undefined || !grantReads(grant, m) ? null : structuredClone(m);
    },

    async setTier(
      grant: Grant,
      id: string,
      tier: Tier,
      snapshot?: Pick<Memory, 'updatedAt' | 'tier'>,
    ) {
      open();
      assertGrant(grant);
      const m = writable(grant, id);
      if (m === undefined || (snapshot !== undefined && !unchanged(m, snapshot))) return false;
      m.tier = tier;
      return true;
    },

    async getCursor(grant, key) {
      open();
      assertGrant(grant);
      return cursors.get(cursorKey(grant, key)) ?? null;
    },

    async setCursor(grant, key, value) {
      open();
      assertGrant(grant);
      cursors.set(cursorKey(grant, key), value);
    },

    async close() {
      closed = true;
    },
  };
}
