/**
 * Calibrating the gate-miss rerank (CON-131; multilingual design of 8 November, §3 and §6 step 2).
 *
 * One recording run of the multilingual eval with `rerankWhen: 'gate-miss'` and both floors at 0
 * reranks every gate miss that has a dense match, and keeps every reranked memory. For each row it
 * records what recall returned without the escalation, the best dense score, and the rerank scores.
 * Any pair of floors can then be replayed from the records without another model call:
 *
 * - no gate miss: the row's result is unchanged, whatever the floors;
 * - a gate miss under the dense floor: nothing is returned, and no rerank is paid for;
 * - a gate miss over it: the reranked memories at or over the rerank floor are returned.
 */
import type { RecallResult, ResolvedConfig } from '@oortmem/core';
import { computeMetrics, type EvalRow } from './eval.js';
import {
  factOf,
  GATING,
  LANGUAGES,
  runMultilingual,
  type Condition,
  type Language,
  type MultilingualOptions,
  type RowSeen,
} from './multilingual.js';

export interface GateMissRecord {
  lang: Language;
  condition: Condition;
  /** An `unrelatedRows()` prompt: never in the eval's metrics, always an abstention. */
  unrelated: boolean;
  row: EvalRow;
  /** What recall returned without the escalation (for a gate miss: nothing). */
  ids: string[];
  /**
   * The unit a held-out split keeps together: `q:<n>` for the set's n-th question (the same
   * question in every language and condition, its translations included), `u:<lang>:<n>` for an
   * unrelated prompt. Absent in hand-built records: the question text stands in.
   */
  item?: string;
  /** Set when the relevance gate dropped every candidate. */
  gateMiss?: {
    /** The best dense score; absent when the dense search found nothing. */
    topDense?: number;
    /** The reranked memories, best first. Empty when the rerank failed or was not called. */
    scored: { id: string; score: number }[];
    /** The rerank call's time, when one was made. */
    rerankMs?: number;
    failed?: true;
  };
}

/** Recall settings for the recording run: every gate miss with a dense match is reranked. */
export const RECORDING: Partial<ResolvedConfig['recall']> = {
  rerankWhen: 'gate-miss',
  gateMissDenseFloor: 0,
  gateMissRerankFloor: 0,
};

/** Mixed rows score any language's copy of a fact, so their ids are compared as facts. */
function mapped(seen: RowSeen): { row: EvalRow; id: (id: string) => string } {
  if (seen.condition !== 'mixed') return { row: seen.row, id: (x) => x };
  return {
    row: {
      ...seen.row,
      expectedMemoryIds: seen.row.expectedMemoryIds.map(factOf),
      ...(seen.row.notExpectedMemoryIds !== undefined && {
        notExpectedMemoryIds: seen.row.notExpectedMemoryIds.map(factOf),
      }),
    },
    id: factOf,
  };
}

/** One record from a row recalled with `RECORDING`. */
export function recordOf(seen: RowSeen): GateMissRecord {
  const { row, id } = mapped(seen);
  const r: RecallResult = seen.result;
  const base = { lang: seen.lang, condition: seen.condition, unrelated: seen.extra, row };
  if (r.gateMiss === undefined) return { ...base, ids: r.memories.map((m) => id(m.id)) };
  const failed = (r.degraded ?? []).some((d) => d.startsWith('rerank-'));
  return {
    ...base,
    ids: [],
    gateMiss: {
      ...(r.gateMiss.topDense !== undefined && { topDense: r.gateMiss.topDense }),
      scored: r.gateMiss.reranked
        ? r.memories.flatMap((m) =>
            m.explanation.reranked === undefined
              ? []
              : [{ id: id(m.id), score: m.explanation.reranked }],
          )
        : [],
      ...(r.gateMiss.reranked && { rerankMs: r.timings['rerankMs'] ?? 0 }),
      ...(failed && { failed: true as const }),
    },
  };
}

/** Runs the eval once with `RECORDING` and returns a record per row (unrelated prompts too). */
export async function recordGateMiss(opts: MultilingualOptions): Promise<GateMissRecord[]> {
  const records: GateMissRecord[] = [];
  // Rows arrive in file order per language and condition; the files are aligned by line.
  const next = new Map<string, number>();
  await runMultilingual({
    ...opts,
    recall: { ...opts.recall, ...RECORDING },
    onRow: (seen) => {
      const at = `${seen.lang}\u0000${seen.condition}\u0000${seen.extra}`;
      const n = next.get(at) ?? 0;
      next.set(at, n + 1);
      records.push({ ...recordOf(seen), item: seen.extra ? `u:${seen.lang}:${n}` : `q:${n}` });
      opts.onRow?.(seen);
    },
  });
  return records;
}

