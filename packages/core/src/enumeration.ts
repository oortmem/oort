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
 * - "how many" before a plural noun that I or we did or have done ("how many charity events did
 *   I …", "how many projects have I led", "how many books I read"), or still need to ("how many
 *   items do I need to return"), but not a unit of time ("how many days ago did I …");
 * - "the most", "the least", "most often", "most frequently", but not "most recent";
 * - "all the" (not "all the way", "all the time") and "every";
 * - "list" as a request ("list the restaurants I tried", "can you list all …");
 * - "in total", "altogether", "the total number (amount) of".
 *
 * An order or a total needs the person in the question (I, we, me, my, our, us). "How many",
 * "the most", "all the", "every" and "list" need a past the person tells of (`PAST`): "did I",
 * "have we", "I visited", "I've been", "my plants needed", "remind me", or my or our beside
 * "last week" or "yesterday". "How many" also takes what the person has or still has to do now
 * ("how many tanks do I currently have"). A prompt to a coding assistant is mostly in the present:
 * "how many tests do we run in CI", "what is the most common error in my log", "how do I handle
 * every request in my app", "list the files in my repo" are not about many past events. A text that is long, spans lines, looks like code, or starts as
 * an instruction ("fix all the failing tests") is never one.
 */
export function isEnumeration(text: string): boolean {
  if (text.length > MAX_CHARS || /[\r\n]/.test(text)) return false;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '' || looksLikeCode(t)) return false;
  if (INSTRUCTION.test(t)) return false;
  if (howManyPlural(t)) return true;
  // An order or a total of the person's own things: "the order of the museums I visited", "the
  // total number of siblings I have".
  if (PERSONAL.test(t) && (ORDER.test(t) || TOTAL.test(t))) return true;
  if (!PAST.test(t) && !(PERSONAL.test(t) && PAST_TIME.test(t))) return false;
  return (MOST.test(t) && !RECENT.test(t)) || allThe(t) || EVERY.test(t) || LIST.test(t);
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

/** A past time said outright: "last week", "yesterday", "two months ago". */
const PAST_TIME =
  /\b(?:yesterday|last\s+(?:week|weekend|month|year|night|summer|winter|spring|autumn|fall|time)|(?:a|an|one|two|three|four|five|six|few|several|\d+)\s+\w+\s+ago)\b/i;

/** Past forms that do not end in -ed. "set", "put" and "cut" are left out: present as often. */
const IRREGULAR_PAST =
  'went|gone|bought|saw|seen|met|ate|eaten|drank|flew|flown|took|taken|made|read|wrote|written|sold|got|gotten|gave|given|found|kept|spent|paid|sent|built|taught|caught|brought|thought|told|wore|worn|drove|driven|rode|swam|sang|chose|chosen|did|done|been|had|was|were|came|left|won|lost|ran|began|begun|heard|felt|fell|grew|grown|knew|known|led|meant|said|sat|slept|spoke|stood|threw|woke';
/** Words that end in -ed and are no past: "I need", "my feed". */
const NOT_PAST =
  'need|feed|speed|seed|bleed|breed|weed|proceed|succeed|exceed|embed|shred|sled|hundred|bed|red';
const VERB_PAST = `(?:${IRREGULAR_PAST}|(?!(?:${NOT_PAST})\\b)[a-z]{2,}ed)`;
/** One adverb may sit between the person and the verb: "I already visited", "we also tried". */
const ADVERB =
  '(?:\\s+(?:also|already|ever|recently|actually|just|once|finally|first|last|never|really|probably|only|still))?';
/** "I" or "we" as a subject, unless after a modal or "to": "how do I read", "can we run". */
const SUBJECT =
  "(?<!\\b(?:do|does|don't|can|could|should|would|will|must|might|may|shall|to)\\s+)\\b(?:I|we)";

/**
 * A past the person tells of: "did I", "have we", "had I", "I visited", "we've been", "I have
 * tried", "my plants needed", "did it take me", or a request to remember ("remind me").
 */
const PAST = new RegExp(
  [
    `\\b(?:did|have|had|was|were)\\s+(?:I|we)\\b`,
    `${SUBJECT}(?:'ve|’ve|\\s+have|\\s+had)${ADVERB}\\s+${VERB_PAST}\\b`,
    `${SUBJECT}${ADVERB}\\s+${VERB_PAST}\\b`,
    `\\b(?:my|our)\\s+(?:[a-z'’-]+\\s+){0,2}?${VERB_PAST}\\b`,
    `\\bremind\\s+(?:me|us)\\b`,
    `\\bdid\\s+it\\s+take\\s+(?:me|us)\\b`,
  ].join('|'),
  'i',
);

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

/**
 * "list" as a request: at the start (after "can you" or "please") before "all", "every",
 * "each", "the", "my" or "our"; elsewhere only "list all (every, each)".
 */
const LIST =
  /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?list\s+(?:all|every|each|the|my|our)\b|\blist\s+(?:all|every|each)\b/i;

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
/**
 * "how many", up to four words, the noun, an optional "of …", then an optional auxiliary, I or
 * we, and the rest of the clause.
 */
const HOW_MANY = new RegExp(
  `\\bhow\\s+many\\s+(?:of\\s+(?:my|our|the)\\s+)?(?:[\\w'’-]+\\s+){0,4}?(?<noun>[\\w'’-]+)(?:\\s+of\\s+[\\w'’-]+(?:\\s+[\\w'’-]+)??)?\\s+(?:(?<aux>did|do|does|have|has|had|was|were|am|are|will|would|could|can|should|might|must)\\s+)?(?<clause>(?:I|we)\\b[^?.!]*)`,
  'i',
);
/**
 * After "do I": what the person has, owns or still has to do ("do I currently have", "do I need
 * to return"), counted over what they told of. Not a habit or a process ("do we run").
 */
const STILL_TO = /^(?:I|we)\s+(?:currently\s+|still\s+)?(?:have|own|need\s+to)\b/i;

/**
 * "How many <plural> did (have, had) I …", "how many <plural> I <past> …", "how many <plural> do I
 * (currently) have (own, need to) …": the plural is what the person did, or gathered over time.
 * Any other present ("how many tests do we run") is about how things work now. A unit of time is a duration ("how
 * many days ago did I …"), and a plural that is the subject ("how many tests fail", "how many
 * people came") is one event.
 */
function howManyPlural(t: string): boolean {
  const m = HOW_MANY.exec(t);
  const g = m?.groups;
  const noun = g?.['noun']?.toLowerCase();
  const clause = g?.['clause'];
  if (noun === undefined || clause === undefined) return false;
  if (TIME_UNITS.has(noun) || !isPlural(noun)) return false;
  const aux = g?.['aux']?.toLowerCase();
  if (aux === undefined) return PAST.test(clause);
  if (/^(?:did|have|had|was|were)$/.test(aux)) return true;
  if (aux === 'do') return STILL_TO.test(clause);
  return false;
}

function isPlural(w: string): boolean {
  if (IRREGULAR_PLURALS.has(w)) return true;
  return /[a-z]{2,}s$/.test(w) && !/(?:ss|us|is)$/.test(w);
}
