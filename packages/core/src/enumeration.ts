import { looksLikeCode } from './subqueries.js';

/**
 * Questions that gather many instances of one thing, told across many conversations: "what is
 * the order of the six museums I visited?", "how many charity events did I take part in?",
 * "which airline did I fly with the most?". Each instance tends to sit in its own session, while
 * a few sessions that talk about the topic at length fill the top k. For these questions only,
 * recall spreads its top k across sources (`spreadAcrossSources`).
 *
 * The rules, in plain English, all by rules in code (no model call):
 * - "the order of", "in what order", "in which order", "chronological order";
 * - "how many" before a plural noun that I or we did, had or have ("how many charity events did
 *   I …", "how many books I read"), but not a unit of time ("how many days ago did I …");
 * - "the most", "the least", "most often", "most frequently", but not "most recent";
 * - "all the" (not "all the way", "all the time") and "every";
 * - "list" as a request ("list the restaurants I tried", "can you list …");
 * - "in total", "altogether", "the total number (amount) of".
 *
 * Each needs the person in the question (I, we, me, my, our, us): "how many tests fail" asks
 * about one thing, and so does "what is the most common error in this log". A text that is long,
 * spans lines, looks like code, or starts as an instruction ("fix all the failing tests") is
 * never one.
 */
export function isEnumeration(text: string): boolean {
  if (text.length > MAX_CHARS || /[\r\n]/.test(text)) return false;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '' || looksLikeCode(t)) return false;
  if (INSTRUCTION.test(t)) return false;
  if (!PERSONAL.test(t)) return false;
  return (
    ORDER.test(t) ||
    howManyPlural(t) ||
    (MOST.test(t) && !RECENT.test(t)) ||
    allThe(t) ||
    EVERY.test(t) ||
    LIST.test(t) ||
    TOTAL.test(t)
  );
}

/**
 * The top `k` of `ranked`, spread across sources. In rank order, each memory takes the next place
 * unless `perSource` memories from its source already hold one; then it is skipped. The places
 * left are filled from the skipped memories, in rank order, so nothing is lost when there are
 * fewer sources than places. A memory whose source is undefined is a source of its own. A memory
 * in `keep` (a part's best match) always takes its place, and counts towards its source.
 *
 * `ranked` is what passed the relevance gate: the spread only reorders it, and never adds to it.
 */
export function spreadAcrossSources<T extends { id: string }>(
  ranked: readonly T[],
  sourceOf: (id: string) => string | undefined,
  perSource: number,
  k: number,
  keep: ReadonlySet<string> = new Set(),
): T[] {
  const taken: T[] = [];
  const skipped: T[] = [];
  const held = new Map<string, number>();
  for (const f of ranked) {
    if (taken.length >= k) break;
    const s = sourceOf(f.id);
    if (s === undefined) {
      taken.push(f);
      continue;
    }
    const n = held.get(s) ?? 0;
    if (n < perSource || keep.has(f.id)) {
      taken.push(f);
      held.set(s, n + 1);
    } else {
      skipped.push(f);
    }
  }
  return [...taken, ...skipped].slice(0, k);
}

/** Longer texts are prompts with context, not questions about past events. */
const MAX_CHARS = 400;

/** The person asking: "I" as a word (case-sensitive), and the other first-person words. */
const PERSONAL = /\bI\b|\b(?:[Ww]e|[Mm]e|[Mm]y|[Oo]ur|us|[Mm]yself|[Oo]urselves)\b/;

/** An instruction to a coding assistant, by its first word. "List" is not one. */
const INSTRUCTION =
  /^(?:please\s+)?(?:fix|add|remove|delete|rename|update|run|write|create|make|refactor|change|move|implement|review|build|deploy|install|commit|push|merge|open|close|replace|convert|format|lint|clean|set|configure|generate|edit|test|debug|check|use|start|stop|restart|migrate|upgrade|bump|revert|copy|print|log|send|fetch|download|upload)\b/i;

const ORDER =
  /\b(?:the\s+order\s+(?:of|in\s+which)|in\s+(?:what|which)\s+order|chronological\s+order)\b/i;

const MOST =
  /\b(?:the\s+(?:most|least)|most\s+(?:often|frequently|times)|least\s+(?:often|frequently))\b/i;
/** "the most recent", "most recently": the latest one, not one of many. */
const RECENT = /\bmost\s+recent(?:ly)?\b/i;

/** "all the", "all my": a set of things, unless an idiom ("all the way", "all the time"). */
const ALL_THE = /\ball\s+(?:the|of\s+the|of\s+my|of\s+our|my|our)\s+([\w'’-]+)/gi;
const ALL_THE_IDIOMS = new Set(['way', 'time', 'same', 'while', 'better', 'more', 'rest']);

function allThe(t: string): boolean {
  for (const m of t.matchAll(ALL_THE)) {
    if (!ALL_THE_IDIOMS.has((m[1] ?? '').toLowerCase())) return true;
  }
  return false;
}

/** "every" as a word ("everything", "everyone" are not). */
const EVERY = /\bevery\s+(?!one\b|body\b|thing\b)\w+/i;

/** "list" as a request: at the start, after "can you" or "please", or "list all (every, the, my)". */
const LIST =
  /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?list\b|\blist\s+(?:all|every|each|the|my|our)\b/i;

const TOTAL = /\b(?:in\s+total|altogether|the\s+total\s+(?:number|amount|cost|count|sum)\s+of)\b/i;

const TIME_UNITS = new Set([
  'seconds',
  'minutes',
  'hours',
  'days',
  'nights',
  'weeks',
  'weekends',
  'months',
  'years',
  'decades',
]);
const IRREGULAR_PLURALS = new Set(['people', 'children', 'men', 'women', 'feet', 'teeth', 'mice']);
const AUX = '(?:did|do|does|have|has|had|was|were|am|are|will|would|could|can|should|might|must)';
/** "how many", up to four words, the noun, an optional "of …", then I or we (after an auxiliary). */
const HOW_MANY = new RegExp(
  `\\bhow\\s+many\\s+(?:of\\s+(?:my|our|the)\\s+)?(?:[\\w'’-]+\\s+){0,4}?(?<noun>[\\w'’-]+)(?:\\s+of\\s+[\\w'’-]+(?:\\s+[\\w'’-]+)?)?\\s+(?:${AUX}\\s+)?(?:I|we)\\b`,
  'i',
);

/**
 * "How many <plural> did (have, do) I …", "how many <plural> I …": the plural is what the person
 * did, had or has, counted over time. A unit of time is a duration ("how many days ago did I …"),
 * and a plural that is the subject ("how many tests fail", "how many people came") is one event.
 */
function howManyPlural(t: string): boolean {
  const m = HOW_MANY.exec(t);
  const noun = m?.groups?.['noun']?.toLowerCase();
  if (noun === undefined) return false;
  if (TIME_UNITS.has(noun)) return false;
  return isPlural(noun);
}

function isPlural(w: string): boolean {
  if (IRREGULAR_PLURALS.has(w)) return true;
  return /[a-z]{2,}s$/.test(w) && !/(?:ss|us|is)$/.test(w);
}
