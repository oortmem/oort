import type { DecisionRow } from './decide-eval.js';

/**
 * Fits the local decider's calibration (`DecideModelSpec.calibration`): for each yes-or-no
 * question, the log-odds bias that makes "yes at 0.5" separate the labelled rows best. The truth
 * for each question follows from the row's label (a SUPERSEDE row is related, conflicting and
 * not a mistake); rows outside a question's branch of the tree do not count for it.
 */

export type FitQuestion =
  | 'should_store'
  | 'volatile'
  | 'novel'
  | 'related'
  | 'conflict'
  | 'mistake'
  | 'newinfo'
  | 'samefact';

/** The label for `q` on `row`, or undefined when the row does not inform `q`. */
export function truthOf(q: FitQuestion, row: DecisionRow): boolean | undefined {
  if (row.kind === 'gate') {
    if (q === 'should_store') return row.expect.store;
    if (q === 'volatile') return row.expect.store ? row.expect.volatile : undefined;
    return undefined;
  }
  if (row.kind === 'novel') return q === 'novel' ? row.expect === 'ADD' : undefined;
  const a = row.expect === 'UPDATE' ? 'REFINE' : row.expect;
  switch (q) {
    case 'related':
      return a !== 'NOOP';
    case 'conflict':
      return a === 'NOOP' ? undefined : a === 'SUPERSEDE' || a === 'CORRECT';
    case 'mistake':
      return a === 'SUPERSEDE' || a === 'CORRECT' ? a === 'CORRECT' : undefined;
    case 'newinfo':
      return a === 'REINFORCE' || a === 'REFINE' || a === 'ADD' ? a !== 'REINFORCE' : undefined;
    case 'samefact':
      return a === 'REFINE' || a === 'ADD' ? a === 'REFINE' : undefined;
    default:
      return undefined;
  }
}

const logit = (p: number): number => {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
};

/** The cut on log-odds that classifies `xs` best (ties: the cut nearest 0). */
export function bestCut(xs: { x: number; truth: boolean }[]): number {
  const vals = [...new Set(xs.map((s) => s.x))].sort((a, b) => a - b);
  if (vals.length === 0) return 0;
  const cuts = [vals[0]! - 1, ...vals.slice(1).map((v, i) => (v + vals[i]!) / 2), vals.at(-1)! + 1];
  const correct = (c: number) => xs.filter((s) => s.x > c === s.truth).length;
  return cuts.reduce((b, c) =>
    correct(c) > correct(b) || (correct(c) === correct(b) && Math.abs(c) < Math.abs(b)) ? c : b,
  );
}

export interface FitResult {
  question: FitQuestion;
  rows: number;
  /** Log-odds to add: minus the best cut, rounded to 0.01. */
  bias: number;
  /** Rows right at 0.5 with no bias, with the bias, and leave-one-out. */
  raw: number;
  fitted: number;
  leaveOneOut: number;
}

export function fitCalibration(
  samples: { question: FitQuestion; yes: number; row: DecisionRow }[],
): FitResult[] {
  const questions = [...new Set(samples.map((s) => s.question))];
  return questions.map((q) => {
    const xs = samples.flatMap((s) => {
      if (s.question !== q) return [];
      const truth = truthOf(q, s.row);
      return truth === undefined ? [] : [{ x: logit(s.yes), truth }];
    });
    const cut = bestCut(xs);
    const loo = xs.filter((s, i) => s.x > bestCut(xs.filter((_, j) => j !== i)) === s.truth).length;
    return {
      question: q,
      rows: xs.length,
      bias: Math.round(-cut * 100) / 100,
      raw: xs.filter((s) => s.x > 0 === s.truth).length,
      fitted: xs.filter((s) => s.x > cut === s.truth).length,
      leaveOneOut: loo,
    };
  });
}
