import type * as chrono from 'chrono-node';
import { loadChrono, mayHaveDateCue } from './date-cue.js';

/**
 * Time handling in code, never in a model (CON-34): relative expressions are resolved with
 * chrono-node against the observation's own timestamp, at day precision, in the turn's UTC
 * offset when its timestamp carries one, else in UTC.
 */

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** chrono's reference: the instant, and the offset in minutes east of UTC. */
const ref = (at: Date, offset = 0) => ({ instant: at, timezone: offset });

/**
 * chrono's parse, loading chrono only for a text with a date cue (CON-82): a text without one
 * is a text chrono reads nothing the functions below act on.
 */
function parse(
  text: string,
  reference: chrono.ParsingReference,
  option: chrono.ParsingOption,
): chrono.ParsedResult[] {
  return mayHaveDateCue(text) ? loadChrono().parse(text, reference, option) : [];
}

/** Midnight of `d`'s day in the given offset, as an instant. */
const startOfDay = (d: Date, offset = 0): Date => {
  const local = new Date(d.getTime() + offset * MIN_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset * MIN_MS,
  );
};
const endOfDay = (d: Date): Date => new Date(startOfDay(d).getTime() + DAY_MS - 1);
/** `d`'s calendar day in the given offset. */
const ymd = (d: Date, offset = 0): string =>
  new Date(d.getTime() + offset * MIN_MS).toISOString().slice(0, 10);

/**
 * The UTC offset, in minutes, an ISO timestamp states (`+02:00` is 120, `Z` is 0), or
 * undefined when it states none.
 */
