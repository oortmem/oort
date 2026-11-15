/**
 * `pnpm eval sweep-gate <file.questions.jsonl>`: replays recall's relevance gate offline at many
 * thresholds, from the per-hit scores a run with the gate off writes into its per-question lines
 * (`QuestionScores`), so a threshold is chosen from data without paying for a run per candidate.
 *
 * How recall gates today (`@oortmem/core` `recall.ts`): after the rerank, each of the top
 * `returnK` memories is tested on its own. A memory with a rerank score is kept when the score is
 * at least `recall.minRerankScore`. One without (no reranker, as in `fast`; a rerank skipped as
 * confident, failed or timed out) is kept when it holds at least `recall.minCoverage` of the
 * question's informative words, or has a dense similarity of at least `recall.minDenseScore`. A
 * threshold of 0 turns its test off. Kept memories keep their order; the rest are dropped. Linked
 * memories are admitted after that, only beside a kept hit, and the adaptive stop then reads the
 * kept hits: neither can be replayed from the lines, so runs that used them are refused.
 *
 * Gates simulated (the coverage and dense test is kept as it is for memories without a score):
 * - `fixed t`: today's gate with `minRerankScore` t: each hit below t is dropped.
 * - `top t`: nothing is returned when the best rerank score is below t; otherwise every hit is.
 * - `margin d, floor f`: nothing is returned when the best score is below f or leads the second
 *   by less than d (a single hit leads by its own score); otherwise hits below f are dropped.
 *   With d = 0 it is `fixed f`.
 *
 * For each gate: recall@10 on the answerable questions at each level, the abstention false-positive
 * rate (abstention questions that still return something), and each one's paired difference from
 * today's default with the 95% bootstrap interval `compare` uses (same resampling, same seed). The
 * Pareto front is over the first level's recall@10 (higher is better) and the false-positive rate
 * (lower is better).
 */
import * as fs from 'node:fs';
import { OortConfig } from '@oortmem/core';
import { bootstrapMean, printable, runsIn, type Interval } from './compare.js';
import { cell, scoreRow, type EvalRow } from './eval.js';
import { parseQuestionResults, type QuestionResult, type QuestionScores } from './per-question.js';

export type Gate =
  | { kind: 'fixed'; t: number }
  | { kind: 'top'; t: number }
  | { kind: 'margin'; d: number; floor: number };

/** The test for memories without a rerank score: `recall.minCoverage` and `recall.minDenseScore`. */
export interface Floors {
  coverage: number;
  dense: number;
}

const two = (x: number): string => x.toFixed(2);

export function gateLabel(g: Gate): string {
  if (g.kind === 'fixed') return `fixed ${two(g.t)}`;
  if (g.kind === 'top') return `top ${two(g.t)}`;
  return `margin ${two(g.d)}, floor ${two(g.floor)}`;
}

/** A score as whole ten-thousandths: scores in the lines have 4 decimals, so this is exact. */
const units = (x: number): number => Math.round(x * 1e4);

/**
 * The thresholds `step` apart from 0 to below 1 (each rounded to 4 decimals), and the gates of each
 * family over them: `fixed` and `top` at each, `margin` at each of `margins` with each as floor.
 */
export function defaultGates(
  step = 0.05,
  margins: readonly number[] = [0.02, 0.05, 0.1, 0.2],
): Gate[] {
  if (!(step > 0 && step < 1)) throw new Error('--step must be between 0 and 1');
  const ts: number[] = [];
  for (let i = 0; units(i * step) < 1e4; i++) ts.push(units(i * step) / 1e4);
  return [
    ...ts.map((t): Gate => ({ kind: 'fixed', t })),
    ...ts.map((t): Gate => ({ kind: 'top', t })),
    ...margins.flatMap((d) => ts.map((floor): Gate => ({ kind: 'margin', d, floor }))),
  ];
}

/** Recall's test for a memory without a rerank score (`relevant` in `recall.ts`). */
function passesWithoutRerank(s: QuestionScores, i: number, f: Floors): boolean {
  if (f.coverage === 0) return true;
  if ((s.coverage[i] as number) >= f.coverage) return true;
  return f.dense > 0 && (s.dense[i] ?? -1) >= f.dense;
}

/** Recall's per-hit test at rerank threshold `t`. */
function passes(s: QuestionScores, i: number, t: number, f: Floors): boolean {
  const r = s.rerank[i];
  return r !== null && r !== undefined ? r >= t : passesWithoutRerank(s, i, f);
}

