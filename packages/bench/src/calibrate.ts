import type { EvalRow } from './eval.js';

/** Scores recall saw for one eval row, with the relevance gate off. */
export interface CalibrationSample {
  category: string;
  /** Rerank scores of the row's expected memories that were returned. */
  expected: number[];
  /** The best rerank score among the returned memories (any memory), or undefined if none. */
  top: number | undefined;
}

export interface CalibrationResult {
  /** Rows with expected memories whose best expected score was seen. */
  positives: number;
  /** Abstention rows that returned anything. */
  negatives: number;
  /** The smallest threshold that keeps at most `maxFalsePositive` of abstention rows. */
  suggested: number;
  /** Share of positive rows that keep at least one expected memory at `suggested`. */
  keptAtSuggested: number;
  /** The lowest best-expected score among answerable rows: the margin below the threshold. */
  lowestAnswerable: number | undefined;
  /** The highest top score among abstention rows: the margin above it. */
  highestAbstention: number | undefined;
  /** Share of abstention rows still answered at `suggested`. */
  falsePositiveAtSuggested: number;
}

/**
 * Picks a score threshold from labelled samples: the lowest value at which at most
 * `maxFalsePositive` of abstention rows still return a memory, rounded up to 0.05.
 */
export function suggestThreshold(
  samples: CalibrationSample[],
  maxFalsePositive = 0.1,
): CalibrationResult {
  const pos = samples.filter((s) => s.category !== 'abstention' && s.expected.length > 0);
  const neg = samples.filter((s) => s.category === 'abstention' && s.top !== undefined);
  const negTops = neg.map((s) => s.top as number).sort((a, b) => b - a);
  const allowed = Math.floor(maxFalsePositive * neg.length);
  // The (allowed+1)-th highest abstention score must fall below the threshold.
  const bound = negTops[allowed] ?? 0;
  const suggested = Math.min(1, Math.ceil((bound + 1e-9) / 0.05) * 0.05);
  const kept = pos.filter((s) => Math.max(...s.expected) >= suggested).length;
  const fp = neg.filter((s) => (s.top as number) >= suggested).length;
  return {
    positives: pos.length,
    negatives: neg.length,
    suggested: Number(suggested.toFixed(2)),
    keptAtSuggested: pos.length === 0 ? 1 : kept / pos.length,
    falsePositiveAtSuggested: neg.length === 0 ? 0 : fp / neg.length,
    lowestAnswerable:
      pos.length === 0 ? undefined : Math.min(...pos.map((s) => Math.max(...s.expected))),
    highestAbstention: negTops[0],
  };
}

/** One sample from a row and recall's returned ids with their scores. */
export function sampleFor(
  row: EvalRow,
  scored: { id: string; score?: number }[],
): CalibrationSample {
  const want = new Set(row.expectedMemoryIds);
  const scores = scored.flatMap((m) => (m.score === undefined ? [] : [m.score]));
  return {
    category: row.category ?? 'uncategorized',
    expected: scored.flatMap((m) => (want.has(m.id) && m.score !== undefined ? [m.score] : [])),
    top: scores.length === 0 ? undefined : Math.max(...scores),
  };
}

/**
 * Where a reranker's scores leave the relevance gate room on the demo eval: the lowest best
 * expected score among answerable rows, and the highest top score among abstention rows.
 */
export interface ScoreMargin {
  lowestAnswerable: number;
  highestAbstention: number;
}

/**
 * Voyage `rerank-3-lite` on the demo eval, recorded on 2026-11-04 with `pnpm --filter
 * @oortmem/bench run calibrate` (CON-45; docs/claude-code.md): every answerable row kept a memory
 * scoring 0.767 or more, and no abstention row scored above 0.303. `recall.minRerankScore` (0.35)
 * was set inside this margin. The run was not stored per row, so these two numbers are all that
 * is known of Voyage's score distribution on the eval.
 */
export const VOYAGE_DEMO_MARGIN: ScoreMargin = {
  lowestAnswerable: 0.767,
  highestAbstention: 0.303,
};

