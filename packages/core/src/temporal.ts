import * as chrono from 'chrono-node';

/**
 * Time handling in code, never in a model (CON-34): relative expressions are resolved with
 * chrono-node against the observation's own timestamp, in UTC, at day precision.
 */

const DAY_MS = 86_400_000;

const ref = (at: Date) => ({ instant: at, timezone: 'UTC' as const });

const startOfDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const endOfDay = (d: Date): Date => new Date(startOfDay(d).getTime() + DAY_MS - 1);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Words right before a date that make it the fact's end ("until Friday") or start ("since"). */
const UNTIL = /\b(until|till|through|thru|expires?|expiring|ends?(\s+on)?)\s*$/;
const FROM = /\b(since|from|starting|starts|as\s+of|effective|beginning|begins)\s*$/;
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
 * time). "Until Friday" ends the fact after that Friday; "starting next week" and "since last
 * Monday" start it then. A plain date ("on 2026-11-03 we chose pnpm") dates an event and sets no
 * bound. An end at or before the start is dropped.
 */
export function factInterval(text: string, at: Date): FactInterval {
  const out: FactInterval = {};
  // Ends and announced starts look forward ("until Friday" is the coming one); "since" looks back.
  const forward = chrono.parse(text, ref(at), { forwardDate: true });
  const backward = chrono.parse(text, ref(at), { forwardDate: false });
  for (const r of forward) {
    const lead = leadIn(text, r);
    if (out.validTo === undefined && UNTIL.test(lead)) {
      const d = (r.end ?? r.start).date();
      out.validTo = new Date(startOfDay(d).getTime() + DAY_MS).toISOString();
    } else if (out.validFrom === undefined && FROM.test(lead)) {
      const since = /\bsince\s*$/.test(lead);
      const b = since ? (backward.find((x) => x.index === r.index) ?? r) : r;
      out.validFrom = startOfDay(b.start.date()).toISOString();
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

/**
 * Checks the writer's absolute date against the turn. When the turn names exactly one relative
 * day ("yesterday") and the written fact carries exactly one ISO day, that day must be chrono's
 * reading of the relative one; a different day is replaced and reported in `fixed`. Anything
 * ambiguous is left as written.
 */
export function checkWriterDate(
  turnText: string,
  factText: string,
  at: Date,
): { text: string; fixed?: { from: string; to: string } } {
  const relatives = turnText.match(RELATIVE) ?? [];
  const days = [...new Set(factText.match(ISO_DAY) ?? [])];
  if (relatives.length !== 1 || days.length !== 1) return { text: factText };
  const isRelative = new RegExp(RELATIVE.source, 'i');
  const parsed = chrono
    .parse(turnText, ref(at), { forwardDate: false })
    .filter((r) => isRelative.test(r.text));
  if (parsed.length !== 1) return { text: factText };
  const resolved = ymd(parsed[0]!.start.date());
  const written = days[0]!;
  if (resolved === written) return { text: factText };
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
 * History cues. "Used to" counts only as a habit ("we used to deploy with fly"), not the passive
 * "is used to deploy"; "history" only as "history of …" or a question ending in it, not "git
 * history cleanup".
 */
const HISTORY =
  /\b(history\s+of|history\s*(?=[?.!]*\s*$)|over\s+time|changed|(?<!\b(?:is|are|was|were|be|been|being|gets?|got)\s+)used\s+to|previously|in\s+the\s+past|all\s+versions|earlier\s+versions|before\s*(?=[?.!]*\s*$))/i;
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
 * known-at that day; history words ("changed", "used to", "previously") ask for the chain; a past
 * day ("on 2 April 2026", "in March") is as-of that day; anything else, including "now" and
 * future days, is the current state. A date with no year that reads as the future means the last
 * one ("in March" asked in November is this year's March).
 */
export function temporalIntent(query: string, now: Date): TemporalIntent {
  const r = chrono.parse(query, ref(now), { forwardDate: false })[0];
  let day: Date | undefined;
  if (r !== undefined) {
    let d = r.start.date();
    const relative = /\b(next|this|coming|tomorrow|tonight|in\s+\d+)\b/i.test(r.text);
    if (d.getTime() > now.getTime() && !r.start.isCertain('year') && !relative) {
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
  if (HISTORY.test(rest)) {
    const words = new RegExp(HISTORY.source, 'gi');
    return withText({ mode: 'history' }, without(rest.replace(words, ' '), ''), query);
  }
  if (day !== undefined) {
    return withText({ mode: 'as-of', asOf: endOfDay(day).toISOString() }, rest, query);
  }
  return { mode: 'current' };
}

function withText(i: TemporalIntent, rest: string, query: string): TemporalIntent {
  return rest !== '' && rest !== query ? { ...i, text: rest } : i;
}
