/**
 * `pnpm eval compare <a.jsonl> <b.jsonl>`: a paired significance test between two runs, from
 * their per-question lines (`per-question.ts`). Both runs must have asked the same questions; a
 * question is paired with itself, so the test sees only how each question moved.
 *
 * For each level, group and metric it reports the paired difference B - A with:
 * - a percentile bootstrap 95% interval of the mean difference (questions resampled with
 *   replacement, seeded with `prng.ts`, so the same input always prints the same interval);
 * - a two-sided exact sign test: of the questions that moved, how many moved each way, and the
 *   binomial probability of a split at least that uneven if up and down were equally likely.
 *   Questions with no change (ties) are left out of the sign test.
 */
import * as fs from 'node:fs';
import { createRng } from './prng.js';
import { cell } from './eval.js';
import { percentile } from './stats.js';
import { parseQuestionResults, type QuestionResult } from './per-question.js';

export interface SignTest {
  /** Questions where B is higher. */
  up: number;
  /** Questions where B is lower. */
  down: number;
  ties: number;
  /** Two-sided exact binomial p over the questions that moved; 1 when none moved. */
  p: number;
}

/** ln(n!) for n = 0..max. */
function logFactorials(max: number): number[] {
  const out = [0];
  for (let i = 1; i <= max; i++) out.push((out[i - 1] as number) + Math.log(i));
  return out;
}

/** Two-sided exact sign test on paired differences (positive: B is higher). */
export function signTest(diffs: readonly number[]): SignTest {
  const up = diffs.filter((d) => d > 0).length;
  const down = diffs.filter((d) => d < 0).length;
  const ties = diffs.length - up - down;
  const n = up + down;
  if (n === 0) return { up, down, ties, p: 1 };
  const lf = logFactorials(n);
  const tail = Math.min(up, down);
  let sum = 0;
  for (let i = 0; i <= tail; i++) {
    sum += Math.exp((lf[n] as number) - (lf[i] as number) - (lf[n - i] as number) - n * Math.LN2);
  }
  return { up, down, ties, p: Math.min(1, 2 * sum) };
}

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
}

/**
 * Percentile bootstrap of the mean of `diffs`: `resamples` resamples of the same size, drawn
 * with replacement from a PRNG seeded with `seed`; the interval holds the middle `level` of their
 * means (nearest rank).
 */
export function bootstrapMean(
  diffs: readonly number[],
  opts: { resamples?: number; seed?: number; level?: number } = {},
): Interval {
  const n = diffs.length;
  if (n === 0) throw new Error('bootstrap: no paired questions');
  const resamples = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  const rng = createRng(opts.seed ?? 1);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[rng.int(n)] as number;
    means.push(sum / n);
  }
  const tail = ((1 - level) / 2) * 100;
  return {
    mean: diffs.reduce((a, b) => a + b, 0) / n,
    lo: percentile(means, tail),
    hi: percentile(means, 100 - tail),
  };
}

export interface ComparedMetric {
  level: string;
  group: string;
  metric: string;
  /** Questions where both runs have a value for this metric. */
  n: number;
  a: number;
  b: number;
  diff: Interval;
  sign: SignTest;
}

export interface Comparison {
  a: string;
  b: string;
  questions: number;
  rows: ComparedMetric[];
}

const key = (r: QuestionResult): string => `${r.level}\0${r.id}`;

/**
 * Text read from a file, safe to print: control characters (terminal escapes, line breaks) are
 * dropped, so a crafted id or group cannot rewrite the terminal or break a table row.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
export const printable = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/** `printable`, with `|` escaped so the text stays in one markdown table cell. */
const tableText = (s: string): string => printable(s).replace(/\|/g, '\\|');

/** A few example ids for an error message. */
const some = (ids: string[]): string =>
  `${ids.slice(0, 5).map(printable).join(', ')}${ids.length > 5 ? `, and ${ids.length - 5} more` : ''}`;