/** The positions of the returned memories gate `g` keeps, in order. */
export function keptHits(s: QuestionScores, g: Gate, f: Floors): number[] {
  const all = s.coverage.map((_, i) => i);
  const scored = s.rerank.filter((x): x is number => x !== null).sort((a, b) => b - a);
  // Without any rerank score every gate is recall's coverage and dense test.
  if (scored.length === 0) return all.filter((i) => passesWithoutRerank(s, i, f));
  if (g.kind === 'fixed') return all.filter((i) => passes(s, i, g.t, f));
  const top = scored[0] as number;
  if (g.kind === 'top') {
    if (top < g.t) return [];
    return all.filter((i) => s.rerank[i] !== null || passesWithoutRerank(s, i, f));
  }
  const lead = units(top) - units(scored[1] ?? 0);
  if (top < g.floor || lead < units(g.d)) return [];
  return all.filter((i) => passes(s, i, g.floor, f));
}

/**
 * The line as gate `g` would have left it: the kept memories, in order, re-ranked and re-scored
 * with the same `scoreRow` the totals use. The result has no `scores`, and no linked memories.
 */
export function simulateLine(l: QuestionResult, g: Gate, f: Floors): QuestionResult {
  const s = l.scores;
  if (s === undefined) throw new Error(`question ${printable(l.id)} has no per-hit scores`);
  const kept = keptHits(s, g, f);
  const ids = kept.map((i) => {
    const e = s.expected[i];
    if (e !== null && e !== undefined) return `e${e}`;
    const st = s.stale?.[i];
    return st !== null && st !== undefined ? `s${st}` : `x${i}`;
  });
  const row: EvalRow = {
    question: l.question,
    expectedMemoryIds: l.ranks.map((_, j) => `e${j}`),
    ...(l.staleRanks !== undefined && {
      notExpectedMemoryIds: l.staleRanks.map((_, j) => `s${j}`),
    }),
    ...(l.abstention === true && { category: 'abstention' as const }),
  };
  const ks = Object.keys(l.metrics).flatMap((k) => {
    const m = /^recall@(\d+)$/.exec(k);
    return m === null ? [] : [Number(m[1])];
  });
  const sc = scoreRow(row, { ids, aboveThreshold: ids.length }, ks);
  const metrics: Record<string, number | null> = {};
  for (const k of Object.keys(l.metrics)) {
    const m = /^recall@(\d+)$/.exec(k);
    if (m !== null) metrics[k] = sc.recallAt[Number(m[1])] ?? null;
    else if (k === 'mrr') metrics[k] = sc.rr;
    else if (k === 'staleLeak') metrics[k] = sc.staleLeak;
    else if (k === 'staleAboveCurrent') metrics[k] = sc.staleAboveCurrent;
    else if (k === 'abstainFp') metrics[k] = sc.abstainFp;
  }
  const { scores: _, ...rest } = l;
  const rank = (ref: string): number | null => {
    const at = ids.indexOf(ref);
    return at < 0 ? null : at + 1;
  };
  return {
    ...rest,
    ranks: l.ranks.map((_, j) => rank(`e${j}`)),
    ...(l.staleRanks !== undefined && { staleRanks: l.staleRanks.map((_, j) => rank(`s${j}`)) }),
    returned: kept.length,
    aboveThreshold: kept.length,
    linked: 0,
    linkedExpected: 0,
    metrics,
  };
}

/** Throws, saying why, when a run's lines cannot be replayed exactly. */
export function checkSweepable(lines: readonly QuestionResult[]): void {
  const missing = lines.filter((l) => l.scores === undefined).length;
  if (missing > 0) {
    throw new Error(
      `${missing} of ${lines.length} lines have no per-hit scores (files written before they ` +
        'were added have none). Run the set again with --no-gate to write them.',
    );
  }
  const gated = lines.find((l) => {
    const g = (l.scores as QuestionScores).gate;
    return g.rerank > 0 || g.coverage > 0 || g.dense > 0;
  });
  if (gated !== undefined) {
    const g = (gated.scores as QuestionScores).gate;
    throw new Error(
      `this run had recall's relevance gate on (minRerankScore ${g.rerank}, minCoverage ` +
        `${g.coverage}, minDenseScore ${g.dense}): the memories it dropped are not in the file. ` +
        'Run the set again with --no-gate.',
    );
  }
  const cut = lines.filter((l) => l.returned !== l.scores?.coverage.length).length;
  if (cut > 0) {
    throw new Error(
      `${cut} questions returned more memories than their lines keep scores for (50): run ` +
        'with --k at most 50.',
    );
  }
  const linked = lines.filter((l) => (l.scores?.linked?.length ?? 0) > 0).length;
  if (linked > 0) {
    throw new Error(
      `${linked} questions returned memories a link brought in: the gate also decides which ` +
        'linked memories are admitted, which the lines do not record. Sweep a run with --links off.',
    );
  }
  const stop = lines.filter((l) => l.scores?.adaptiveStop === true).length;
  if (stop > 0) {
    throw new Error(
      `${stop} questions asked the adaptive stop, which reads the gated hits: they cannot be ` +
        'replayed. Sweep a store with no cold memories.',
    );
  }
}

