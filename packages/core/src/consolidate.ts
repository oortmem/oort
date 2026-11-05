import { activation, tierFor } from './activation.js';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { addressOf, nodeKey } from './address.js';
import { assertGrant, localGrant, narrowGrant, readableNodes, type Grant } from './grant.js';
import { isCurrent, type Memory, type Tier } from './model.js';

export interface ConsolidateResult {
  /** Ids whose tier moved up (warm to hot). */
  promoted: string[];
  /** Ids whose tier moved down (hot to warm, to cold), including superseded/expired ones sent straight to cold. */
  demoted: string[];
  /** Ids written to cold storage (embedding dropped from the main record). */
  evicted: string[];
  /** Ids newly marked expired because `validTo` has passed. */
  expired: string[];
  /**
   * Writes not made because the record changed after consolidation read it
   * (a concurrent supersede, forget, recall or consolidation got there first).
   * The record is left as the other writer made it; the next run reconsiders it.
   */
  skipped: number;
  /**
   * False when `shouldStop` cut the run short. Every write made so far stands (each is atomic and
   * guarded), and a later run picks up the rest: consolidation recomputes everything from the
   * store, so nothing is lost by stopping between two writes.
   */
  complete: boolean;
}

export interface ConsolidateDeps {
  store: MemoryStore;
  config: ResolvedConfig;
  now?: Date;
  /**
   * Checked before each store call that lists or writes: once it returns true, consolidation
   * starts nothing new and resolves with `complete: false`. A time budget (the hook drain's).
   */
  shouldStop?: () => boolean;
  /** Evictions per `coldPutMany` call (default `COLD_EVICT_BATCH`); smaller holds the write lock for less. */
  evictBatch?: number;
}

/** Evictions per `coldPutMany` call: one store transaction and one directory sync each. */
export const COLD_EVICT_BATCH = 500;

const RANK: Record<Tier, number> = { cold: 0, warm: 1, hot: 2 };

const LISTING = { validOnly: false, embeddings: false } as const;

/**
 * Background consolidation. In order:
 * 1. Expire: memories with `validTo <= now` and no `expiredAt` get
 *    `expiredAt = now`, `endReason = endReason ?? "expired"` (`expireMany`).
 * 2. Rank current memories by ACT-R activation (ties: newer `updatedAt`
 *    first) and assign tiers via `tierFor`; changes are `setTier`d and new
 *    cold memories are collected and `coldPutMany`'d in batches of `COLD_EVICT_BATCH`
 *    (each read whole first, since the listing leaves embeddings out).
 * 3. Non-current memories (superseded, expired, corrected) go straight to cold
 *    (evicted ahead of the stale current ones).
 *
 * Every write is targeted (expiry writes only the expiry fields, a tier change
 * only the tier, an eviction only the tier and the cold copy) and guarded by
 * the snapshot it was computed from: a record that changed after `list()`
 * (for example superseded by a drain running meanwhile) is skipped, never
 * overwritten, and counted in `skipped`.
 *
 * Rules: pinned memories are never cold-put; a pinned non-current memory is
 * left in its current tier (hot or warm); consolidate never promotes cold to warm/hot, since
 * hydration is recall's job.
 * Idempotent for a fixed `now`.
 *
 * Each node the scope's grant covers (the person's Planet, this agent's Star)
 * is consolidated on its own, so the Planet's tiers do not depend on which of
 * the person's agents ran consolidation. Inside a node each project, and the
 * global memories (no project), is ranked on its own (`hotTopN` per project),
 * so a global memory's tier does not depend on which project ran it (CON-48).
 */
export async function consolidate(
  scope: ScopeFilter,
  deps: ConsolidateDeps,
): Promise<ConsolidateResult> {
  return consolidateGrant(localGrant(scope), deps);
}

/**
 * `consolidate` over every node `grant` both reads and writes: a Star agent's grant reads the
 * Planet but does not write it, so the Planet is left alone. With `principalGrant` it covers every
 * project of the person, which is what the hook drain runs.
 */
export async function consolidateGrant(
  grant: Grant,
  deps: ConsolidateDeps,
): Promise<ConsolidateResult> {
  assertGrant(grant);
  const { store, config } = deps;
  const now = deps.now ?? new Date();
  const run: Run = {
    store,
    config,
    now,
    stop: deps.shouldStop ?? (() => false),
    evictBatch: Math.max(1, deps.evictBatch ?? COLD_EVICT_BATCH),
  };
  const result: ConsolidateResult = {
    promoted: [],
    demoted: [],
    evicted: [],
    expired: [],
    skipped: 0,
    complete: true,
  };
  const writable = new Set(grant.writeNodes.map((p) => nodeKey(p.node)));
  for (const node of readableNodes(grant).filter((n) => writable.has(nodeKey(n)))) {
    if (!(await consolidateNode(run, narrowGrant(grant, [node]), result))) {
      result.complete = false;
      break;
    }
  }
  return result;
}

