import { appendAccess } from './activation.js';
import { scopeMatches, type Hit, type MemoryStore, type ScopeFilter } from './adapters.js';
import { isCurrent, type Memory, type Tier } from './model.js';
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

  function scoped(scope: ScopeFilter): Memory[] {
    return [...main.values()].filter((m) => scopeMatches(m.scope, scope));
  }

  /** Atomic trivially: validates and clones every record before writing any. */
  async function coldPutMany(ms: Memory[]): Promise<void> {
    open();
    const dims = new Set(
      ms.flatMap((m) => (m.embedding === undefined ? [] : [m.embedding.length])),
    );
    if (dims.size > 1) throw new RangeError('coldPutMany: embeddings differ in dimension');
    for (const m of ms.map((x) => structuredClone(x))) {
      cold.set(m.id, m);
      const { embedding: _dropped, ...rest } = structuredClone(m);
      main.set(m.id, { ...rest, tier: 'cold' });
    }
  }

  return {
    async upsert(m) {
      open();
      put(structuredClone(m));
    },

    /** Atomic trivially: clones every record before writing any. */
    async upsertMany(ms) {
      open();
      for (const m of ms.map((x) => structuredClone(x))) put(m);
    },

    async get(id) {
      open();
      const m = main.get(id);
      return m === undefined ? null : structuredClone(m);
    },

    async forget(id) {
      open();
      main.delete(id);
      cold.delete(id);
    },

    /**
     * Not BM25: scores by how many distinct query tokens appear (exact token
     * match) in text + stub + entities, or in stub + entities only for cold
     * memories, mirroring a store that keeps only those indexed when cold.
     */
    async lexical(q, scope, k) {
      open();
      const query = new Set(tokens(q));
      if (query.size === 0) return [];
      const scored: { m: Memory; score: number }[] = [];
      for (const m of scoped(scope)) {
        const fields =
          m.tier === 'cold' ? [m.stub, ...m.entities] : [m.text, m.stub, ...m.entities];
        const doc = new Set(tokens(fields.join(' ')));
        let score = 0;
        for (const t of query) if (doc.has(t)) score++;
        if (score > 0) scored.push({ m, score });
      }
      return rank(scored, k);
    },

    async dense(v, scope, k) {
      open();
      const scored: { m: Memory; score: number }[] = [];
      for (const m of scoped(scope)) {
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

    async recordAccess(ids, at) {
      open();
      for (const id of ids) {
        const m = main.get(id);
        if (m !== undefined) m.accessLog = appendAccess(m.accessLog, at, { d });
      }
    },

    async list(scope, listOpts = {}) {
      open();
      const validOnly = listOpts.validOnly ?? true;
      const now = clock();
      return scoped(scope)
        .filter((m) => !validOnly || isCurrent(m, now))
        .filter((m) => listOpts.tier === undefined || m.tier === listOpts.tier)
        .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
        .map((m) => structuredClone(m));
    },

    coldPut: (m) => coldPutMany([m]),

    coldPutMany,

    async coldGet(id) {
      open();
      const m = cold.get(id);
      return m === undefined ? null : structuredClone(m);
    },

    async setTier(id: string, tier: Tier) {
      open();
      const m = main.get(id);
      if (m !== undefined) m.tier = tier;
    },

    async getCursor(key) {
      open();
      return cursors.get(key) ?? null;
    },

    async setCursor(key, value) {
      open();
      cursors.set(key, value);
    },

    async close() {
      closed = true;
    },
  };
}
