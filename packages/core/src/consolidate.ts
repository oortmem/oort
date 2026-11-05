import { activation, tierFor } from './activation.js';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { localGrant, narrowGrant, readableNodes, type Grant } from './grant.js';
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
}

/** Evictions per `coldPutMany` call: one store transaction and one directory sync each. */
export const COLD_EVICT_BATCH = 500;

const RANK: Record<Tier, number> = { cold: 0, warm: 1, hot: 2 };

/**
 * Background consolidation. In order:
 * 1. Expire: memories with `validTo <= now` and no `expiredAt` get
 *    `expiredAt = now`, `endReason = endReason ?? "expired"` (`expireMany`).
 * 2. Rank current memories by ACT-R activation (ties: newer `updatedAt`
 *    first) and assign tiers via `tierFor`; changes are `setTier`d and new
 *    cold memories are collected and `coldPutMany`'d in batches of `COLD_EVICT_BATCH`.
 * 3. Non-current memories (superseded, expired, corrected) go straight to cold.
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
 * the person's agents ran consolidation.
 */
export async function consolidate(
  scope: ScopeFilter,
  deps: { store: MemoryStore; config: ResolvedConfig; now?: Date },
): Promise<ConsolidateResult> {
  const { store, config } = deps;
  const full = localGrant(scope);
  const now = deps.now ?? new Date();
  const result: ConsolidateResult = {
    promoted: [],
    demoted: [],
    evicted: [],
    expired: [],
    skipped: 0,
  };
  for (const node of readableNodes(full)) {
    await consolidateNode(store, narrowGrant(full, [node]), config, now, result);
  }
  return result;
}

async function consolidateNode(
  store: MemoryStore,
  grant: Grant,
  config: ResolvedConfig,
  now: Date,
  result: ConsolidateResult,
): Promise<void> {
  // 1. Expire.
  const due = (await store.list(grant, { validOnly: false })).filter(
    (m) => m.validTo !== null && m.expiredAt === null && Date.parse(m.validTo) <= now.getTime(),
  );
  if (due.length > 0) {
    const skipped = new Set((await store.expireMany(grant, due, now)).skipped);
    for (const m of due) if (!skipped.has(m.id)) result.expired.push(m.id);
    result.skipped += skipped.size;
  }

  // 2. Rank and assign current memories.
  const current = (await store.list(grant, { validOnly: true })).filter((m) => isCurrent(m, now));
  const scored = current.map((m) => ({
    m,
    a: activation(m.accessLog, m.salience, now, config.activation),
  }));
  scored.sort(
    (x, y) =>
      y.a - x.a || (x.m.updatedAt < y.m.updatedAt ? 1 : x.m.updatedAt > y.m.updatedAt ? -1 : 0),
  );
  const currentIds = new Set(current.map((m) => m.id));
  const evictions: Memory[] = [];

  for (const [rank, { m, a }] of scored.entries()) {
    const target = tierFor(a, rank, m.pinned, config.activation);
    if (target === m.tier) continue;
    if (m.tier === 'cold') continue; // never promote out of cold here
    if (target === 'cold') {
      evictions.push(m);
    } else if (await store.setTier(grant, m.id, target, m)) {
      (RANK[target] > RANK[m.tier] ? result.promoted : result.demoted).push(m.id);
    } else {
      result.skipped++;
    }
  }

  // 3. Non-current memories go straight to cold (unless pinned or already cold).
  for (const m of await store.list(grant, { validOnly: false })) {
    if (currentIds.has(m.id) || m.pinned || m.tier === 'cold') continue;
    evictions.push(m);
  }
  await evictAll(store, grant, evictions, result);
}

async function evictAll(
  store: MemoryStore,
  grant: Grant,
  evictions: Memory[],
  result: ConsolidateResult,
): Promise<void> {
  for (let i = 0; i < evictions.length; i += COLD_EVICT_BATCH) {
    const batch = evictions.slice(i, i + COLD_EVICT_BATCH);
    // Each entry is the snapshot it was chosen from: the store's guard checks it.
    const skipped = new Set((await store.coldPutMany(grant, batch)).skipped);
    for (const m of batch) {
      if (skipped.has(m.id)) continue;
      result.demoted.push(m.id);
      result.evicted.push(m.id);
    }
    result.skipped += skipped.size;
  }
}
