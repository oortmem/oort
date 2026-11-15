import type * as chrono from 'chrono-node';
import { loadChrono, mayHaveDateCue } from './date-cue.js';

/**
 * Event time, in code: when the things a text talks about happened, as intervals, resolved with
 * chrono-node (and a few patterns chrono does not read) against a reference instant. A memory's
 * reference is the turn it was written in, so "last Friday" in a turn from May 2023 is a Friday in
 * May 2023; a query's reference is the recall's `now`. Points are widened to what they name: "in
 * March" is the whole month, "last weekend" its Saturday and Sunday, "two weeks ago" that week.
 */

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** How wide an interval is by what was said: a day, a week, a month, a year, or a stated span. */
export type TimePrecision = 'day' | 'week' | 'month' | 'year' | 'span';

/**
 * Where an occurrence came from: a date the text states (`explicit`: "on 2023-05-20", "in March"),
 * one it implies against the turn's time (`relative`: "last Friday", "two weeks ago"), or the day
 * the memory was written (`mention`). A past event is mentioned on or after it happened.
 */
export type OccurrenceSource = 'explicit' | 'relative' | 'mention';

/** An interval in time: `from` inclusive, `to` exclusive, both ISO instants. */
export interface TimeRange {
  from: string;
  to: string;
  precision: TimePrecision;
}

/** When something a memory describes happened, or (`mention`) when it was said. */
export interface Occurrence extends TimeRange {
  source: OccurrenceSource;
}

/** The longest interval an occurrence may span: a year, plus a day for a leap year. */
export const MAX_OCCURRENCE_DAYS = 367;

/** At most this many stated occurrences are kept per memory, in the order the text gives them. */
export const MAX_STATED_OCCURRENCES = 8;

/** More weekday-only dates than this in one text is a schedule ("Monday: rest day"), not events. */
const SCHEDULE_WEEKDAYS = 3;

// ---------------------------------------------------------------------------------------------
// chrono, cached

const cache: { key: string; out: chrono.ParsedResult[] }[] = [];
const CACHE_SIZE = 4;

/**
 * chrono's parse, loading chrono only for a text with a date cue (CON-82). The last few results
 * are kept, so the write path's two readers of one turn (validity bounds and event time) parse it
 * once.
 */
export function chronoParse(
  text: string,
  reference: chrono.ParsingReference,
  option: chrono.ParsingOption,
): chrono.ParsedResult[] {
  if (!mayHaveDateCue(text)) return [];
  const instant = reference.instant instanceof Date ? reference.instant.getTime() : '';
  const key = `${instant}|${String(reference.timezone)}|${option.forwardDate === true}|${text}`;
  const hit = cache.find((c) => c.key === key);
  if (hit !== undefined) return hit.out;
  const out = loadChrono().parse(text, reference, option);
  cache.unshift({ key, out });
  cache.length = Math.min(cache.length, CACHE_SIZE);
  return out;
}

// ---------------------------------------------------------------------------------------------
// calendar arithmetic, in a UTC offset

