/**
 * Per-question results: one JSON line per question per run, written beside a run's totals, so two
 * runs can be compared question by question (`compare.ts`) instead of only by their means.
 *
 * Each line carries what the totals are computed from: the rank of every expected id (a turn, or
 * at session level an answer session) and of every outdated one, how many memories came back and
 * how many cleared the abstention threshold, and the link-admitted memories in the top 10. It
 * also carries the question's own share of each mean metric (`metrics`), computed by the same
 * `scoreRow` the totals use, so the mean of a metric over a run's lines is that run's total.
 */
import * as fs from 'node:fs';
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
  /** Left out of stale-above-current (see `EvalRow.staleOrderUnknown`). */
  staleOrderUnknown?: true;
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
    return {
      run: meta.run,
      level: meta.level,
      id: meta.ids?.[i] ?? String(i + 1),
      group: meta.groups?.[i] ?? r.category ?? 'uncategorized',
      question: r.question,
      ...(r.category === 'abstention' && { abstention: true as const }),
      ...(r.staleOrderUnknown === true && { staleOrderUnknown: true as const }),
      ranks: ranksOf(r.expectedMemoryIds, o.ids),
      ...(r.notExpectedMemoryIds !== undefined && {
        staleRanks: ranksOf(r.notExpectedMemoryIds, o.ids),
      }),
      returned: o.ids.length,
      aboveThreshold: o.aboveThreshold,
      linked: links.linked,
      linkedExpected: links.expected,
      metrics,
    };
  });
}

/** Where a run's per-question lines go: beside its totals, `report.json` -> `report.questions.jsonl`. */
export function questionsPathFor(totals: string): string {
  return `${totals.replace(/\.json$/i, '')}.questions.jsonl`;
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
      !Object.values(metrics).every((v) => v === null || typeof v === 'number')
    ) {
      throw new Error(`${at}: metrics must map names to numbers or null`);
    }
    out.push(o as unknown as QuestionResult);
  }
  return out;
}