/** The inverse of the logistic function, for 0 < p < 1. */
export function logit(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`logit needs 0 < p < 1, got ${p}`);
  return Math.log(p / (1 - p));
}

export interface SeparatingMargin extends ScoreMargin {
  /** Answerable rows whose best expected score falls below the split (Voyage kept them all). */
  answerableBelow: number;
  /** Abstention rows whose top score is at or above the split (Voyage answered none of them). */
  abstentionAbove: number;
  answerable: number;
  abstention: number;
}

/**
 * The margin of `samples` around the split that disagrees with the fewest rows: answerable rows
 * below it plus abstention rows above it. When every split costs some rows (the reranker ranks a
 * relevant memory of one row below an unrelated one of another), the margin is taken between the
 * rows that remain, and the rows given up are counted. Among equally good splits it gives up
 * abstention rows before answerable ones, as Voyage kept every answerable row, then takes the
 * widest margin. Undefined when either side has no rows.
 */
export function separatingMargin(samples: CalibrationSample[]): SeparatingMargin | undefined {
  const pos = samples
    .filter((s) => s.category !== 'abstention' && s.expected.length > 0)
    .map((s) => Math.max(...s.expected));
  const neg = samples
    .filter((s) => s.category === 'abstention' && s.top !== undefined)
    .map((s) => s.top as number);
  if (pos.length === 0 || neg.length === 0) return undefined;
  let best: SeparatingMargin | undefined;
  // A split just above each value (and below them all): everything >= the split passes.
  for (const t of [-Infinity, ...pos, ...neg].map((v) => (v === -Infinity ? v : v + 1e-9))) {
    const keptPos = pos.filter((x) => x >= t);
    const droppedNeg = neg.filter((x) => x < t);
    if (keptPos.length === 0 || droppedNeg.length === 0) continue;
    const m: SeparatingMargin = {
      lowestAnswerable: Math.min(...keptPos),
      highestAbstention: Math.max(...droppedNeg),
      answerableBelow: pos.length - keptPos.length,
      abstentionAbove: neg.length - droppedNeg.length,
      answerable: pos.length,
      abstention: neg.length,
    };
    const cost = (x: SeparatingMargin): [number, number, number] => [
      x.answerableBelow + x.abstentionAbove,
      x.answerableBelow,
      -(x.lowestAnswerable - x.highestAbstention),
    ];
    const [c, cb] = [cost(m), best === undefined ? undefined : cost(best)];
    if (
      cb === undefined ||
      c[0] < cb[0] ||
      (c[0] === cb[0] && (c[1] < cb[1] || (c[1] === cb[1] && c[2] < cb[2])))
    ) {
      best = m;
    }
  }
  return best;
}

/**
 * Fits a reranker's `score = sigmoid(scale * logit + shift)` so that its raw logits land where
 * the target's scores did on the same eval: the local margin's lowest answerable logit maps to
 * the target's lowest answerable score, and its highest abstention logit to the target's highest
 * abstention score. Two points fix the two parameters; the map is affine in logit space, so it is
 * strictly increasing (it never reorders a reranker's results) and stays within 0 to 1. The
 * relevance gate (`recall.minRerankScore`) then sits at the same relative place in the local
 * margin as in the target's, and makes the target's decisions on every row the margin keeps.
 *
 * Throws when the margin is empty: no increasing map can separate what the logits do not.
 */
export function fitLogitCalibration(
  local: ScoreMargin,
  target: ScoreMargin = VOYAGE_DEMO_MARGIN,
): { scale: number; shift: number } {
  const gap = local.lowestAnswerable - local.highestAbstention;
  if (!(gap > 0)) {
    throw new Error(
      `local logits do not separate the eval: lowest answerable ${local.lowestAnswerable.toFixed(3)}, ` +
        `highest abstention ${local.highestAbstention.toFixed(3)}`,
    );
  }
  const hi = logit(target.lowestAnswerable);
  const lo = logit(target.highestAbstention);
  const scale = (hi - lo) / gap;
  return { scale, shift: hi - scale * local.lowestAnswerable };
}