interface Run {
  store: MemoryStore;
  config: ResolvedConfig;
  now: Date;
  stop: () => boolean;
  evictBatch: number;
}

/** A memory's project inside its node (`null`: global). */
const projectOf = (m: Memory): string | null => addressOf(m).projectId ?? null;

/** One node; false when `run.stop` cut it short. */
async function consolidateNode(
  run: Run,
  grant: Grant,
  result: ConsolidateResult,
): Promise<boolean> {
  const { store, config, now } = run;
  if (run.stop()) return false;
  // One listing serves every step (a second one only after expiry changed records). Embeddings are
  // read only for the memories evicted (a fraction of the cost of listing them all).
  let all = await store.list(grant, LISTING);

  // 1. Expire.
  const due = all.filter(
    (m) => m.validTo !== null && m.expiredAt === null && Date.parse(m.validTo) <= now.getTime(),
  );
  if (due.length > 0) {
    if (run.stop()) return false;
    const skipped = new Set((await store.expireMany(grant, due, now)).skipped);
    for (const m of due) if (!skipped.has(m.id)) result.expired.push(m.id);
    result.skipped += skipped.size;
    if (run.stop()) return false;
    all = await store.list(grant, LISTING);
  }

  // 2. Rank and assign current memories, each project (and global) on its own.
  const current = all.filter((m) => isCurrent(m, now));
  const currentIds = new Set(current.map((m) => m.id));
  const byProject = new Map<string | null, Memory[]>();
  for (const m of current) {
    const key = projectOf(m);
    const list = byProject.get(key);
    if (list === undefined) byProject.set(key, [m]);
    else list.push(m);
  }
  // 3 first. Non-current memories (superseded, expired) go straight to cold, unless pinned or
  // already cold; they lead the evictions, so a run cut short has moved them first.
  const evictions: Memory[] = all.filter(
    (m) => !currentIds.has(m.id) && !m.pinned && m.tier !== 'cold',
  );
  for (const members of byProject.values()) {
    const scored = members.map((m) => ({
      m,
      a: activation(m.accessLog, m.salience, now, config.activation),
    }));
    scored.sort(
      (x, y) =>
        y.a - x.a || (x.m.updatedAt < y.m.updatedAt ? 1 : x.m.updatedAt > y.m.updatedAt ? -1 : 0),
    );
    for (const [rank, { m, a }] of scored.entries()) {
      const target = tierFor(a, rank, m.pinned, config.activation);
      if (target === m.tier) continue;
      if (m.tier === 'cold') continue; // never promote out of cold here
      if (target === 'cold') {
        evictions.push(m);
        continue;
      }
      if (run.stop()) return false;
      if (await store.setTier(grant, m.id, target, m)) {
        (RANK[target] > RANK[m.tier] ? result.promoted : result.demoted).push(m.id);
      } else {
        result.skipped++;
      }
    }
  }

  return evictAll(run, grant, evictions, result);
}

async function evictAll(
  run: Run,
  grant: Grant,
  evictions: Memory[],
  result: ConsolidateResult,
): Promise<boolean> {
  const { store } = run;
  for (let i = 0; i < evictions.length; i += run.evictBatch) {
    if (run.stop()) return false;
    // The cold copy keeps the embedding the listing left out: read each record whole, and drop
    // any that changed since it was chosen. The store's guard checks the rest at commit.
    const batch: Memory[] = [];
    for (const chosen of evictions.slice(i, i + run.evictBatch)) {
      const whole = await store.get(grant, chosen.id);
      if (whole !== null && whole.updatedAt === chosen.updatedAt && whole.tier === chosen.tier) {
        batch.push(whole);
      } else {
        result.skipped++;
      }
    }
    if (batch.length === 0) continue;
    const skipped = new Set((await store.coldPutMany(grant, batch)).skipped);
    for (const m of batch) {
      if (skipped.has(m.id)) continue;
      result.demoted.push(m.id);
      result.evicted.push(m.id);
    }
    result.skipped += skipped.size;
  }
  return true;
}
