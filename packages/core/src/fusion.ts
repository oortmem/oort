import { activation, type ActivationParams } from './activation.js';
import type { Hit } from './adapters.js';
import { isCurrent, type Memory } from './model.js';

/**
 * Weight of the activation boost in `fuse`: fused = rrf * (1 + ACTIVATION_BOOST * sigmoid(A)),
 * so activation scales relevance by at most 1.5x and only reorders near-ties.
 */
export const ACTIVATION_BOOST = 0.5;

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
 * that instant. As-of ignores `expiredAt`: it asks what was true then, not
 * what the system currently believes.
 */
function isValid(m: Memory, now: Date, asOf: string | undefined): boolean {
  if (asOf === undefined) return isCurrent(m, now);
  return isCurrent({ ...m, expiredAt: null }, new Date(asOf));
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
  for (const [id, base] of rrf(hits)) {
    const m = memories.get(id);
    if (m === undefined || !isValid(m, now, p.asOf)) continue;
    const a = activation(m.accessLog, m.salience, now, p.activation);
    out.push({ id, score: base * activationBoost(a), rrf: base });
  }
  return out.sort((x, y) => y.score - x.score);
}
