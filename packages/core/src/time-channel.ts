import type { Hit, MemoryStore, SearchOptions } from './adapters.js';
import { MAX_OCCURRENCE_DAYS, type TimePrecision, type TimeRange } from './event-time.js';
import type { Grant } from './grant.js';
import type { Memory } from './model.js';

/**
 * The time channel: when a query names a past time ("last weekend", "in March"), recall
 * ranks memories by when what they describe happened, as one more reciprocal-rank-fusion list
 * beside the lexical and dense ones. It never filters: a memory outside the range keeps whatever
 * the other lists give it. No model call: the range comes from `queryRange`, the memories' times
 * from `occurrencesOf` at write.
 */

const DAY_MS = 86_400_000;

/** At most this many memories per node come from the store's range read (`occurredIn`). */
export const TIME_K = 100;

/** After a rerank, a memory's place is decided by its score times up to 1 + TIME_BOOST. */
export const TIME_BOOST = 0.1;

/** A memory said after the range may still tell of it; its weight halves every this many days. */
const MENTION_HALF_LIFE_DAYS = 30;

/** How much an occurrence counts, by where it came from. */
const SOURCE_WEIGHT = { explicit: 1, relative: 0.8, mention: 0.4 } as const;

/** How far a range is widened on each side, by how precisely it was said. */
const SLACK_DAYS: Record<TimePrecision, number> = { day: 0, week: 1, month: 3, year: 7, span: 1 };

/** The query range in ms, widened by its slack. */
function windowOf(r: TimeRange): { from: number; to: number } {
  const slack = SLACK_DAYS[r.precision] * DAY_MS;
  return { from: Date.parse(r.from) - slack, to: Date.parse(r.to) + slack };
}

/**
 * What the store's range read asks for: the widened range. Memories said after it are not read
 * from the store; one the other searches found is still scored by when it was said.
 */
export function readRange(r: TimeRange): { from: string; to: string } {
  const w = windowOf(r);
  return { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() };
}

/** A memory's time score and the day it is placed on (for spreading the list over days). */
function scoreOf(m: Memory, r: TimeRange): { score: number; day: number } {
  const w = windowOf(r);
  const len = w.to - w.from;
  const mid = (w.from + w.to) / 2;
  let best = { score: 0, day: 0 };
  let mention: { from: number; to: number } | undefined;
  for (const o of m.occurred ?? []) {
    const from = Date.parse(o.from);
    const to = Date.parse(o.to);
    if (!(to > from)) continue;
    if (o.source === 'mention') {
      mention ??= { from, to };
      continue;
    }
    const inside = Math.min(to, w.to) - Math.max(from, w.from);
    if (inside <= 0) continue;
    // How much of the event lies in the range: a day in a month question counts fully, a year
    // that merely contains a weekend barely.
    const share = inside / (to - from);
    const closeness = Math.max(
      0,
      1 - Math.abs((from + to) / 2 - mid) / (len / 2 + (to - from) / 2),
    );
    const score = SOURCE_WEIGHT[o.source] * share * (0.75 + 0.25 * closeness);
    if (score > best.score) best = { score, day: Math.max(from, w.from) };
  }
  // When it was said: the mention occurrence, or (a memory written without one) its validFrom.
  if (mention === undefined) {
    const t = Date.parse(m.validFrom);
    if (Number.isFinite(t)) mention = { from: t, to: t + 1 };
  }
  if (mention !== undefined) {
    let score = 0;
    // A past event is told of on or after it happened: said before the range, it cannot be.
    if (mention.to <= w.from) score = 0;
    else if (mention.from < w.to) score = SOURCE_WEIGHT.mention;
    else {
      const after = (mention.from - w.to) / DAY_MS;
      score = SOURCE_WEIGHT.mention * 0.5 ** (after / MENTION_HALF_LIFE_DAYS);
    }
    if (score > best.score) best = { score, day: mention.from };
  }
  return best;
}

/**
 * How well `m` fits the range `r`, from 0 to 1: the best of its stated occurrences (explicit 1,
 * relative 0.8, times the share of the occurrence inside the range and its closeness to the
 * range's middle) and of when it was said (0.4 inside the range, halving every 30 days after it,
 * 0 before it). The range is widened first: a week by a day, a month by three, a year by seven.
 */
export function timeScore(m: Memory, r: TimeRange): number {
  return scoreOf(m, r).score;
}

/**
 * The channel's list for one node: every memory in `pool` with a time score above 0, best first
 * by time score times relevance (`relevance(m)`, 0 to 1: the dense similarity or the share of the
 * query's words), spread over days: the best memory of each day, days in order of their best,
 * then each day's second, and so on, so a month question does not fill the list from one day.
 * At most `k`.
 */
export function timeList(
  pool: Iterable<Memory>,
  r: TimeRange,
  relevance: (m: Memory) => number,
  k = TIME_K,
): Hit[] {
  const days = new Map<number, { m: Memory; score: number }[]>();
  for (const m of pool) {
    const s = scoreOf(m, r);
    if (s.score <= 0) continue;
    const rel = Math.max(0, Math.min(1, relevance(m)));
    const day = Math.floor(s.day / DAY_MS);
    const list = days.get(day) ?? [];
    list.push({ m, score: s.score * (0.05 + rel) });
    days.set(day, list);
  }
  const order = (x: { m: Memory; score: number }, y: { m: Memory; score: number }) =>
    y.score - x.score || (x.m.id < y.m.id ? -1 : x.m.id > y.m.id ? 1 : 0);
  const buckets = [...days.values()].map((l) => l.sort(order)).sort((x, y) => order(x[0]!, y[0]!));
  const out: Hit[] = [];
  for (let i = 0; out.length < k; i++) {
    let any = false;
    for (const b of buckets) {
      const e = b[i];
      if (e === undefined) continue;
      any = true;
      out.push({ id: e.m.id, score: e.score, tier: e.m.tier });
      if (out.length >= k) break;
    }
    if (!any) break;
  }
  return out;
}

/**
 * The store's range read for each node grant, when the store has one (`occurrences`): ids only,
 * read beside the lexical search. A store without it, or one that fails, adds nothing (`failed`
 * says which), and the channel ranks what the other searches found.
 */
export async function readOccurrences(
  store: MemoryStore,
  grants: readonly Grant[],
  r: TimeRange,
  opts: readonly SearchOptions[],
): Promise<{ hits: Hit[][]; failed: boolean }> {
  const read = store.occurredIn;
  if (store.occurrences !== true || read === undefined) {
    return { hits: grants.map(() => []), failed: false };
  }
  const range = readRange(r);
  if (Date.parse(range.to) - Date.parse(range.from) > 20 * MAX_OCCURRENCE_DAYS * DAY_MS) {
    // Decades: nothing to narrow.
    return { hits: grants.map(() => []), failed: false };
  }
  let failed = false;
  const hits = await Promise.all(
    grants.map((g) =>
      read.call(store, g, range, TIME_K, ...opts).catch((): Hit[] => {
        failed = true;
        return [];
      }),
    ),
  );
  return { hits, failed };
}