/** The wall-clock fields of `t` in `offset` minutes east of UTC. */
function local(t: number, offset: number) {
  const d = new Date(t + offset * MIN_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
}
/** The instant of local midnight y-m-d in `offset` (months and days may overflow). */
const at = (y: number, m: number, d: number, offset: number): number =>
  Date.UTC(y, m, d) - offset * MIN_MS;
const dayStart = (t: number, offset: number): number => {
  const l = local(t, offset);
  return at(l.y, l.m, l.d, offset);
};
/** Monday 00:00 of the ISO week holding `t`. */
const weekStart = (t: number, offset: number): number => {
  const l = local(t, offset);
  return at(l.y, l.m, l.d - ((l.wd + 6) % 7), offset);
};
const monthStart = (t: number, offset: number): number => {
  const l = local(t, offset);
  return at(l.y, l.m, 1, offset);
};
const yearStart = (t: number, offset: number): number => at(local(t, offset).y, 0, 1, offset);
const addMonths = (t: number, n: number, offset: number): number => {
  const l = local(t, offset);
  return at(l.y, l.m + n, l.d, offset) + (t - dayStart(t, offset));
};

type Unit = 'day' | 'week' | 'month' | 'year';

/** The calendar day, week, month or year holding `t`, as [from, to). */
function period(t: number, unit: Unit, offset: number): [number, number] {
  switch (unit) {
    case 'day': {
      const s = dayStart(t, offset);
      return [s, dayStart(s + DAY_MS + 3_600_000, offset)];
    }
    case 'week': {
      const s = weekStart(t, offset);
      return [s, weekStart(s + 7 * DAY_MS + 3_600_000, offset)];
    }
    case 'month': {
      const s = monthStart(t, offset);
      return [s, monthStart(addMonths(s, 1, offset) + 3_600_000, offset)];
    }
    case 'year': {
      const s = yearStart(t, offset);
      return [s, at(local(s, offset).y + 1, 0, 1, offset)];
    }
  }
}

/** `t` moved back (negative `n`: forward) by `n` units. */
function minus(t: number, n: number, unit: Unit, offset: number): number {
  switch (unit) {
    case 'day':
      return t - n * DAY_MS;
    case 'week':
      return t - n * 7 * DAY_MS;
    case 'month':
      return addMonths(t, -n, offset);
    case 'year':
      return addMonths(t, -12 * n, offset);
  }
}

// ---------------------------------------------------------------------------------------------
// patterns chrono does not read the way we need

const NUMBER: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  'a couple': 2,
  'a couple of': 2,
  'couple of': 2,
  few: 3,
  'a few': 3,
  several: 4,
};
const COUNT_WORDS =
  '\\d{1,2}|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|a\\s+few|few|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const FUZZY = /couple|few|several/;
const countOf = (s: string): number =>
  /^\d+$/.test(s) ? Number(s) : (NUMBER[s.replace(/\s+/g, ' ')] ?? 1);
const unitOf = (s: string): Unit => s.replace(/s$/, '') as Unit;

/** A time a pattern or chrono found in a text, as an interval in ms. */
interface Found {
  from: number;
  to: number;
  precision: TimePrecision;
  source: Exclude<OccurrenceSource, 'mention'>;
  index: number;
  length: number;
  text: string;
  /** Names the present ("this week", "today"): never a query range. */
  present?: true;
  /** Only a weekday was given ("on Friday"). */
  weekdayOnly?: true;
}

const SEASONS: Record<string, [number, number]> = {
  spring: [2, 5],
  summer: [5, 8],
  fall: [8, 11],
  autumn: [8, 11],
  winter: [11, 14],
};

