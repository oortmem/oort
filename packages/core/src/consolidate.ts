import { activation, tierFor } from './activation.js';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import type { ResolvedConfig } from './config.js';
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
}

/** Evictions per `coldPutMany` call: one store transaction and one directory sync each. */
export const COLD_EVICT_BATCH = 500;

const RANK: Record<Tier, number> = { cold: 0, warm: 1, hot: 2 };

/**
 * Background consolidation. In order:
 * 1. Expire: memories with `validTo <= now` and no `expiredAt` get
 *    `expiredAt = now`, `endReason = endReason ?? "expired"`.
 * 2. Rank current memories by ACT-R activation (ties: newer `updatedAt`
 *    first) and assign tiers via `tierFor`; changes are `setTier`d and new
 *    cold memories are collected and `coldPutMany`'d in batches of `COLD_EVICT_BATCH`.
 * 3. Non-current memories (superseded, expired, corrected) go straight to cold.
 *
 * Rules: pinned memories are never cold-put; a pinned non-current memory is
 * left in its current tier (hot or warm); consolidate never promotes cold to warm/hot, since
 * hydration is recall's job.
 * Idempotent for a fixed `now`.
 */
export async function consolidate(
  scope: ScopeFilter,
  deps: { store: MemoryStore; config: ResolvedConfig; now?: Date },
): Promise<ConsolidateResult> {
  const { store, config } = deps;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const result: ConsolidateResult = { promoted: [], demoted: [], evicted: [], expired: [] };

  // 1. Expire.
  for (const m of await store.list(scope, { validOnly: false })) {
    if (m.validTo !== null && m.expiredAt === null && Date.parse(m.validTo) <= now.getTime()) {
      await store.upsert({ ...m, expiredAt: nowIso, endReason: m.endReason ?? 'expired' });
      result.expired.push(m.id);
    }
  }

  // 2. Rank and assign current memories.
  const current = (await store.list(scope, { validOnly: true })).filter((m) => isCurrent(m, now));
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
    } else {
      await store.setTier(m.id, target);
      (RANK[target] > RANK[m.tier] ? result.promoted : result.demoted).push(m.id);
    }
  }

  // 3. Non-current memories go straight to cold (unless pinned or already cold).
  for (const m of await store.list(scope, { validOnly: false })) {
    if (currentIds.has(m.id) || m.pinned || m.tier === 'cold') continue;
    evictions.push(m);
  }
  await evictAll(store, evictions, result);

  return result;
}

async function evictAll(
  store: MemoryStore,
  evictions: Memory[],
  result: ConsolidateResult,
): Promise<void> {
  for (let i = 0; i < evictions.length; i += COLD_EVICT_BATCH) {
    const batch = evictions.slice(i, i + COLD_EVICT_BATCH);
    // coldPutMany itself sets tier 'cold' on the main record.
    await store.coldPutMany(batch.map((m) => ({ ...m, tier: 'cold' as const })));
    for (const m of batch) {
      result.demoted.push(m.id);
      result.evicted.push(m.id);
    }
  }
}
