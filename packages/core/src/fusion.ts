import { activation, type ActivationParams } from './activation.js';
import type { Hit } from './adapters.js';
import { isCurrent, type Memory } from './model.js';
import type { RecallMode } from './temporal.js';

/** Which slice of time a recall reads (CON-34). */
export interface TemporalView {
  mode: RecallMode;
  /** For `as-of`: the instant in valid time. */
  asOf?: string;
  /** For `known-at`: the instant in transaction time. */
  knownAt?: string;
  /** Also show withdrawn judgments (CON-71); every mode leaves them out by default. */
  includeWithdrawn?: boolean;
}

/**
 * Weight of the activation boost: fused = rrf * (1 + ACTIVATION_BOOST * sigmoid(A)). With one RRF
 * list (k=60) ranks 1 and r differ by (r-1)/61, so a band of B reorders about 61*B ranks (about 3).
 */
export const ACTIVATION_BOOST = 0.05;

/** Logistic function, stable for large |x| (returns exactly 0 or 1 without overflow). */
export function sigmoid(x: number): number {
  if (x >= 36) return 1;
  if (x <= -36) return 0;
  return 1 / (1 + Math.exp(-x));
}

/** Multiplier in [1, 1 + ACTIVATION_BOOST] for an activation value. */
export function activationBoost(a: number): number {
  return 1 + ACTIVATION_BOOST * sigmoid(a);
}

export interface FuseParams {
  activation: ActivationParams;
  /** ISO timestamp: fuse over what was true then instead of what is true now. */
  asOf?: string;
  /** The temporal view; wins over `asOf`. Defaults to current, or as-of `asOf`. */
  view?: TemporalView;
}

/**
 * Reciprocal rank fusion: score(id) = Σ over lists of 1 / (k + rank), rank
 * 1-based. An id repeated within one list counts once, at its best rank.
 */
export function rrf(lists: Hit[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((hit, i) => {
      if (seen.has(hit.id)) return;
      seen.add(hit.id);
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

/**
 * Current now (`isCurrent(m, now)`), or, with `asOf`, valid in the world at
 * that instant. As-of ignores `expiredAt` (it asks what was true then, not
 * what the system currently believes), but a corrected fact was never true.
 */
export function isValid(m: Memory, now: Date, asOf: string | undefined): boolean {
  if (asOf === undefined) return isCurrent(m, now);
  return isVisible(m, now, { mode: 'as-of', asOf });
}

const t = (iso: string): number => Date.parse(iso);

/**
 * Validity is a hard filter, per view:
 * - current: true now and still believed (`isCurrent`).
 * - as-of T: true at T in valid time, whatever we learned since; corrected facts never are.
 * - known-at X: what we believed at X: recorded by then, not yet retracted then, and true at X
 *   as far as we knew (an end recorded after X was not known yet), corrected facts included.
 * - history: every version of a fact, except corrected ones.
 */
export function isVisible(m: Memory, now: Date, v: TemporalView): boolean {
  // A withdrawn judgment no longer counts in any slice of time: the expert took it back.
  if (m.judgment?.withdrawn !== undefined && v.includeWithdrawn !== true) return false;
  switch (v.mode) {
    case 'current':
      return isCurrent(m, now);
    case 'as-of':
      return (
        m.endReason !== 'corrected' &&
        isCurrent({ ...m, expiredAt: null }, v.asOf === undefined ? now : new Date(v.asOf))
      );
    case 'known-at': {
      const x = v.knownAt === undefined ? now.getTime() : t(v.knownAt);
      const retractedLater = m.expiredAt !== null && t(m.expiredAt) > x;
      // Only a supersession or correction sets an end later than the fact was written, so only
      // then was the end unknown at X. An end the fact stated itself (or expiry) always counts.
      const endLearnedLater =
        retractedLater && (m.endReason === 'superseded' || m.endReason === 'corrected');
      return (
        t(m.createdAt) <= x &&
        (m.expiredAt === null || retractedLater) &&
        t(m.validFrom) <= x &&
        (m.validTo === null || t(m.validTo) > x || endLearnedLater)
      );
    }
    case 'history':
      return m.endReason !== 'corrected' && t(m.validFrom) <= now.getTime();
  }
}

/**
 * RRF over the first-stage lists, filtered by temporal validity and
 * scaled by a bounded activation boost. Ids absent from `memories` are
 * dropped. Returns best first; `score` is the fused score, `rrf` the raw RRF.
 */
export function fuse(
  hits: Hit[][],
  memories: Map<string, Memory>,
  now: Date,
  p: FuseParams,
): { id: string; score: number; rrf: number }[] {
  const out: { id: string; score: number; rrf: number }[] = [];
  const view: TemporalView =
    p.view ?? (p.asOf === undefined ? { mode: 'current' } : { mode: 'as-of', asOf: p.asOf });
  for (const [id, base] of rrf(hits)) {
    const m = memories.get(id);
    if (m === undefined || !isVisible(m, now, view)) continue;
    const a = activation(m.accessLog, m.salience, now, p.activation);
    out.push({ id, score: base * activationBoost(a), rrf: base });
  }
  return out.sort((x, y) => y.score - x.score);
}
