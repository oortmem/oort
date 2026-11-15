/**
 * Per-question results: one JSON line per question per run, written beside a run's totals, so two
 * runs can be compared question by question (`compare.ts`) instead of only by their means.
 *
 * Each line carries what the totals are computed from: the rank of every expected id (a turn, or
 * at session level an answer session) and of every outdated one, how many memories came back and
 * how many cleared the abstention threshold, and the link-admitted memories in the top 10. It
 * also carries the question's own share of each mean metric (`metrics`), computed by the same
 * `scoreRow` the totals use, so the mean of a metric over a run's lines is that run's total.
 *
 * When recall's own scores are at hand (`RowOutcome.scores`), each line also carries them per
 * returned memory (`scores`): the rerank score, word coverage and dense similarity recall's
 * relevance gate reads, and which returned memories were expected. That is enough to replay the
 * gate at another threshold offline (`gate-sweep.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { linkCounts, ranksOf, scoreRow, type EvalRow, type RowOutcome } from './eval.js';

export interface QuestionResult {
  /** The run's configuration, `key=value` pairs joined by commas (`links=off,speed=full`). */
  run: string;
  /** What was scored: `turn` or `session` (public sets), `memory` (an eval file). */
  level: string;
  /** Unique within a run and level: the dataset's question id, or the row number of an eval file. */
  id: string;
  /** The report group (the dataset's question type, or the row's category). */
  group: string;
  question: string;
  abstention?: true;
  /** 1-based rank of each expected id among the returned ones; null when it did not come back. */
  ranks: (number | null)[];
  /** The same for each outdated (not-expected) id; absent when the question lists none. */
  staleRanks?: (number | null)[];
  returned: number;
  /** Returned memories above the abstention threshold. */
  aboveThreshold: number;
  /** Link-admitted memories in the top 10, and how many of them were expected. */
  linked: number;
  linkedExpected: number;
  /**
   * The question's share of each mean metric, null where it does not count: `recall@<k>` for each
   * k, `mrr` (reciprocal rank in the top 10), `staleLeak`, `staleAboveCurrent`, `abstainFp`.
   */
  metrics: Record<string, number | null>;
  /** Recall's scores for each returned memory (`QuestionScores`); absent in older files. */
  scores?: QuestionScores;
}

/** The thresholds of recall's relevance gate in a run; all 0 with the gate off (`--no-gate`). */
export interface GateThresholds {
  /** `recall.minRerankScore`. */
  rerank: number;
  /** `recall.minCoverage`. */
  coverage: number;
  /** `recall.minDenseScore`. */
  dense: number;
}

/** Returned memories a line keeps scores for, from the top. */
export const SCORES_KEPT = 50;

/**
 * Per returned memory, in returned order (the top `SCORES_KEPT`), what recall's relevance gate
 * reads: arrays of one length, index i for the i-th returned memory. Scores are rounded down to 4
 * decimals (`roundScore`), which keeps every comparison with a 4-decimal threshold exact.
 */
export interface QuestionScores {
  /** The gate the run applied. */
  gate: GateThresholds;
  /** The reranker's score; null when there is none (no reranker, a skipped or failed rerank). */
  rerank: (number | null)[];
  /** The share of the question's informative words the memory holds. */
  coverage: number[];
  /** The dense (cosine) similarity; null when the dense search did not score the memory. */
  dense: (number | null)[];
  /** Which expected id the memory is (an index into `ranks`), null for none. */
  expected: (number | null)[];
  /** The same for the outdated ids (an index into `staleRanks`); only with `staleRanks`. */
  stale?: (number | null)[];
  /** Positions of the memories a link brought in; absent when none. */
  linked?: number[];
  /** Present when recall asked the adaptive stop: the gate then also decided what it was asked. */
  adaptiveStop?: true;
}

/**
 * `x` to 4 decimals, rounded down: the result is never above `x`, so for any threshold `t` with at
 * most 4 decimals, `roundScore(x) >= t` exactly when `x >= t`.
 */
export function roundScore(x: number): number {
  const n = Math.round(x * 1e4);
  const r = n / 1e4;
  return r > x ? (n - 1) / 1e4 : r;
}

/** A run label from its settings, in the order given: `{ links: 'off', speed: 'full' }`. */
export const runLabel = (parts: Record<string, string>): string =>
  Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');

export interface QuestionMeta {
  run: string;
  level: string;
  /** Per row; default: the row number, from 1. */
  ids?: readonly string[];
  /** Per row; default: the row's category, or `uncategorized`. */
  groups?: readonly string[];
  /** The run's gate thresholds: with them, lines whose outcome has scores carry `scores`. */
  gate?: GateThresholds;
}

/** Where each of `returned` sits in `ids`, null for none. */
const indexIn = (ids: readonly string[], returned: readonly string[]): (number | null)[] => {
  const at = new Map<string, number>();
  ids.forEach((id, j) => {
    if (!at.has(id)) at.set(id, j);
  });
  return returned.map((id) => at.get(id) ?? null);
};