export interface Floors {
  /** `gateMissDenseFloor`; `Infinity` replays recall without the escalation. */
  dense: number;
  /** `gateMissRerankFloor`. */
  rerank: number;
}

export const OFF: Floors = { dense: Number.POSITIVE_INFINITY, rerank: 1 };

/** What recall returns for `rec` at `floors`, and whether it paid for a rerank. */
export function replay(rec: GateMissRecord, floors: Floors): { ids: string[]; reranked: boolean } {
  const g = rec.gateMiss;
  if (g === undefined) return { ids: rec.ids, reranked: false };
  if (g.topDense === undefined || g.topDense < floors.dense) return { ids: [], reranked: false };
  return {
    ids: g.scored.filter((s) => s.score >= floors.rerank).map((s) => s.id),
    reranked: true,
  };
}

export interface CellMetrics {
  lang: Language;
  condition: Condition;
  /** Recall@10 over the answerable rows. */
  recall10: number | null;
  /** Share of the set's abstention rows that returned anything. */
  abstainFp: number | null;
  /** Share of the unrelated prompts that returned anything (a false injection). */
  unrelatedFp: number | null;
  /** Share of all rows (unrelated prompts too) that paid for a rerank. */
  rerankRate: number;
  rows: number;
}

/** One pair of floors for every record, or a pair per record (a held-out fold's). */
export type FloorsAt = Floors | ((r: GateMissRecord) => Floors);
const at = (floors: FloorsAt, r: GateMissRecord): Floors =>
  typeof floors === 'function' ? floors(r) : floors;