export interface SweepLevel {
  level: string;
  /** Answerable questions at this level (with expected ids). */
  n: number;
  recall10: number | null;
  /** Paired difference from the baseline, with its 95% bootstrap interval. */
  recallDiff: Interval | null;
  /** Mean memories returned on the answerable questions (at most 10 counted). */
  hits: number | null;
}

export interface SweepRow {
  gate: string;
  spec: Gate;
  levels: SweepLevel[];
  /** Share of the abstention questions that returned something; null without any. */
  abstainFp: number | null;
  fpDiff: Interval | null;
  /** The first level's recall@10 per group. */
  groups: Record<string, number | null>;
  /** On the Pareto front of the first level's recall@10 and the false-positive rate. */
  front: boolean;
}

export interface Sweep {
  run: string;
  baseline: string;
  floors: Floors;
  /** Abstention questions (at any level). */
  abstention: number;
  /** True when some question has a rerank score; false for a run without a reranker. */
  reranked: boolean;
  resamples: number;
  seed: number;
  rows: SweepRow[];
}

export interface SweepOptions {
  gates?: Gate[];
  /** Default: recall's defaults for `minCoverage` and `minDenseScore`. */
  floors?: Floors;
  /** Default: `fixed` at recall's default `minRerankScore`. */
  baseline?: Gate;
  resamples?: number;
  seed?: number;
}

const meanOf = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Simulates every gate over one run's lines and compares each with the baseline. */
export function sweepGate(lines: readonly QuestionResult[], opts: SweepOptions = {}): Sweep {
  if (lines.length === 0) throw new Error('no per-question lines to sweep');
  checkSweepable(lines);
  const defaults = OortConfig.parse({}).recall;
  const floors = opts.floors ?? { coverage: defaults.minCoverage, dense: defaults.minDenseScore };
  const baseline = opts.baseline ?? { kind: 'fixed', t: defaults.minRerankScore };
  const resamples = opts.resamples ?? 10_000;
  const seed = opts.seed ?? 1;
  const gates = opts.gates ?? defaultGates();
  const reranked = lines.some((l) => l.scores?.rerank.some((x) => x !== null));
  // Without a rerank score every gate is the coverage and dense test: one row says it all.
  const all = !reranked
    ? [baseline]
    : gates.some((g) => gateLabel(g) === gateLabel(baseline))
      ? gates
      : [baseline, ...gates];
  const levels = [...new Set(lines.map((l) => l.level))];
  const r10 = (l: QuestionResult): number | null => l.metrics['recall@10'] ?? null;
  const base = lines.map((l) => simulateLine(l, baseline, floors));
  const abstention = lines.flatMap((l, i) => (l.abstention === true ? [i] : []));
  const interval = (diffs: number[]): Interval | null =>
    diffs.length === 0 ? null : bootstrapMean(diffs, { resamples, seed });
  const rows: SweepRow[] = all.map((g) => {
    const sim = lines.map((l) => simulateLine(l, g, floors));
    const perLevel = levels.map((level): SweepLevel => {
      const idx = lines.flatMap((l, i) =>
        l.level === level && l.ranks.length > 0 && r10(sim[i] as QuestionResult) !== null
          ? [i]
          : [],
      );
      const values = idx.map((i) => r10(sim[i] as QuestionResult) as number);
      return {
        level,
        n: idx.length,
        recall10: meanOf(values),
        recallDiff: interval(
          idx.map((i, j) => (values[j] as number) - (r10(base[i] as QuestionResult) as number)),
        ),
        hits: meanOf(idx.map((i) => Math.min(10, (sim[i] as QuestionResult).returned))),
      };
    });
    const fp = (s: QuestionResult[], i: number): number => ((s[i]?.returned ?? 0) > 0 ? 1 : 0);
    const first = levels[0] as string;
    const groups: Record<string, number | null> = {};
    for (const group of new Set(lines.filter((l) => l.level === first).map((l) => l.group))) {
      groups[group] = meanOf(
        lines.flatMap((l, i) => {
          const v = r10(sim[i] as QuestionResult);
          return l.level === first && l.group === group && l.ranks.length > 0 && v !== null
            ? [v]
            : [];
        }),
      );
    }
    return {
      gate: gateLabel(g),
      spec: g,
      levels: perLevel,
      abstainFp: meanOf(abstention.map((i) => fp(sim, i))),
      fpDiff: interval(abstention.map((i) => fp(sim, i) - fp(base, i))),
      groups,
      front: false,
    };
  });
  const point = (r: SweepRow): [number, number] => [r.levels[0]?.recall10 ?? 0, r.abstainFp ?? 0];
  for (const r of rows) {
    const [rec, fp] = point(r);
    r.front = !rows.some((o) => {
      const [orec, ofp] = point(o);
      return orec >= rec && ofp <= fp && (orec > rec || ofp < fp);
    });
  }
  return {
    run: lines[0]?.run ?? '',
    baseline: gateLabel(baseline),
    floors,
    abstention: abstention.length,
    reranked,
    resamples,
    seed,
    rows,
  };
}