function scoresOf(r: EvalRow, o: RowOutcome, gate: GateThresholds): QuestionScores | undefined {
  if (o.scores === undefined) return undefined;
  const ids = o.ids.slice(0, SCORES_KEPT);
  const hits = o.scores.slice(0, SCORES_KEPT);
  if (hits.length !== ids.length) throw new Error('per-question: one score per returned id');
  const linked = hits.flatMap((h, i) => (h.linked === true ? [i] : []));
  return {
    gate,
    rerank: hits.map((h) => (h.rerank === undefined ? null : roundScore(h.rerank))),
    coverage: hits.map((h) => roundScore(h.coverage)),
    dense: hits.map((h) => (h.dense === undefined ? null : roundScore(h.dense))),
    expected: indexIn(r.expectedMemoryIds, ids),
    ...(r.notExpectedMemoryIds !== undefined && {
      stale: indexIn(r.notExpectedMemoryIds, ids),
    }),
    ...(linked.length > 0 && { linked }),
    ...(o.adaptiveStop === true && { adaptiveStop: true as const }),
  };
}

/** One result per row: `outcomes[i]` is what recall returned for `rows[i]`. */
export function questionResults(
  rows: readonly EvalRow[],
  outcomes: readonly RowOutcome[],
  ks: readonly number[],
  meta: QuestionMeta,
): QuestionResult[] {
  return rows.map((r, i) => {
    const o = outcomes[i] as RowOutcome;
    const s = scoreRow(r, o, ks);
    const metrics: Record<string, number | null> = {};
    for (const k of ks) metrics[`recall@${k}`] = s.recallAt[k] ?? null;
    metrics['mrr'] = s.rr;
    metrics['staleLeak'] = s.staleLeak;
    metrics['staleAboveCurrent'] = s.staleAboveCurrent;
    metrics['abstainFp'] = s.abstainFp;
    const links = linkCounts(r, o);
    const scores = meta.gate === undefined ? undefined : scoresOf(r, o, meta.gate);
    return {
      run: meta.run,
      level: meta.level,
      id: meta.ids?.[i] ?? String(i + 1),
      group: meta.groups?.[i] ?? r.category ?? 'uncategorized',
      question: r.question,
      ...(r.category === 'abstention' && { abstention: true as const }),
      ranks: ranksOf(r.expectedMemoryIds, o.ids),
      ...(r.notExpectedMemoryIds !== undefined && {
        staleRanks: ranksOf(r.notExpectedMemoryIds, o.ids),
      }),
      returned: o.ids.length,
      aboveThreshold: o.aboveThreshold,
      linked: links.linked,
      linkedExpected: links.expected,
      metrics,
      ...(scores !== undefined && { scores }),
    };
  });
}

/** Where a run's per-question lines go: beside its totals, `report.json` -> `report.questions.jsonl`. */
export function questionsPathFor(totals: string): string {
  return `${totals.replace(/\.json$/i, '')}.questions.jsonl`;
}

/**
 * The totals file and the per-question file of a run: `questions` when given, else beside `out`.
 * Refuses the two naming the same file, which would overwrite the totals with the lines.
 */
export function outputPaths(
  out: string | undefined,
  questions: string | undefined,
): { out?: string; questions?: string } {
  const q = questions ?? (out !== undefined ? questionsPathFor(out) : undefined);
  if (out !== undefined && q !== undefined && path.resolve(out) === path.resolve(q)) {
    throw new Error(`--out and --questions name the same file (${out}); give them different paths`);
  }
  return { ...(out !== undefined && { out }), ...(q !== undefined && { questions: q }) };
}

export const toJsonl = (records: readonly QuestionResult[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

export function writeQuestionsJsonl(file: string, records: readonly QuestionResult[]): void {
  fs.writeFileSync(file, toJsonl(records));
}

const isRankList = (x: unknown): x is (number | null)[] =>
  Array.isArray(x) && x.every((v) => v === null || (Number.isInteger(v) && (v as number) > 0));

/** Reads per-question lines; a malformed line throws, naming `where` and the line. */
export function parseQuestionResults(text: string, where = 'per-question file'): QuestionResult[] {
  const out: QuestionResult[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const at = `${where}, line ${i + 1}`;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${at}: not valid JSON`);
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o))
      throw new Error(`${at}: expected a JSON object`);
    for (const key of ['run', 'level', 'id', 'group', 'question'] as const) {
      if (typeof o[key] !== 'string') throw new Error(`${at}: ${key} must be a string`);
    }
    if (!isRankList(o['ranks'])) throw new Error(`${at}: ranks must be positive integers or null`);
    const metrics = o['metrics'];
    if (
      typeof metrics !== 'object' ||
      metrics === null ||
      Array.isArray(metrics) ||
      !Object.values(metrics).every((v) => v === null || Number.isFinite(v))
    ) {
      throw new Error(`${at}: metrics must map names to numbers or null`);
    }
    out.push(o as unknown as QuestionResult);
  }
  return out;
}
