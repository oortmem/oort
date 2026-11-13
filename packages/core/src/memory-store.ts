import { appendAccess } from './activation.js';
import type { GuardedWriteResult, Hit, MemoryStore } from './adapters.js';
import { addressOf, canonicalMemory, nodeKey, nodeOf } from './address.js';
import {
  assertGrant,
  cursorKey,
  grantReads,
  grantWrites,
  GrantError,
  sameRecordAddress,
  type Grant,
} from './grant.js';
import { isCurrent, isZeroVector, type Memory, type Tier } from './model.js';
import {
  ABOUT_PER_ENTITY,
  aboutWeight,
  combineWeights,
  entityKeys,
  EPISODE_PER_SEED,
  EPISODE_RAW_SCAN,
  EPISODE_REACH,
  episodeSession,
  episodeWeight,
  EXPLICIT_PER_SEED,
  EXPLICIT_RAW_SCAN,
  F_MAX_DEFAULT,
  inLinkIndexes,
  NEIGHBOUR_KINDS,
  orderedPair,
  rawScanLimit,
  type AssertedBy,
  type LinkOptions,
  type LinksProbe,
  type Neighbour,
  type StoredLink,
} from './links.js';
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

/** One link or block row of the in-memory store. */
interface LinkRow {
  kind: StoredLink['kind'] | 'blocked';
  a: string;
  b: string;
  assertedBy: AssertedBy | null;
  createdAt: string;
}

/** The in-memory stores' rows, for `memoryStoreProbe`. */
const PROBES = new WeakMap<MemoryStore, LinksProbe>();

/**
 * Reads an in-memory store's link, entity and episode rows, for `linksConformance` and tests.
 * Throws for any other store.
 */
export function memoryStoreProbe(store: MemoryStore): LinksProbe {
  const p = PROBES.get(store);
  if (p === undefined) throw new TypeError('memoryStoreProbe: not an in-memory store');
  return p;
}

/**
 * An in-memory `MemoryStore`: a test double and reference implementation of
 * the contract, not a production store. Records are cloned on the way in and
 * out so callers cannot mutate stored state. It keeps links (`links: true`).
 */
