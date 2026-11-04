import type { AccessLog, Tier } from './model.js';

export interface ActivationParams {
  d: number;
  ws: number;
}

export interface TierParams {
  hotTopN: number;
  coldBelow: number;
}

const HOUR_MS = 3_600_000;
/** Minimum age in hours (one minute); avoids division blow-up for fresh accesses. */
const MIN_AGE_HOURS = 1 / 60;
const MAX_RECENT = 32;
const FOLD_COUNT = 16;
/** Pseudo-age for a never-accessed memory: one year in hours. */
const EMPTY_LOG_AGE_HOURS = 24 * 365;

function ageHours(from: number, to: number): number {
  return Math.max((to - from) / HOUR_MS, MIN_AGE_HOURS);
}

/**
 * Sum of t^-d over compacted accesses, re-aged from `compactedAt` to `now`.
 * The folded accesses are summarised by their sum and mean age H (at
 * compactedAt); after delta more hours they scale by (1 + delta/H)^-d.
 */
function reagedCompacted(log: AccessLog, nowMs: number, d: number): number {
  if (log.compactedSum <= 0 || log.compactedAt === null) return 0;
  const delta = Math.max((nowMs - Date.parse(log.compactedAt)) / HOUR_MS, 0);
  const h = Math.max(log.compactedMeanAgeHours ?? 0, MIN_AGE_HOURS);
  return log.compactedSum * (1 + delta / h) ** -d;
}

/**
 * ACT-R base-level activation: A = ln(sum_j t_j^-d) + ws * salience, with t_j
 * in hours (floored at one minute).
 *
 * A log with no accesses at all would give ln(0); instead it behaves as if it
 * had one access one year ago, so new-but-never-recalled memories start
 * warm-ish rather than at negative infinity.
 */
export function activation(
  log: AccessLog,
  salience: number,
  now: Date,
  p: ActivationParams,
): number {
  const nowMs = now.getTime();
  let sum = reagedCompacted(log, nowMs, p.d);
  for (const iso of log.recent) sum += ageHours(Date.parse(iso), nowMs) ** -p.d;
  if (!(sum > 0)) sum = EMPTY_LOG_AGE_HOURS ** -p.d;
  return Math.log(sum) + p.ws * salience;
}

/**
 * Returns a new log with an access at `at`. When more than 32 timestamps are
 * held, the oldest 16 are folded into `compactedSum` (evaluated at `at`),
 * together with the previously compacted sum re-aged to `at`.
 */
export function appendAccess(log: AccessLog, at: Date, p: Pick<ActivationParams, 'd'>): AccessLog {
  const recent = [...log.recent, at.toISOString()];
  const next: AccessLog = { ...log, count: log.count + 1, recent };
  if (recent.length <= MAX_RECENT) return next;

  const atMs = at.getTime();
  const folded = recent.splice(0, FOLD_COUNT);
  const oldSum = reagedCompacted(log, atMs, p.d);
  // The old mean age was measured at the previous compactedAt; advance it to `at`.
  const delta =
    log.compactedAt === null ? 0 : Math.max((atMs - Date.parse(log.compactedAt)) / HOUR_MS, 0);
  const oldH = Math.max(log.compactedMeanAgeHours ?? 0, MIN_AGE_HOURS) + delta;
  let foldSum = 0;
  let foldAgeWeighted = 0;
  for (const iso of folded) {
    const age = ageHours(Date.parse(iso), atMs);
    const w = age ** -p.d;
    foldSum += w;
    foldAgeWeighted += w * age;
  }
  const total = oldSum + foldSum;
  next.compactedSum = total;
  next.compactedAt = at.toISOString();
  next.compactedMeanAgeHours = (oldSum * oldH + foldAgeWeighted) / total;
  return next;
}

export function tierFor(a: number, rank: number, pinned: boolean, p: TierParams): Tier {
  if (pinned) return 'hot';
  if (rank < p.hotTopN) return 'hot';
  if (a < p.coldBelow) return 'cold';
  return 'warm';
}