const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
const diffCell = (d: Interval | null): string =>
  d === null ? '-' : `${signed(d.mean)} (${signed(d.lo)} to ${signed(d.hi)})`;

export function renderSweep(s: Sweep): string {
  const levels = s.rows[0]?.levels ?? [];
  const lines = [
    `Run: ${printable(s.run)}. Baseline: ${s.baseline} (today's default).`,
    `Answerable questions: ${levels.map((l) => `${l.n} (${printable(l.level)})`).join(', ')}; abstention questions: ${s.abstention}.`,
    `Memories without a rerank score are kept with coverage of at least ${s.floors.coverage} or dense similarity of at least ${s.floors.dense}, as recall does.`,
  ];
  if (!s.reranked) {
    lines.push(
      'No question in this run has a rerank score (no reranker, as with --speed fast): the rerank threshold changes nothing here, so only the baseline is shown.',
    );
  }
  lines.push(
    '',
    `Differences are gate - baseline, paired by question, with a 95% bootstrap interval (${s.resamples} resamples, seed ${s.seed}). An interval that holds 0 is within the noise band. Front: on the Pareto front of ${printable(levels[0]?.level ?? '')} recall@10 and abstention false positives. Hits: mean memories returned on answerable questions.`,
    '',
  );
  const head = [
    'Gate',
    'Front',
    ...levels.flatMap((l) => [`${printable(l.level)} recall@10`, 'Difference']),
    `Hits (${printable(levels[0]?.level ?? '')})`,
    'Abstention FP',
    'Difference',
  ];
  lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
  for (const r of s.rows) {
    lines.push(
      `| ${[
        r.gate === s.baseline ? `${r.gate} (today)` : r.gate,
        r.front ? 'yes' : '',
        ...r.levels.flatMap((l) => [cell(l.recall10), diffCell(l.recallDiff)]),
        cell(r.levels[0]?.hits),
        cell(r.abstainFp),
        diffCell(r.fpDiff),
      ].join(' | ')} |`,
    );
  }
  const shown = s.rows.filter((r) => r.front || r.gate === s.baseline);
  // Groups with no answerable question (abstention) have no recall to show.
  const groups = Object.keys(shown[0]?.groups ?? {}).filter((g) =>
    shown.some((r) => r.groups[g] !== null),
  );
  if (groups.length > 1) {
    lines.push(
      '',
      `${printable(levels[0]?.level ?? '')} recall@10 per group, for the baseline and the front:`,
      '',
      `| Gate | ${groups.map(printable).join(' | ')} |`,
      `| --- | ${groups.map(() => '---').join(' | ')} |`,
    );
    for (const r of shown) {
      lines.push(`| ${r.gate} | ${groups.map((g) => cell(r.groups[g])).join(' | ')} |`);
    }
  }
  return lines.join('\n');
}

export interface SweepFileOptions {
  run?: string;
  resamples?: number;
  seed?: number;
  step?: number;
  margins?: number[];
  json?: boolean;
}

/** `pnpm eval sweep-gate`: reads a per-question file, picks the run, sweeps and renders it. */
export function sweepFile(file: string, opts: SweepFileOptions = {}): string {
  const all = parseQuestionResults(fs.readFileSync(file, 'utf8'), file);
  if (all.length === 0) throw new Error(`${file} holds no per-question results`);
  const runs = runsIn(all);
  let run = opts.run;
  if (run === undefined) {
    if (runs.length > 1) {
      throw new Error(
        `${file} holds several runs: pick one with --run (${runs.map(printable).join('; ')})`,
      );
    }
    run = runs[0] as string;
  } else if (!runs.includes(run)) {
    throw new Error(
      `--run ${printable(run)}: not in ${file} (it has ${runs.map(printable).join('; ')})`,
    );
  }
  const sweep = sweepGate(
    all.filter((l) => l.run === run),
    {
      gates: defaultGates(opts.step, opts.margins),
      ...(opts.resamples !== undefined && { resamples: opts.resamples }),
      ...(opts.seed !== undefined && { seed: opts.seed }),
    },
  );
  return opts.json === true ? JSON.stringify(sweep, null, 2) : renderSweep(sweep);
}