/** Metrics per (language, condition) at `floors`. */
export function measure(records: GateMissRecord[], floors: FloorsAt): CellMetrics[] {
  const out: CellMetrics[] = [];
  const cells = new Map<string, GateMissRecord[]>();
  for (const r of records) {
    const k = `${r.lang}\u0000${r.condition}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  for (const [k, recs] of cells) {
    const [lang, condition] = k.split('\u0000') as [Language, Condition];
    const own = recs.filter((r) => !r.unrelated);
    const extra = recs.filter((r) => r.unrelated);
    const played = recs.map((r) => replay(r, at(floors, r)));
    const ownPlayed = own.map((r) => replay(r, at(floors, r)));
    const report = computeMetrics(
      own.map((r) => r.row),
      ownPlayed.map((p) => ({ ids: p.ids, aboveThreshold: p.ids.length })),
      [10],
    );
    const g = report.groups['overall'];
    out.push({
      lang,
      condition,
      recall10: g?.recallAt[10] ?? null,
      abstainFp: g?.abstainFp ?? null,
      unrelatedFp:
        extra.length === 0
          ? null
          : extra.filter((r) => replay(r, at(floors, r)).ids.length > 0).length / extra.length,
      rerankRate: played.filter((p) => p.reranked).length / Math.max(1, recs.length),
      rows: recs.length,
    });
  }
  return out;
}

export interface Bars {
  /** Cross recall@10 at least this share of English mono recall@10 (design §6: 0.75). */
  crossShare: number;
  /** Abstention FP at most English's plus this (design §6: 0.1). */
  abstainSlack: number;
  /** The languages the bars apply to (design §6: the gating six). */
  languages: readonly Language[];
}

export const DESIGN_BARS: Bars = { crossShare: 0.75, abstainSlack: 0.1, languages: GATING };

export interface Verdict {
  floors: Floors;
  /**
   * Every bar met: the cross share, the abstention slack, and no unrelated prompt or abstention
   * question answered that is not answered without the escalation.
   */
  passes: boolean;
  failures: string[];
  /** Mean cross recall@10 over the bar's languages. */
  crossMacro: number;
  /** Unrelated prompts that inject anything, over every language and condition. */
  unrelatedInjected: number;
  /** Abstention rows that return anything, over every language and condition. */
  abstentionAnswered: number;
  /** Share of all rows that paid for a rerank. */
  rerankRate: number;
}

const cellOf = (ms: CellMetrics[], lang: Language, c: Condition) =>
  ms.find((m) => m.lang === lang && m.condition === c);

function counts(records: GateMissRecord[], floors: FloorsAt) {
  let unrelated = 0;
  let abstention = 0;
  let reranked = 0;
  for (const r of records) {
    const p = replay(r, at(floors, r));
    if (p.reranked) reranked++;
    if (p.ids.length === 0) continue;
    if (r.unrelated) unrelated++;
    else if (r.row.category === 'abstention') abstention++;
  }
  return { unrelated, abstention, rerankRate: reranked / Math.max(1, records.length) };
}

// The no-escalation baseline is the same for every pair of floors: computed once per record set.
const offCache = new WeakMap<GateMissRecord[], CellMetrics[]>();
const beforeCache = new WeakMap<GateMissRecord[], ReturnType<typeof counts>>();
function offOf(records: GateMissRecord[]): CellMetrics[] {
  let m = offCache.get(records);
  if (m === undefined) offCache.set(records, (m = measure(records, OFF)));
  return m;
}
function beforeOf(records: GateMissRecord[]): ReturnType<typeof counts> {
  let c = beforeCache.get(records);
  if (c === undefined) beforeCache.set(records, (c = counts(records, OFF)));
  return c;
}

/**
 * Checks `floors` against the bars. English mono and its abstention FP are read without the
 * escalation (the English path is meant not to change), and no prompt that injects nothing today
 * may inject something with it: neither the unrelated count nor the answered abstention questions
 * may rise.
 */
export function judge(records: GateMissRecord[], floors: Floors, bars = DESIGN_BARS): Verdict {
  return { floors, ...judgeAt(records, floors, bars) };
}

function judgeAt(records: GateMissRecord[], floors: FloorsAt, bars: Bars): Omit<Verdict, 'floors'> {
  const now0 = measure(records, floors);
  const off = offOf(records);
  const failures: string[] = [];
  const enMono = cellOf(off, 'en', 'mono');
  const enRecall = enMono?.recall10 ?? 1;
  let crossSum = 0;
  for (const lang of bars.languages) {
    const cross = cellOf(now0, lang, 'cross')?.recall10 ?? 0;
    crossSum += cross;
    if (cross < bars.crossShare * enRecall - 1e-9) {
      failures.push(`${lang} cross recall@10 ${cross.toFixed(3)} < ${bars.crossShare} × en mono`);
    }
    for (const c of ['mono', 'cross', 'mixed'] as const) {
      const en = cellOf(off, 'en', c === 'cross' ? 'mono' : c)?.abstainFp ?? 0;
      const fp = cellOf(now0, lang, c)?.abstainFp;
      if (fp !== null && fp !== undefined && fp > en + bars.abstainSlack + 1e-9) {
        failures.push(`${lang} ${c} abstention FP ${fp.toFixed(2)} > en ${en.toFixed(2)} + slack`);
      }
    }
  }
  const now = counts(records, floors);
  const before = beforeOf(records);
  if (now.unrelated > before.unrelated) {
    failures.push(`unrelated prompts injected ${before.unrelated} → ${now.unrelated}`);
  }
  if (now.abstention > before.abstention) {
    failures.push(`abstention questions answered ${before.abstention} → ${now.abstention}`);
  }
  return {
    passes: failures.length === 0,
    failures,
    crossMacro: crossSum / Math.max(1, bars.languages.length),
    unrelatedInjected: now.unrelated,
    abstentionAnswered: now.abstention,
    rerankRate: now.rerankRate,
  };
}

/** Floors from `from` to `to` in `step`, rounded to two places. */
export function grid(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Number(x.toFixed(2)));
  return out;
}

/**
 * The floors to ship: of the pairs that meet every bar, the best mean cross recall over the bar's
 * languages; on a tie the higher rerank floor (fewer false injections), then the higher dense floor
 * (fewer rerank calls). Undefined when no pair meets the bars.
 */
export function chooseFloors(
  records: GateMissRecord[],
  dense = grid(0.3, 0.7, 0.01),
  rerank = grid(0.3, 0.95, 0.01),
  bars = DESIGN_BARS,
): Verdict | undefined {
  let best: Verdict | undefined;
  for (const d of dense) {
    for (const r of rerank) {
      const v = judge(records, { dense: d, rerank: r }, bars);
      if (!v.passes) continue;
      if (
        best === undefined ||
        v.crossMacro > best.crossMacro + 1e-9 ||
        (Math.abs(v.crossMacro - best.crossMacro) <= 1e-9 &&
          (r > best.floors.rerank || (r === best.floors.rerank && d > best.floors.dense)))
      ) {
        best = v;
      }
    }
  }
  return best;
}

/**
 * `chooseFloors`, then the highest dense floor whose best pair keeps the cross recall within
 * `slack` of it: fewer rerank calls (each one is a vendor round trip on the prompt's critical
 * path) for a stated, small loss of recall. `best` is what `chooseFloors` alone picks.
 */
export function chooseCheaper(
  records: GateMissRecord[],
  slack = 0.02,
  dense = grid(0.3, 0.7, 0.01),
  rerank = grid(0.3, 0.95, 0.01),
  bars = DESIGN_BARS,
): { best: Verdict; chosen: Verdict } | undefined {
  const best = chooseFloors(records, dense, rerank, bars);
  if (best === undefined) return undefined;
  for (const d of [...dense].filter((x) => x > best.floors.dense).sort((a, b) => b - a)) {
    const v = chooseFloors(records, [d], rerank, bars);
    if (v !== undefined && v.crossMacro >= best.crossMacro - slack - 1e-9)
      return { best, chosen: v };
  }
  return { best, chosen: best };
}

/**
 * Per language, the floors that would suit it alone: the best cross recall@10 with no abstention
 * or unrelated prompt of that language answered more often than without the escalation. One
 * global pair ships (no language is detected); this shows what each language gives up for it.
 */
export function perLanguage(
  records: GateMissRecord[],
  dense = grid(0.3, 0.7, 0.01),
  rerank = grid(0.3, 0.95, 0.01),
): { lang: Language; floors: Floors | undefined; cross: number | null }[] {
  return LANGUAGES.filter((l) => l !== 'en').map((lang) => {
    const own = records.filter((r) => r.lang === lang);
    const negatives = (f: Floors) =>
      own.filter(
        (r) => (r.unrelated || r.row.category === 'abstention') && replay(r, f).ids.length > 0,
      ).length;
    const base = negatives(OFF);
    let best: { floors: Floors; cross: number } | undefined;
    for (const d of dense) {
      for (const r of rerank) {
        const f = { dense: d, rerank: r };
        if (negatives(f) > base) continue;
        const cross = cellOf(measure(own, f), lang, 'cross')?.recall10 ?? 0;
        if (
          best === undefined ||
          cross > best.cross + 1e-9 ||
          (Math.abs(cross - best.cross) <= 1e-9 &&
            (r < best.floors.rerank || d < best.floors.dense))
        ) {
          best = { floors: f, cross };
        }
      }
    }
    return { lang, floors: best?.floors, cross: best?.cross ?? null };
  });
}

/** The fold, of `k`, that `item` is held out in: a stable hash (FNV-1a), so runs agree. */
export function foldOf(item: string, k: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < item.length; i++) {
    h ^= item.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % k;
}

export interface HeldOut {
  k: number;
  /**
   * Per fold, indexed by `foldOf`: the floors chosen without it (`OFF` when none met the bars),
   * and its items and rows.
   */
  folds: { floors: Floors; items: number; rows: number }[];
  /** Every row judged at the floors its own fold was not used to choose. */
  verdict: Omit<Verdict, 'floors'>;
  cells: CellMetrics[];
}

/**
 * K-fold held-out evaluation: the items (questions, with their translations, and unrelated
 * prompts) are split into `k` folds; each fold's rows are replayed at the floors `choose` picks
 * from the other folds alone. Floors chosen and scored on the same rows flatter themselves; this
 * says what a new question can expect.
 */
export function heldOut(
  records: GateMissRecord[],
  k: number,
  choose: (train: GateMissRecord[]) => Floors | undefined = (train) =>
    chooseCheaper(train)?.chosen.floors,
  bars = DESIGN_BARS,
): HeldOut {
  const itemOf = (r: GateMissRecord) => r.item ?? r.row.question;
  const fold = (r: GateMissRecord) => foldOf(itemOf(r), k);
  const folds = Array.from({ length: k }, (_, f) => {
    const test = records.filter((r) => fold(r) === f);
    const floors = choose(records.filter((r) => fold(r) !== f)) ?? OFF;
    return { floors, items: new Set(test.map(itemOf)).size, rows: test.length };
  });
  const floorsOf = (r: GateMissRecord) => (folds[fold(r)] as { floors: Floors }).floors;
  return {
    k,
    folds,
    verdict: judgeAt(records, floorsOf, bars),
    cells: measure(records, floorsOf),
  };
}

/** The p50 and p95 of the rerank calls the floors would pay for. */
export function rerankLatency(
  records: GateMissRecord[],
  floors: Floors,
): { calls: number; p50: number; p95: number } {
  const ms = records
    .filter((r) => replay(r, floors).reranked && r.gateMiss?.rerankMs !== undefined)
    .map((r) => r.gateMiss?.rerankMs as number)
    .sort((a, b) => a - b);
  const q = (p: number) =>
    ms.length === 0 ? 0 : (ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] as number);
  return { calls: ms.length, p50: q(0.5), p95: q(0.95) };
}