export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  const d = opts.d ?? 0.5;
  const clock = opts.now ?? (() => new Date());
  const main = new Map<string, Memory>();
  const cold = new Map<string, Memory>();
  const cursors = new Map<string, string>();
  /** Link and block rows, keyed `kind/a/b`, in the order they were first written. */
  const links = new Map<string, LinkRow>();
  /** Episode positions: assigned on insert, kept by a rewrite in the same session. */
  const episodes = new Map<string, { node: string; session: string; seq: number }>();
  let closed = false;

  const rowKey = (kind: LinkRow['kind'], a: string, b: string) => `${kind}\u0000${a}\u0000${b}`;
  const nodeOfMemory = (m: Memory) => nodeKey(nodeOf(addressOf(m)));

  /** Gives `m` its episode position (CON-148): the next in its session, or its turn's. */
  function placeInEpisode(m: Memory): void {
    const session = episodeSession(m);
    if (session === undefined) {
      episodes.delete(m.id);
      return;
    }
    const node = nodeOfMemory(m);
    const was = episodes.get(m.id);
    if (was !== undefined && was.session === session && was.node === node) return;
    let seq = 0;
    let turn: number | undefined;
    for (const [id, e] of episodes) {
      if (e.node !== node || e.session !== session) continue;
      seq = Math.max(seq, e.seq);
      const other = main.get(id);
      if (m.source.turnRef !== undefined && other?.source.turnRef === m.source.turnRef) {
        turn = e.seq;
      }
    }
    episodes.set(m.id, { node, session, seq: turn ?? seq + 1 });
  }

  function forgetLinks(id: string): void {
    for (const [k, r] of links) if (r.a === id || r.b === id) links.delete(k);
    episodes.delete(id);
  }

  /**
   * The two memories `link` and `unlink` may join: both written by `grant`, distinct, in one
   * node that is not a hive. Undefined for anything else, as for a missing id.
   */
  function linkable(grant: Grant, x: string, y: string): [string, string] | undefined {
    if (x === y) return undefined;
    const a = writable(grant, x);
    const b = writable(grant, y);
    if (a === undefined || b === undefined) return undefined;
    if (addressOf(a).level === 'hive' || nodeOfMemory(a) !== nodeOfMemory(b)) return undefined;
    return orderedPair(x, y);
  }

  /** Whether an index (a shared entity, or a session) relates the two. */
  function indexRelated(x: string, y: string): boolean {
    const a = main.get(x);
    const b = main.get(y);
    if (a === undefined || b === undefined) return false;
    if (inLinkIndexes(a) && inLinkIndexes(b)) {
      const keys = new Set(entityKeys(a.entities));
      if (entityKeys(b.entities).some((k) => keys.has(k))) return true;
    }
    const ea = episodes.get(x);
    const eb = episodes.get(y);
    return ea !== undefined && eb !== undefined && ea.node === eb.node && ea.session === eb.session;
  }

  function open(): void {
    if (closed) throw new Error('memory store is closed');
  }

  /** Stores `m` (already cloned); a non-cold write drops the cold copy. A zero embedding is not kept. */
  function put(m: Memory): void {
    if (m.embedding !== undefined && isZeroVector(m.embedding)) delete m.embedding;
    main.set(m.id, m);
    placeInEpisode(m);
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

  const handle: MemoryStore = {
    spatial: true,
    links: true,

    async link(grant, x, y, linkOpts: LinkOptions) {
      open();
      assertGrant(grant);
      const pair = linkable(grant, x, y);
      if (pair === undefined) return null;
      const [a, b] = pair;
      if (
        linkOpts.assertedBy !== 'user' &&
        links.get(rowKey('blocked', a, b))?.assertedBy === 'user'
      ) {
        return {
          linked: false,
          unblocked: false,
          assertedBy: 'agent' as const,
          refused: 'asserted-by-user' as const,
        };
      }
      const unblocked = links.delete(rowKey('blocked', a, b));
      const k = rowKey('explicit', a, b);
      const was = links.get(k);
      if (was !== undefined) {
        const stronger = linkOpts.assertedBy === 'user' && was.assertedBy !== 'user';
        if (stronger) was.assertedBy = 'user';
        return { linked: stronger, unblocked, assertedBy: was.assertedBy ?? 'agent' };
      }
      const createdAt = (linkOpts.at ?? new Date()).toISOString();
      links.set(k, { kind: 'explicit', a, b, assertedBy: linkOpts.assertedBy, createdAt });
      return { linked: true, unblocked, assertedBy: linkOpts.assertedBy };
    },

    async unlink(grant, x, y, linkOpts: LinkOptions) {
      open();
      assertGrant(grant);
      const pair = linkable(grant, x, y);
      if (pair === undefined) return null;
      const [a, b] = pair;
      const held = links.get(rowKey('explicit', a, b));
      if (held?.assertedBy === 'user' && linkOpts.assertedBy !== 'user') {
        return { removed: false, blocked: false, refused: 'asserted-by-user' as const };
      }
      const removed = [
        links.delete(rowKey('explicit', a, b)),
        links.delete(rowKey('recalledWith', a, b)),
      ].some(Boolean);
      if (removed && !indexRelated(a, b))
        return { removed, blocked: links.has(rowKey('blocked', a, b)) };
      if (!links.has(rowKey('blocked', a, b))) {
        links.set(rowKey('blocked', a, b), {
          kind: 'blocked',
          a,
          b,
          assertedBy: linkOpts.assertedBy,
          createdAt: (linkOpts.at ?? new Date()).toISOString(),
        });
      }
      return { removed, blocked: true };
    },

    async linksOf(grant, id) {
      open();
      assertGrant(grant);
      if (readable(grant, id) === undefined) return null;
      const out: StoredLink[] = [];
      const blocked: string[] = [];
      let hidden = 0;
      for (const r of links.values()) {
        if (r.a !== id && r.b !== id) continue;
        const other = r.a === id ? r.b : r.a;
        const seen = readable(grant, other) !== undefined;
        if (r.kind === 'blocked') {
          if (seen) blocked.push(other);
          continue;
        }
        if (!seen) {
          hidden++;
          continue;
        }
        out.push({
          kind: r.kind,
          id: other,
          direction: r.kind === 'distilledFrom' ? (r.a === id ? 'out' : 'in') : 'both',
          ...(r.kind === 'explicit' && { assertedBy: r.assertedBy ?? 'agent' }),
          createdAt: r.createdAt,
        });
      }
      return { links: out, blocked, hidden };
    },

    /** The reference for `neighbours`: the same bounds and order as a store with real indexes. */
    async neighbours(grant, seedIds, o) {
      open();
      assertGrant(grant);
      const fMax = o.fMax ?? F_MAX_DEFAULT;
      const now = o.clock ?? (() => performance.now());
      const start = now();
      const budget = o.budgetMs ?? 0;
      const late = () => budget > 0 && now() - start >= budget;
      const f = hasSpatialFilter(o.spatial) ? o.spatial : undefined;
      // Insertion order stands in for the row id: a later memory is newer.
      const order = new Map([...main.keys()].map((id, i) => [id, i]));
      const newestFirst = (x: Memory, y: Memory) => order.get(y.id)! - order.get(x.id)!;
      const seeds = [...new Set(seedIds)]
        .map((id) => readable(grant, id))
        .filter((m): m is Memory => m !== undefined && addressOf(m).level !== 'hive');
      /** What a link may bring in from `seed`: readable, in its node, in place, not blocked. */
      const admits = (seed: Memory, m: Memory): boolean => {
        if (m.id === seed.id || !grantReads(grant, m)) return false;
        if (addressOf(m).level === 'hive' || nodeOfMemory(m) !== nodeOfMemory(seed)) return false;
        if (o.currentOnly === true && (m.expiredAt !== null || m.supersededBy !== null))
          return false;
        if (f !== undefined && !matchesSpatial(m, f)) return false;
        return !links.has(rowKey('blocked', ...orderedPair(seed.id, m.id)));
      };
      const out: Neighbour[] = [];
      let skipped = false;
      let budgetPassed = false;
      gather: for (const kind of NEIGHBOUR_KINDS) {
        if (!o.kinds.includes(kind)) continue;
        if (late()) {
          skipped = true;
          break;
        }
        for (const seed of seeds) {
          if (kind === 'explicit') {
            // Links asserted by `user` and by `agent` are read and bounded apart, a person's
            // first: however many links an agent writes on a memory, a person's are still read.
            for (const by of o.explicitBy === 'user'
              ? (['user'] as const)
              : (['user', 'agent'] as const)) {
              const mine = [...links.values()].filter(
                (r) =>
                  r.kind === 'explicit' &&
                  (r.a === seed.id || r.b === seed.id) &&
                  (r.assertedBy ?? 'agent') === by,
              );
              // The work bound, whoever asks: more links than it are skipped, never cut short.
              if (mine.length > EXPLICIT_RAW_SCAN) {
                skipped = true;
                continue;
              }
              const ends: Memory[] = [];
              for (const r of mine) {
                const other = main.get(r.a === seed.id ? r.b : r.a);
                if (other !== undefined && admits(seed, other)) ends.push(other);
              }
              for (const m of ends.sort(newestFirst).slice(0, EXPLICIT_PER_SEED)) {
                out.push({ id: m.id, kind, from: seed.id, weight: 1, assertedBy: by });
              }
            }
          } else if (kind === 'episode') {
            const at = episodes.get(seed.id);
            if (at === undefined) continue;
            const near: { m: Memory; delta: number }[] = [];
            let raw = 0;
            for (const [id, e] of episodes) {
              if (e.node !== at.node || e.session !== at.session) continue;
              const delta = e.seq - at.seq;
              if (Math.abs(delta) > EPISODE_REACH || id === seed.id) continue;
              raw++;
              const m = main.get(id);
              if (m === undefined || !admits(seed, m)) continue;
              near.push({ m, delta });
            }
            if (raw > EPISODE_RAW_SCAN) {
              skipped = true;
              continue;
            }
            near.sort((x, y) => Math.abs(x.delta) - Math.abs(y.delta) || newestFirst(x.m, y.m));
            for (const { m, delta } of near.slice(0, EPISODE_PER_SEED)) {
              out.push({ id: m.id, kind, from: seed.id, weight: episodeWeight(delta) });
            }
          } else {
            if (!inLinkIndexes(seed)) continue;
            const node = nodeOfMemory(seed);
            const weights = new Map<string, number[]>();
            for (const key of entityKeys(seed.entities)) {
              if (late()) {
                skipped = true;
                budgetPassed = true;
                break;
              }
              const all = [...main.values()].filter(
                (m) =>
                  inLinkIndexes(m) &&
                  nodeOfMemory(m) === node &&
                  entityKeys(m.entities).includes(key),
              );
              // The work bound, whoever asks: a larger entity is skipped, never cut short.
              if (all.length > rawScanLimit(fMax)) {
                skipped = true;
                continue;
              }
              // Of those, only what the grant reads counts: a row outside the grant changes
              // neither the fan nor which neighbours are kept.
              const rows = all
                .filter((m) => grantReads(grant, m))
                .sort(newestFirst)
                .slice(0, fMax);
              const w = aboutWeight(rows.length, fMax);
              if (w <= 0) continue;
              for (const m of rows.filter((x) => admits(seed, x)).slice(0, ABOUT_PER_ENTITY)) {
                weights.set(m.id, [...(weights.get(m.id) ?? []), w]);
              }
            }
            for (const [id, ws] of weights) {
              out.push({ id, kind, from: seed.id, weight: combineWeights(ws) });
            }
            // What the reads before the budget passed found is kept.
            if (budgetPassed) break gather;
          }
        }
      }
      return { neighbours: out, ...(skipped && { skipped: true as const }) };
    },

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

    /** The memories are checked before any is written; the links follow in the same turn. */
    async upsertManyLinked(grant, ms, pairs, linkOpts) {
      await handle.upsertMany(grant, ms);
      let linked = 0;
      for (const [x, y] of pairs) {
        if ((await handle.link!(grant, x, y, linkOpts))?.linked === true) linked++;
      }
      return { linked };
    },

    /** Atomic trivially: checks and clones every applying record before writing any. */
    async upsertManyIfUnchanged(grant, writes) {
      open();
      assertGrant(grant);
      const skipped: string[] = [];
      const checked: Memory[] = [];
      for (const { next, was } of writes) {
        const live = main.get(was.id);
        // Out of the grant reads as missing: skipped, never a GrantError.
        if (
          live === undefined ||
          !grantWrites(grant, live) ||
          next.id !== was.id ||
          !unchanged(live, was)
        ) {
          skipped.push(was.id);
          continue;
        }
        checked.push(checkWrite(grant, structuredClone(next), live));
      }
      for (const c of checked) put(c);
      return { skipped };
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
      forgetLinks(id);
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
      // A zero query has no direction: it matches nothing (CON-141).
      return isZeroVector(v) ? [] : rank(scored, k);
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
  PROBES.set(handle, {
    async entities() {
      return [...main.values()]
        .filter(inLinkIndexes)
        .flatMap((m) => entityKeys(m.entities).map((entity) => ({ id: m.id, entity })));
    },
    async links() {
      return [...links.values()].map((r) => ({
        kind: r.kind,
        a: r.a,
        b: r.b,
        assertedBy: r.assertedBy,
      }));
    },
    async episodes() {
      return [...episodes].map(([id, e]) => ({ id, session: e.session, seq: e.seq }));
    },
    async orphans() {
      return [...links.values()].filter((r) => !main.has(r.a) || !main.has(r.b)).length;
    },
  });
  return handle;
}