/** The patterns, each turning a match into an interval against `ref`. */
const PATTERNS: {
  re: RegExp;
  read: (
    m: RegExpExecArray,
    ref: number,
    offset: number,
  ) => Omit<Found, 'index' | 'length' | 'text'> | undefined;
}[] = [
  {
    // "last weekend", "this past weekend", "over the weekend", "next weekend"; never a bare
    // "weekend" ("a theme park weekend" names no particular one).
    re: /\b(last|this\s+past|past|previous|this|next|coming|the)\s+weekend\b/gi,
    read: (m, ref, offset) => {
      const which = (m[1] ?? 'the').toLowerCase().replace(/\s+/g, ' ');
      const thisWeek = weekStart(ref, offset);
      const wd = local(ref, offset).wd;
      let monday: number;
      if (which === 'next' || which === 'coming') monday = thisWeek + 7 * DAY_MS;
      else if (which === 'this') monday = thisWeek;
      else if (which === 'the') monday = wd === 6 || wd === 0 ? thisWeek : thisWeek - 7 * DAY_MS;
      else monday = thisWeek - 7 * DAY_MS;
      const sat = dayStart(monday + 5 * DAY_MS + 3_600_000, offset);
      return {
        from: sat,
        to: dayStart(sat + 2 * DAY_MS + 3_600_000, offset),
        precision: 'span',
        source: 'relative',
        ...(which === 'this' && { present: true as const }),
      };
    },
  },
  {
    // "earlier this month", "earlier this week", "earlier this year": from its start to now.
    re: /\bearlier\s+this\s+(week|month|year)\b/gi,
    read: (m, ref, offset) => ({
      from: period(ref, unitOf(m[1]!.toLowerCase()), offset)[0],
      to: period(ref, 'day', offset)[1],
      precision: 'span',
      source: 'relative',
    }),
  },
  {
    // "the past two months", "the last 3 weeks", "the past few days": a span that ends now.
    re: new RegExp(
      `\\b(?:the\\s+)?(?:past|last|previous)\\s+(${COUNT_WORDS})\\s+(days|weeks|months|years)\\b`,
      'gi',
    ),
    read: (m, ref, offset) => ({
      from: dayStart(
        minus(ref, countOf(m[1]!.toLowerCase()), unitOf(m[2]!.toLowerCase()), offset),
        offset,
      ),
      to: period(ref, 'day', offset)[1],
      precision: 'span',
      source: 'relative',
    }),
  },
  {
    // "the past month", "in the past week": one unit back from now ("last month" is the calendar
    // month, from chrono).
    re: /\b(?:the\s+)?past\s+(day|week|month|year)\b/gi,
    read: (m, ref, offset) => ({
      from: dayStart(minus(ref, 1, unitOf(m[1]!.toLowerCase()), offset), offset),
      to: period(ref, 'day', offset)[1],
      precision: 'span',
      source: 'relative',
    }),
  },
  {
    // "last week", "this week", "next week": the calendar week.
    re: /\b(last|previous|this|next|coming)\s+week\b(?!s|end)/gi,
    read: (m, ref, offset) => {
      const which = m[1]!.toLowerCase();
      const shift = which === 'this' ? 0 : which === 'next' || which === 'coming' ? -1 : 1;
      const [from, to] = period(minus(ref, shift, 'week', offset), 'week', offset);
      return {
        from,
        to,
        precision: 'week',
        source: 'relative',
        ...(which === 'this' && { present: true as const }),
      };
    },
  },
  {
    // "two weeks ago", "a couple of weeks ago": that calendar week (or weeks, when vague).
    re: new RegExp(`\\b(${COUNT_WORDS})\\s+weeks?\\s+ago\\b`, 'gi'),
    read: (m, ref, offset) => {
      const raw = m[1]!.toLowerCase();
      const n = countOf(raw);
      if (!FUZZY.test(raw)) {
        const [from, to] = period(minus(ref, n, 'week', offset), 'week', offset);
        return { from, to, precision: 'week', source: 'relative' };
      }
      return {
        from: period(minus(ref, n + 1, 'week', offset), 'week', offset)[0],
        to: period(minus(ref, Math.max(0, n - 1), 'week', offset), 'week', offset)[1],
        precision: 'span',
        source: 'relative',
      };
    },
  },
  {
    // "a few days ago": a few days either side; "3 days ago" is chrono's.
    re: /\b(a\s+couple(?:\s+of)?|couple(?:\s+of)?|a\s+few|few|several)\s+(days|months|years)\s+ago\b/gi,
    read: (m, ref, offset) => {
      const n = countOf(m[1]!.toLowerCase());
      const unit = unitOf(m[2]!.toLowerCase());
      return {
        from: period(minus(ref, n + 1, unit, offset), unit, offset)[0],
        to: period(minus(ref, Math.max(0, n - 1), unit, offset), unit, offset)[1],
        precision: 'span',
        source: 'relative',
      };
    },
  },
  {
    // "last summer", "this past winter", "next spring" (northern hemisphere seasons).
    re: /\b(last|this\s+past|past|previous|this|next)\s+(spring|summer|fall|autumn|winter)\b/gi,
    read: (m, ref, offset) => {
      const which = m[1]!.toLowerCase().replace(/\s+/g, ' ');
      const [s, e] = SEASONS[m[2]!.toLowerCase()]!;
      const y = local(ref, offset).y;
      const span = (yy: number): [number, number] => [at(yy, s, 1, offset), at(yy, e, 1, offset)];
      let pick: [number, number];
      if (which === 'next') {
        pick = span(y);
        if (pick[0] <= ref) pick = span(y + 1);
      } else if (which === 'this') {
        pick = span(y);
        if (pick[0] > ref) pick = span(y - 1);
      } else {
        // The latest one that has ended.
        pick = span(y);
        if (pick[1] > ref) pick = span(y - 1);
        if (pick[1] > ref) pick = span(y - 2);
      }
      return { from: pick[0], to: pick[1], precision: 'span', source: 'relative' };
    },
  },
  {
    // "the summer of 2023", "in summer 2023".
    re: /\b(spring|summer|fall|autumn|winter)\s+(?:of\s+)?((?:19|20)\d{2})\b/gi,
    read: (m, _ref, offset) => {
      const [s, e] = SEASONS[m[1]!.toLowerCase()]!;
      const y = Number(m[2]);
      return {
        from: at(y, s, 1, offset),
        to: at(y, e, 1, offset),
        precision: 'span',
        source: 'explicit',
      };
    },
  },
  {
    // "in 2023", "back in 2019", "since 2020": a year chrono leaves alone.
    re: /\b(?:in|during|throughout|since|from|of|back\s+in|around)\s+((?:19|20)\d{2})\b(?![-/.:]\d)/gi,
    read: (m, _ref, offset) => {
      const y = Number(m[1]);
      return {
        from: at(y, 0, 1, offset),
        to: at(y + 1, 0, 1, offset),
        precision: 'year',
        source: 'explicit',
      };
    },
  },
];

