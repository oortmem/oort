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