/**
 * Pairs two runs question by question and tests every metric, overall and per group. Throws when
 * the runs did not ask the same questions (an id on one side only, or the same id with another
 * question or group), or when a run lists a question twice.
 */
export function compareRuns(
  a: readonly QuestionResult[],
  b: readonly QuestionResult[],
  opts: { resamples?: number; seed?: number; labels?: [string, string] } = {},
): Comparison {
  const [la, lb] = opts.labels ?? [a[0]?.run ?? 'A', b[0]?.run ?? 'B'];
  const index = (rs: readonly QuestionResult[], label: string): Map<string, QuestionResult> => {
    const m = new Map<string, QuestionResult>();
    for (const r of rs) {
      if (m.has(key(r)))
        throw new Error(
          `${printable(label)} lists question ${printable(r.id)} (${printable(r.level)}) more than once`,
        );
      m.set(key(r), r);
    }
    return m;
  };
  const ia = index(a, la);
  const ib = index(b, lb);
  const onlyA = [...ia.keys()].filter((k) => !ib.has(k));
  const onlyB = [...ib.keys()].filter((k) => !ia.has(k));
  if (onlyA.length > 0 || onlyB.length > 0) {
    const name = (k: string): string => k.replace('\0', ' ');
    throw new Error(
      `the runs did not ask the same questions: ${onlyA.length} only in ${printable(la)}` +
        `${onlyA.length > 0 ? ` (${some(onlyA.map(name))})` : ''}, ${onlyB.length} only in ${printable(lb)}` +
        `${onlyB.length > 0 ? ` (${some(onlyB.map(name))})` : ''}. ` +
        'Compare runs of the same set, with the same --limit.',
    );
  }
  const differs = [...ia.entries()].filter(([k, x]) => {
    const y = ib.get(k) as QuestionResult;
    return x.question !== y.question || x.group !== y.group;
  });
  if (differs.length > 0) {
    throw new Error(
      `${differs.length} question id(s) name a different question or group in the two runs ` +
        `(${some(differs.map(([, x]) => x.id))}): these are not runs of the same set.`,
    );
  }
  const rows: ComparedMetric[] = [];
  const levels = [...new Set(a.map((r) => r.level))];
  for (const level of levels) {
    const atLevel = a.filter((r) => r.level === level);
    const groups = ['overall', ...new Set(atLevel.map((r) => r.group))];
    const metrics = [...new Set(atLevel.flatMap((r) => Object.keys(r.metrics)))];
    for (const group of groups) {
      const inGroup = group === 'overall' ? atLevel : atLevel.filter((r) => r.group === group);
      for (const metric of metrics) {
        const pairs = inGroup.flatMap((x) => {
          const va = x.metrics[metric];
          const vb = (ib.get(key(x)) as QuestionResult).metrics[metric];
          return typeof va === 'number' && typeof vb === 'number' ? [[va, vb] as const] : [];
        });
        if (pairs.length === 0) continue;
        const diffs = pairs.map(([x, y]) => y - x);
        const meanOf = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
        rows.push({
          level,
          group,
          metric,
          n: pairs.length,
          a: meanOf(pairs.map(([x]) => x)),
          b: meanOf(pairs.map(([, y]) => y)),
          diff: bootstrapMean(diffs, {
            ...(opts.resamples !== undefined && { resamples: opts.resamples }),
            ...(opts.seed !== undefined && { seed: opts.seed }),
          }),
          sign: signTest(diffs),
        });
      }
    }
  }
  return { a: la, b: lb, questions: ia.size, rows };
}

/** The runs in a per-question file, in first-seen order. */
export const runsIn = (rs: readonly QuestionResult[]): string[] => [
  ...new Set(rs.map((r) => r.run)),
];

/**
 * Which runs to compare. With a run named on a side, that run; a file with one run needs no name.
 * Without names, two files that hold the same several runs are compared run by run.
 */