/** Words just before a date that say it lies ahead ("I'm going to Japan in March"). */
const AHEAD =
  /\b(will|going\s+to|gonna|plan(?:s|ning)?\s+to|planning|scheduled|upcoming|later|next|coming|hope\s+to|want\s+to|about\s+to)\b[^.!?\n]{0,40}$/i;
/** Below a day: a time of day or a span of hours ("for 10 minutes", "2 hours ago"). */
const SUB_DAY =
  /\b(hours?|hrs?|minutes?|mins?|seconds?|secs?|a\.?m\.?|p\.?m\.?|noon|midnight|o['’]?\s*clock)\b|\d:\d/i;
/** A date beside a time of day: a month or weekday name, a numeric date, or a relative day. */
const DATE_WORDS =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\d{1,4}[-/.]\d{1,2}|\b(yesterday|tomorrow)\b/i;
/** The present itself: never an event range of its own. */
const NOW_WORDS =
  /^(?:(?:on|at|by|in|from)\s+)?(?:today|tonight|now|this\s+(?:morning|afternoon|evening|night))$/i;
/** Words that make a date relative to the reference rather than stated. */
const RELATIVE_WORDS =
  /\b(yesterday|tomorrow|ago|last|next|this|past|previous|coming|later|earlier)\b/i;

/** A chrono result as an interval: its own end, or its granularity widened around its start. */
function fromChrono(
  r: chrono.ParsedResult,
  text: string,
  ref: number,
  offset: number,
  forQuery: boolean,
): Found | undefined {
  const c = r.start;
  const t = r.text.trim();
  if (NOW_WORDS.test(t)) return undefined;
  // A bare "weekend" ("a theme park weekend") names no particular one; the patterns read the rest.
  if (/^(?:(?:on|at|in|over)\s+)?weekends?$/i.test(t)) return undefined;
  // "The day before I had an appointment" is relative to that event, not to today.
  if (/^(?:on\s+)?the\s+(?:day|night|week|month)\s+(?:before|after)$/i.test(t)) return undefined;
  const known = (k: chrono.Component) => c.isCertain(k);
  const dated = known('day') || known('weekday') || known('month') || known('year');
  // "yesterday" and "3 days ago" carry their day as known; a bare time ("at 5") carries none.
  // chrono marks the day known for "for 10 minutes" too: a time of day counts only beside a date.
  if (!dated || (SUB_DAY.test(t) && !DATE_WORDS.test(t))) return undefined;
  const relative = RELATIVE_WORDS.test(t);
  const present = /\b(this|today|tonight|now|currently)\b/i.test(t);
  let start = c.date().getTime();
  // A month (and day) without a year: chrono takes the closest. A query asks about the past, so
  // more than 30 days ahead is last year's; a memory keeps a coming one only when it says so.
  if ((known('month') || known('day')) && !known('year') && !relative) {
    const ahead = start > ref + 30 * DAY_MS;
    const said = AHEAD.test(text.slice(Math.max(0, r.index - 48), r.index));
    if (ahead && (forQuery || !said)) start = addMonths(start, -12, offset);
    else if (!forQuery && said && start < ref) start = addMonths(start, 12, offset);
  }
  let unit: Unit = 'day';
  if (known('day') || known('weekday')) unit = 'day';
  else if (known('month')) unit = 'month';
  else if (known('year')) unit = 'year';
  if (/\bweeks?\b/i.test(t)) unit = 'week';
  let [from, to] = period(start, unit, offset);
  let precision: TimePrecision = unit;
  if (r.end !== null && r.end !== undefined) {
    const e = r.end;
    const end = e.date().getTime();
    if (end > start) {
      // Through the end's own unit: "July to October" runs to the end of October.
      const endUnit: Unit =
        e.isCertain('day') || e.isCertain('weekday')
          ? 'day'
          : e.isCertain('month')
            ? 'month'
            : e.isCertain('year')
              ? 'year'
              : 'day';
      from = unit === 'day' ? dayStart(start, offset) : from;
      to = period(end, endUnit, offset)[1];
      precision = 'span';
    }
  }
  return {
    from,
    to,
    precision,
    source: relative || (!known('month') && !known('year')) ? 'relative' : 'explicit',
    index: r.index,
    length: r.text.length,
    text: r.text,
    ...(present && { present: true as const }),
    ...(known('weekday') && !known('day') && { weekdayOnly: true as const }),
  };
}

const overlaps = (found: readonly Found[], i: number, n: number): boolean =>
  found.some((f) => i < f.index + f.length && f.index < i + n);

/** A weekday alone counts in a memory only as "on Friday", "last Friday" or "this past Friday". */
const WEEKDAY_LEAD = /\b(on|last|past|previous)\s*$/i;
const WEEKDAY_OWN = /^(on|last|past|previous|this\s+past)\b/i;

/**
 * Every time `text` names, against `ref` (ms) in `offset` minutes east of UTC, in text order. The
 * patterns above win over chrono where both read the same words. "Between March 3 and March 10"
 * and "from May 1 to May 5" are one span.
 */
function findTimes(text: string, ref: number, offset: number, forQuery: boolean): Found[] {
  const out: Found[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m !== null; m = p.re.exec(text)) {
      const f = p.read(m, ref, offset);
      // An earlier pattern already read these words ("summer of 2023" before "of 2023").
      if (f === undefined || overlaps(out, m.index, m[0].length)) continue;
      out.push({ ...f, index: m.index, length: m[0].length, text: m[0] });
    }
  }
  const chronoFound: Found[] = [];
  for (const r of chronoParse(
    text,
    { instant: new Date(ref), timezone: offset },
    { forwardDate: false },
  )) {
    if (overlaps(out, r.index, r.text.length)) continue;
    const f = fromChrono(r, text, ref, offset, forQuery);
    if (f === undefined) continue;
    const before = text.slice(Math.max(0, r.index - 12), r.index);
    const lone = !WEEKDAY_LEAD.test(before) && !WEEKDAY_OWN.test(r.text);
    if (!forQuery && f.weekdayOnly === true && lone) continue;
    chronoFound.push(f);
  }
  // "between X and Y", "from X to Y": two of chrono's dates joined into one span.
  const joined: Found[] = [];
  for (let i = 0; i < chronoFound.length; i++) {
    const a = chronoFound[i]!;
    const b = chronoFound[i + 1];
    if (b !== undefined) {
      const gap = text.slice(a.index + a.length, b.index);
      const lead = text.slice(Math.max(0, a.index - 12), a.index);
      if (
        /^\s*(and|to|until|till|through|-|–)\s*$/i.test(gap) &&
        /\b(between|from)\s*$/i.test(lead) &&
        b.to > a.from
      ) {
        joined.push({
          ...a,
          to: b.to,
          precision: 'span',
          length: b.index + b.length - a.index,
          text: text.slice(a.index, b.index + b.length),
        });
        i++;
        continue;
      }
    }
    joined.push(a);
  }
  return [...out, ...joined].sort((x, y) => x.index - y.index);
}

const iso = (t: number) => new Date(t).toISOString();

/**
 * When the events `text` describes happened, resolved against `at` (the turn's time) in `offset`
 * minutes east of UTC, then the day it was said (`mention`), last. Stated dates come first, in
 * text order, at most `MAX_STATED_OCCURRENCES`, none longer than a year: "on 2023-05-20" is that
 * day, "in March" the month (a coming one only when the text says so), "last weekend" its Saturday
 * and Sunday, "two weeks ago" that week, "in 2022" the year. A time of day, "today" and the like
 * add nothing to the mention. More than three dates that are only weekdays read as a schedule
 * ("Monday: rest day") and are dropped.
 */
export function occurrencesOf(text: string, written: Date, offset = 0): Occurrence[] {
  const ref = written.getTime();
  const found = findTimes(text, ref, offset, false).filter(
    (f) => f.to > f.from && f.to - f.from <= MAX_OCCURRENCE_DAYS * DAY_MS,
  );
  const weekdays = found.filter((f) => f.weekdayOnly === true).length;
  const stated: Occurrence[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (f.weekdayOnly === true && weekdays > SCHEDULE_WEEKDAYS) continue;
    const o: Occurrence = {
      from: iso(f.from),
      to: iso(f.to),
      precision: f.precision,
      source: f.source,
    };
    const key = `${o.from}|${o.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stated.push(o);
    if (stated.length >= MAX_STATED_OCCURRENCES) break;
  }
  const [from, to] = period(ref, 'day', offset);
  return [...stated, { from: iso(from), to: iso(to), precision: 'day', source: 'mention' }];
}

/** A query's time range and where its words are, as `queryRange` reads them. */
export interface QueryTime extends TimeRange {
  /** The words that named it, as they appear in the query. */
  text: string;
  index: number;
}

/** A preposition right before a date that makes it a question about that time. */
const CUE_BEFORE = /\b(on|in|at|as\s+of|by|during|since|over|from|between|around|of)\s*$/i;
const CUE_WORDS = /\b(yesterday|ago|last|earlier|previous|past|weekend|between|since)\b/i;

/** A question about the past: "this year" in it means from the year's start to today. */
const PAST_QUESTION = /\b(did|was|were|had|have\s+(?:i|we|you)|has\s+\w+)\b/i;
const THIS_PERIOD = /\bthis\s+(week|month|year)\b/i;

/**
 * The past time a query asks about, against `now` (UTC), or undefined. The first date with a cue
 * counts: "on 2 April 2026", "in March", "last weekend", "the past two months", "two weeks ago",
 * "in 2023". A bare date is a keyword ("2026-05-16 pooling" looks up what mentions it). The
 * present ("this week", "today") and anything from today on ("next Friday") are not a range,
 * except "this week", "this month" or "this year" in a question about the past ("how many
 * weddings did I attend this year"), which runs from its start to today, as "since March" does.
 */
export function queryRange(query: string, now: Date): QueryTime | undefined {
  const ref = now.getTime();
  const today = period(ref, 'day', 0);
  for (const f of findTimes(query, ref, 0, true)) {
    const sofar = f.present === true && THIS_PERIOD.test(f.text) && PAST_QUESTION.test(query);
    const cued =
      sofar ||
      CUE_BEFORE.test(query.slice(0, f.index)) ||
      /^(on|in|at|as\s+of|during|by)\b/i.test(f.text) ||
      CUE_WORDS.test(f.text);
    if (!cued || (f.present === true && !sofar)) continue;
    if (f.from >= today[0]) continue;
    let to = f.to;
    if (sofar || /\bsince\s*$/i.test(query.slice(0, f.index))) to = today[1];
    return {
      from: iso(f.from),
      to: iso(Math.min(to, today[1])),
      precision: to !== f.to ? 'span' : f.precision,
      text: f.text,
      index: f.index,
    };
  }
  return undefined;
}

/** A range as a reader sees it: `2023-05-20`, `2023-05`, `2023`, or `2023-05-20 to 2023-05-21`. */
export function formatRange(r: TimeRange): string {
  const from = r.from.slice(0, 10);
  const last = new Date(Date.parse(r.to) - 1).toISOString().slice(0, 10);
  switch (r.precision) {
    case 'day':
      return from;
    case 'month':
      if (from.endsWith('-01') && last.slice(0, 7) === from.slice(0, 7)) return from.slice(0, 7);
      break;
    case 'year':
      if (from.endsWith('-01-01') && last.slice(0, 4) === from.slice(0, 4)) return from.slice(0, 4);
      break;
  }
  return from === last ? from : `${from} to ${last}`;
}

const PRECISIONS: readonly TimePrecision[] = ['day', 'week', 'month', 'year', 'span'];
const SOURCES: readonly OccurrenceSource[] = ['explicit', 'relative', 'mention'];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * `raw` as a memory's `occurred`, checked as a store writes it: an array of at most
 * `MAX_STATED_OCCURRENCES + 1` entries, each with ISO instants `from` < `to` (UTC, `Z`) at most
 * `MAX_OCCURRENCE_DAYS` apart, a known `precision` and `source`, and nothing else. Throws a
 * `RangeError` naming the first problem.
 */
export function checkOccurrences(raw: unknown): Occurrence[] {
  if (!Array.isArray(raw)) throw new RangeError('occurred must be an array');
  if (raw.length > MAX_STATED_OCCURRENCES + 1) {
    throw new RangeError(`occurred holds at most ${MAX_STATED_OCCURRENCES + 1} entries`);
  }
  return raw.map((o: unknown, i): Occurrence => {
    if (typeof o !== 'object' || o === null)
      throw new RangeError(`occurred[${i}] must be an object`);
    const { from, to, precision, source, ...extra } = o as Record<string, unknown>;
    if (Object.keys(extra).length > 0) {
      throw new RangeError(`occurred[${i}] has unknown field ${Object.keys(extra)[0]}`);
    }
    if (typeof from !== 'string' || !ISO_INSTANT.test(from) || Number.isNaN(Date.parse(from))) {
      throw new RangeError(`occurred[${i}].from must be an ISO instant`);
    }
    if (typeof to !== 'string' || !ISO_INSTANT.test(to) || Number.isNaN(Date.parse(to))) {
      throw new RangeError(`occurred[${i}].to must be an ISO instant`);
    }
    const span = Date.parse(to) - Date.parse(from);
    if (!(span > 0) || span > MAX_OCCURRENCE_DAYS * DAY_MS) {
      throw new RangeError(
        `occurred[${i}] must end after it starts, at most ${MAX_OCCURRENCE_DAYS} days later`,
      );
    }
    if (!PRECISIONS.includes(precision as TimePrecision)) {
      throw new RangeError(`occurred[${i}].precision must be one of ${PRECISIONS.join(', ')}`);
    }
    if (!SOURCES.includes(source as OccurrenceSource)) {
      throw new RangeError(`occurred[${i}].source must be one of ${SOURCES.join(', ')}`);
    }
    return { from, to, precision: precision as TimePrecision, source: source as OccurrenceSource };
  });
}