export function utcOffset(iso: string): number | undefined {
  const m = /(?:([+-])(\d{2}):?(\d{2})|Z)$/i.exec(iso.trim());
  if (m === null) return undefined;
  if (m[1] === undefined) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Words right before a date that make it the fact's end ("until Friday") or start ("since"). */
const UNTIL = /\b(until|till|through|thru|expires?|expiring|ends?(\s+on)?)\s*$/;
const FROM = /\b(since|from|starting|starts|as\s+of|effective|beginning|begins)\s*$/;
/** Start cues that announce something ahead: they take the coming reading. */
const AHEAD = /\b(starting|starts|beginning|begins)\s*$/;
const CUE_PREFIX =
  /^(.*?\b(?:until|till|through|thru|expires?|expiring|ends?|since|from|starting|starts|as\s+of|effective|beginning|begins))\b/;

/** The lead-in of a chrono result: the text just before it plus its own leading words. */
function leadIn(text: string, r: chrono.ParsedResult): string {
  const before = text.slice(Math.max(0, r.index - 32), r.index);
  // chrono sometimes swallows the cue ("lasts until 2026-11-20"): keep the result's own cue words.
  const own = CUE_PREFIX.exec(r.text.toLowerCase())?.[1] ?? '';
  return `${before} ${own}`.toLowerCase().trimEnd();
}

export interface FactInterval {
  /** ISO start of the fact's validity, when the text bounds it ("since", "starting"). */
  validFrom?: string;
  /** ISO end (exclusive) of the fact's validity, when the text bounds it ("until Friday"). */
  validTo?: string;
}

/**
 * The validity bounds a written memory states about itself, resolved against `at` (the turn's
 * time) in `offset` minutes east of UTC. "Until Friday" ends the fact after that Friday, and an
 * end in the past is kept (the fact is stored already ended). "Starting next week" looks ahead,
 * "since last Monday" looks back, and "as of", "effective" or "from" take the closer reading
 * within a week, else the past one. "From Monday to Friday" is a schedule, not a start. A plain
 * date ("on 2026-11-03 we chose pnpm") dates an event and sets no bound. An end at or before a
 * stated start contradicts it and is dropped.
 */
export function factInterval(text: string, at: Date, offset = 0): FactInterval {
  const out: FactInterval = {};
  const forward = parse(text, ref(at, offset), { forwardDate: true });
  const backward = parse(text, ref(at, offset), { forwardDate: false });
  const day = (d: Date) => startOfDay(d, offset);
  for (const r of forward) {
    const lead = leadIn(text, r);
    if (out.validTo === undefined && UNTIL.test(lead)) {
      const d = (r.end ?? r.start).date();
      out.validTo = new Date(day(d).getTime() + DAY_MS).toISOString();
    } else if (out.validFrom === undefined && FROM.test(lead)) {
      const weekdayOnly = (c: chrono.ParsedComponents) =>
        c.isCertain('weekday') && !c.isCertain('day');
      if (r.end !== null && r.end !== undefined && weekdayOnly(r.start) && weekdayOnly(r.end)) {
        continue; // "from Monday to Friday": a recurring schedule
      }
      const back = backward.find((x) => x.index === r.index) ?? r;
      let pick: chrono.ParsedResult;
      if (/\bsince\s*$/.test(lead)) pick = back;
      else if (AHEAD.test(lead) || /\bnext\b/i.test(r.text)) pick = r;
      else {
        // "As of Monday" on a Wednesday is two days ago: the closer reading within a week.
        const dist = (x: chrono.ParsedResult) => Math.abs(x.start.date().getTime() - at.getTime());
        const near = dist(r) <= dist(back) ? r : back;
        pick = dist(near) <= 7 * DAY_MS ? near : back;
      }
      out.validFrom = day(pick.start.date()).toISOString();
      if (
        r.end !== null &&
        r.end !== undefined &&
        out.validTo === undefined &&
        /\bfrom\s*$/.test(lead)
      ) {
        // "From 2026-11-01 to 2026-11-20": both bounds.
        out.validTo = new Date(day(r.end.date()).getTime() + DAY_MS).toISOString();
      }
    }
  }
  if (
    out.validFrom !== undefined &&
    out.validTo !== undefined &&
    Date.parse(out.validTo) <= Date.parse(out.validFrom)
  ) {
    delete out.validTo;
  }
  return out;
}

const RELATIVE =
  /\b(yesterday|today|tonight|tomorrow|ago|last\s+\w+|next\s+\w+|this\s+(morning|afternoon|evening|week|month))\b/gi;
const ISO_DAY = /\b(\d{4}-\d{2}-\d{2})\b/g;

/** Furthest a written day may sit from the turn's relative day and still count as a slip. */
const SLIP_DAYS = 2;

export interface WriterDateCheck {
  text: string;
  /** The written day was replaced by the resolved one. */
  fixed?: { from: string; to: string };
  /** The written day differs from the resolved one but was kept (a stated or distant date). */
  mismatch?: { written: string; resolved: string };
}

/**
 * Checks the writer's absolute date against the turn. When the turn names exactly one relative
 * day ("yesterday") and the written fact carries exactly one ISO day, that day should be
 * chrono's reading of the relative one. It is replaced only when it looks like an arithmetic
 * slip: within two days of the reading, and not a date the turn itself states. Otherwise the
 * difference is reported in `mismatch` and the text is kept ("Today we agreed the cutover is
 * 2026-12-01" is about the cutover, not today).
 */
export function checkWriterDate(
  turnText: string,
  factText: string,
  at: Date,
  offset = 0,
): WriterDateCheck {
  const relatives = turnText.match(RELATIVE) ?? [];
  const days = [...new Set(factText.match(ISO_DAY) ?? [])];
  if (relatives.length !== 1 || days.length !== 1) return { text: factText };
  const isRelative = new RegExp(RELATIVE.source, 'i');
  const parsed = parse(turnText, ref(at, offset), { forwardDate: false }).filter((r) =>
    isRelative.test(r.text),
  );
  if (parsed.length !== 1) return { text: factText };
  const resolved = ymd(parsed[0]!.start.date(), offset);
  const written = days[0]!;
  if (resolved === written) return { text: factText };
  const apart = Math.abs(Date.parse(resolved) - Date.parse(written)) / DAY_MS;
  if (apart > SLIP_DAYS || turnText.includes(written)) {
    return { text: factText, mismatch: { written, resolved } };
  }
  return { text: factText.split(written).join(resolved), fixed: { from: written, to: resolved } };
}

export type RecallMode = 'current' | 'as-of' | 'history' | 'known-at';

export interface TemporalIntent {
  mode: RecallMode;
  /** For `as-of`: the end of the day the query names. */
  asOf?: string;
  /** For `known-at`: the end of the day the query names. */
  knownAt?: string;
  /** The query without its temporal words, to search with; absent when nothing was removed. */
  text?: string;
}

const KNOWN =
  /\b(what\s+did\s+(we|i|you)\s+(think|believe|know|assume)|believed|we\s+thought|we\s+knew|known\s+at)\b/i;
/**
 * History questions, anchored and question-shaped: "how has X changed", "history of X", "what
 * did X used to be", "what was X before", "which … previously". A prompt that only contains
 * such words ("fix the test, the config changed") is an instruction about now.
 */
const HISTORY_QUESTIONS = [
  /^\s*how\s+(has|have|did)\b[^.;!,]*\bchange[sd]?\b[^.;!,]*\??\s*$/i,
  /^\s*((what|what's)\s+(is|was)?\s*the\s+)?history\s+of\b[^.;!,]*\??\s*$/i,
  /^\s*(what|which)\b[^.;!,]*\b(used?\s+to\s+be|before|previously|in\s+the\s+past|over\s+time)\s*\??\s*$/i,
];
const isHistoryQuestion = (q: string): boolean => HISTORY_QUESTIONS.some((re) => re.test(q));
/** A preposition left dangling once the date it introduced is removed. */
const DANGLING = /\b(on|in|at|as\s+of|by|during|since)\s*$/i;

/** `query` with `part` removed (and a preposition it leaves dangling), whitespace tidied. */
function without(query: string, part: string, dangling = false): string {
  const i = query.indexOf(part);
  if (i < 0) return query;
  let head = query.slice(0, i);
  if (dangling) head = head.replace(DANGLING, '');
  return `${head} ${query.slice(i + part.length)}`.replace(/\s+/g, ' ').trim();
}

/**
 * A cheap read of a query's temporal intent, in code: "what did we believe … on <day>" is
 * known-at that day; an anchored history question ("how has X changed") asks for the chain; a
 * past day with a cue ("on 2 April 2026", "in March", "yesterday") is as-of that day; anything
 * else, including "now", coming weekdays and other future days, is the current state. A month
 * and day with no year that reads more than 30 days ahead means the last one ("in March" asked
 * in November is this year's March).
 */
export function temporalIntent(query: string, now: Date): TemporalIntent {
  const r = parse(query, ref(now), { forwardDate: false })[0];
  let day: Date | undefined;
  if (r !== undefined) {
    let d = r.start.date();
    const c = r.start;
    const relative =
      /\b(next|this|coming|tomorrow|tonight|in\s+\d+)\b/i.test(r.text) ||
      (c.isCertain('weekday') && !c.isCertain('day'));
    const explicitMonth = c.isCertain('month') && !c.isCertain('year') && !relative;
    if (explicitMonth && d.getTime() > now.getTime() + 30 * DAY_MS) {
      d = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate(), 12));
    }
    // "This week" or "today" asks about the present, even when chrono dates it a few days back.
    const present = /\b(this|today|tonight|now|currently)\b/i.test(r.text);
    // A bare date is a keyword ("2026-05-16 pooling" looks up the event that day mentions); a
    // question about state then needs a cue: "on 2 April", "in March", "as of", "yesterday".
    const cued =
      DANGLING.test(query.slice(0, r.index)) ||
      /^(on|in|at|as\s+of|during|by)\b/i.test(r.text) ||
      /\b(yesterday|ago|last|earlier|previous)\b/i.test(r.text);
    if (!present && cued && d.getTime() < startOfDay(now).getTime()) day = d;
  }
  let rest = query;
  if (day !== undefined && r !== undefined) rest = without(rest, r.text, true);
  const known = KNOWN.exec(rest);
  if (known !== null && day !== undefined) {
    return withText(
      { mode: 'known-at', knownAt: endOfDay(day).toISOString() },
      without(rest, known[0]),
      query,
    );
  }
  // History keeps every word: "changed" or "before" may be what the memory itself says.
  if (isHistoryQuestion(query)) return { mode: 'history' };
  if (day !== undefined) {
    return withText({ mode: 'as-of', asOf: endOfDay(day).toISOString() }, rest, query);
  }
  return { mode: 'current' };
}

function withText(i: TemporalIntent, rest: string, query: string): TemporalIntent {
  return rest !== '' && rest !== query ? { ...i, text: rest } : i;
}