export function pickRuns(
  a: readonly QuestionResult[],
  b: readonly QuestionResult[],
  names: { a?: string; b?: string } = {},
): [string, string][] {
  const ra = runsIn(a);
  const rb = runsIn(b);
  const pick = (runs: string[], name: string | undefined, side: string): string | undefined => {
    if (name !== undefined) {
      if (!runs.includes(name))
        throw new Error(
          `--run-${side} ${printable(name)}: not in file ${side} (it has ${runs.map(printable).join('; ')})`,
        );
      return name;
    }
    return runs.length === 1 ? runs[0] : undefined;
  };
  const pa = pick(ra, names.a, 'a');
  const pb = pick(rb, names.b, 'b');
  if (pa !== undefined && pb !== undefined) return [[pa, pb]];
  if (pa === undefined && pb === undefined) {
    const shared = ra.filter((r) => rb.includes(r));
    if (shared.length > 0 && shared.length === ra.length && shared.length === rb.length) {
      return shared.map((r) => [r, r]);
    }
  }
  throw new Error(
    `pick the runs to compare with --run-a and --run-b. File a has: ${ra.map(printable).join('; ')}. ` +
      `File b has: ${rb.map(printable).join('; ')}.`,
  );
}

const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
const pValue = (p: number): string => (p < 0.001 ? '<0.001' : p.toFixed(3));

export function renderComparison(c: Comparison): string {
  const lines = [
    `A: ${tableText(c.a)}`,
    `B: ${tableText(c.b)}`,
    `${c.questions} paired lines (a question once per level).`,
  ];
  for (const level of new Set(c.rows.map((r) => r.level))) {
    lines.push(
      '',
      `Level: ${printable(level)}. B - A with a 95% bootstrap interval; sign test over the questions that moved.`,
      '',
      '| Group | Metric | n | A | B | B - A | 95% interval | Up / down / same | Sign p |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const r of c.rows.filter((x) => x.level === level)) {
      lines.push(
        `| ${[
          tableText(r.group),
          tableText(r.metric),
          String(r.n),
          cell(r.a),
          cell(r.b),
          signed(r.diff.mean),
          `${signed(r.diff.lo)} to ${signed(r.diff.hi)}`,
          `${r.sign.up} / ${r.sign.down} / ${r.sign.ties}`,
          pValue(r.sign.p),
        ].join(' | ')} |`,
      );
    }
  }
  lines.push(
    '',
    'No correction for testing many metrics and groups at once: with 20 tests, one p below 0.05 is expected by chance.',
  );
  return lines.join('\n');
}

/**
 * `pnpm eval compare`: reads two per-question files, picks the runs (`pickRuns`) and compares
 * each pair. Returns the printed text (markdown tables, or JSON with `json`).
 */
export function compareFiles(
  fileA: string,
  fileB: string,
  opts: { runA?: string; runB?: string; resamples?: number; seed?: number; json?: boolean } = {},
): string {
  const read = (f: string): QuestionResult[] => parseQuestionResults(fs.readFileSync(f, 'utf8'), f);
  const a = read(fileA);
  const b = read(fileB);
  if (a.length === 0) throw new Error(`${fileA} holds no per-question results`);
  if (b.length === 0) throw new Error(`${fileB} holds no per-question results`);
  const pairs = pickRuns(a, b, {
    ...(opts.runA !== undefined && { a: opts.runA }),
    ...(opts.runB !== undefined && { b: opts.runB }),
  });
  const comparisons = pairs.map(([ra, rb]) =>
    compareRuns(
      a.filter((r) => r.run === ra),
      b.filter((r) => r.run === rb),
      {
        labels: [`${fileA} ${ra}`, `${fileB} ${rb}`],
        ...(opts.resamples !== undefined && { resamples: opts.resamples }),
        ...(opts.seed !== undefined && { seed: opts.seed }),
      },
    ),
  );
  return opts.json === true
    ? JSON.stringify(comparisons, null, 2)
    : comparisons.map(renderComparison).join('\n\n');
}
