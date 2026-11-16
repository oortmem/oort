import { informativeTokens } from './relevance.js';

/**
 * Questions about two or more things, split into one sub-query per thing, by rules in code (no
 * model call). "Which did I buy first, the desk or the chair?" asks about two purchases, and one
 * query vector for the whole question lands near one of them, or between both. Recall searches
 * each sub-query as well as the whole question, so each thing can be found (see `recall`).
 *
 * The shapes, in plain English:
 * - a choice: "which/who … first (earlier, later, most recently, before, after), A or B?";
 * - an ordered list: "in what order …: A, B and C?", "who … first, second and third among A, B
 *   and C?";
 * - "how many days (how long, what is the difference in …) between A and B?";
 * - "how long had I been A when B?", "how many days had passed since A when B?";
 * - "how many days before A did I B?", "how long did I A before (after) B?";
 * - "how many … A and B combined (in total)?".
 *
 * Each sub-query keeps the thing's own words: the question's scaffolding ("which … first", "how
 * many days between", "the day I") goes, and quoted titles stay whole. A text that is not one of
 * these shapes, is long, spans lines, looks like code, or names a part with nothing to search
 * for, is not split: `undefined`, and recall runs exactly as it always has.
 */
export function subQueries(text: string): string[] | undefined {
  if (text.length > MAX_CHARS || /[\r\n]/.test(text)) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '' || looksLikeCode(t)) return undefined;
  const whole = splitSentence(t);
  if (whole !== undefined) return whole;
  // A question after some context: "I'm sorting my notes. Which did I buy first, …?"
  const last = lastSentence(t);
  return last === t ? undefined : splitSentence(last);
}

/** The most parts a question is split into; a longer list is not a two-event question. */
export const MAX_SUB_QUERIES = 4;
/**
 * A part's best match may pass the relevance gate on its part (and not on the whole question)
 * only with a rerank score of at least this share of `recall.minRerankScore`, when it has one: a
 * note about one of two things scores lower against the whole question than the evidence for
 * both, but not far below the threshold.
 */
export const PART_RERANK_FLOOR = 0.5;
/**
 * The informative words of its part a part's best match must hold to pass the gate on words: a
 * part of one word ("bus") never passes on that word alone, only on closeness to the part.
 */
export const PART_MIN_WORDS = 2;
/** Longer texts are prompts with context, not questions about events. */
const MAX_CHARS = 400;
/** The most words in one part. */
const MAX_PART_WORDS = 24;

const PAST =
  /\b(?:did|was|were|had|happened|became|got|met|went|came|took|made|began|bought|saw|heard|left|won|lost|ran|read|wrote|sold|\w{3,}ed)\b/i;
const ORDER_CUE =
  /\b(?:first|earlier|earliest|sooner|soonest|later|latest|last|most recently|more recently|before|after|order)\b/i;
const TIME_UNITS = '(?:seconds|minutes|hours|days|weeks|months|years)';
const AUX = '(?:did|do|does|was|were|is|are|have|has|had)';
const SUBJECT = '(?:I|we|you|he|she|they|the narrator)';

/**
 * Code, paths and markup: a prompt to a coding assistant ("which did I run first, `pnpm test` or
 * `pnpm build`?", "src/a.ts or src/b.ts") is never split.
 */
function looksLikeCode(t: string): boolean {
  return (
    /[`{}[\]<>=;\\|]|::|->|=>|\(\s*\)/.test(t) ||
    /\w\/\w/.test(t) ||
    /\b[a-z][\w-]*\.[a-z][a-z0-9]{0,4}\b/i.test(t) ||
    /\b\d+\.\d+\.\d+/.test(t) ||
    /\w_\w/.test(t) ||
    /\b[a-z]{2,}[A-Z]/.test(t)
  );
}

function lastSentence(t: string): string {
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return parts[parts.length - 1] ?? t;
}

/** Quoted spans, replaced by placeholders so commas, "and" and "or" inside a title are kept. */
interface Protected {
  text: string;
  restore: (s: string) => string;
}

const QUOTED = /(?<=^|[\s(:,])(['"‘“])(?=\S)(.+?)(?<=\S)(['"’”])(?=$|[\s,.?!:;)])/g;

function protect(t: string): Protected {
  const spans: string[] = [];
  const text = t.replace(QUOTED, (m: string) => {
    spans.push(m);
    return `${spans.length - 1}`;
  });
  return {
    text,
    restore: (s) => s.replace(/(\d+)/g, (_, i: string) => spans[Number(i)] ?? ''),
  };
}

function splitSentence(raw: string): string[] | undefined {
  const p = protect(raw);
  const s = p.text.replace(/[?.!\s]+$/, '');
  const parts =
    choice(s, p.restore) ??
    between(s) ??
    whenClause(s) ??
    beforeAfter(s) ??
    combined(s, p.text) ??
    undefined;
  if (parts === undefined) return undefined;
  const out: string[] = [];
  for (const part of parts) {
    const q = p.restore(part.replace(/\s+/g, ' ').trim());
    if (thin(q)) continue;
    if (!out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q);
  }
  return out.length >= 2 && out.length <= MAX_SUB_QUERIES ? out : undefined;
}

/**
 * A part with nothing to search for: no informative word, or a verb and a pronoun ("bought it"),
 * or more words than a part of a question has.
 */
function thin(part: string): boolean {
  const words = part.split(' ');
  if (words.length > MAX_PART_WORDS) return true;
  const n = informativeTokens(part).size;
  if (n === 0) return true;
  return n < 2 && /\b(?:it|them|him|her|this|that|these|those|one)$/i.test(part);
}

/** Leading scaffolding of one event: "and", "the day I", "when I", articles, "my". */
function clean(part: string): string {
  let s = part.trim();
  for (;;) {
    const next = s
      .replace(/^(?:and|or|then)\s+/i, '')
      .replace(
        /^(?:the|that)\s+(?:day|time|moment|week|weekend|month|year|night|evening|morning)\s+(?:when\s+|that\s+)?(?:I|we)\s+/i,
        '',
      )
      .replace(/^(?:when|that|since)\s+(?:I|we)\s+/i, '')
      .replace(/^(?:I|we)\s+/, '')
      .replace(/^(?:the|a|an|my|our)\s+/i, '')
      .trim();
    if (next === s) return s;
    s = next;
  }
}

/**
 * The items of a list: "A or B", "A, B or C", "A, B, and C". With an "or", only "or" and commas
 * separate (an item may be "Ana and Luis"); without one, commas and the last "and".
 */
function listItems(list: string): string[] | undefined {
  const hasOr = /\sor\s/i.test(list);
  let items: string[];
  if (hasOr) {
    items = list.split(/\s*,\s*(?:or\s+)?|\s+or\s+/i);
  } else {
    const commas = list.split(/\s*,\s*/);
    const last = commas.pop() ?? '';
    const ands = last.split(/\s+and\s+/i);
    // Without commas, one "and" only: "A and B and C" is ambiguous.
    if (commas.length === 0 && ands.length !== 2) return undefined;
    if (commas.length > 0 && ands.length > 2) return undefined;
    items = [...commas, ...ands];
  }
  items = items.map((i) => i.trim()).filter((i) => i !== '');
  return items.length >= 2 ? items : undefined;
}

/**
 * "Which laptop did I buy first, A or B?", "Who moved abroad first, A or B?", "In what order did
 * these happen: A, B and C?", "Who retired first, second and third among A, B and C?". The head
 * names an order and is in the past ("did", "was", "-ed"): "which should I do first, A or B?" is
 * a plan, not two events.
 */
function choice(s: string, restore: (s: string) => string): string[] | undefined {
  // A colon list first, then "among", then a comma: "who … first, second and third among A, B
  // and C" is an "among" list, not a choice after "first,".
  for (const sep of [':', 'among', ',']) {
    const m = new RegExp(
      `^(?<head>(?:which|who|whom|what|in\\s+what\\s+order)\\b.*?)${sep === 'among' ? '\\s+among\\s+' : `${sep}\\s+`}(?<list>.+)$`,
      'i',
    ).exec(s);
    if (m?.groups === undefined) continue;
    const { head, list } = m.groups as { head: string; list: string };
    if (!ORDER_CUE.test(head)) continue;
    // A list after a colon may carry the past itself: "what is the order of: 'I renewed …', …".
    if (!PAST.test(head) && !(sep === ':' && PAST.test(restore(list)))) continue;
    if (sep === ',' && !/\sor\s/i.test(list)) continue;
    const items = listItems(list);
    if (items === undefined) continue;
    const events = items.map(clean);
    // A list after a colon names whole events ("the day I …"); a choice or "among" names things,
    // which take the head's verb: "buy ThinkPad X1", "Priya moved abroad".
    if (sep === ':') return events;
    const pred = predicate(head);
    if (pred === undefined) continue;
    return events.map((e) =>
      pred.subject
        ? `${pred.before} ${e} ${pred.after}`.trim()
        : `${e} ${pred.before} ${pred.after}`.trim(),
    );
  }
  return undefined;
}

/**
 * The head of a choice without its scaffolding: "Which laptop did I buy first" → buy; "Which
 * room did we paint first in March" → paint … in March; "Who moved abroad first" → moved abroad,
 * with the alternative as its subject.
 */
function predicate(head: string): { before: string; after: string; subject: boolean } | undefined {
  const withAux = new RegExp(
    `^(?:which|what|who|whom)(?:\\s+.+?)?\\s+${AUX}\\s+${SUBJECT}\\s+(?<vp>.+)$`,
    'i',
  ).exec(head);
  let vp: string;
  let subject: boolean;
  if (withAux?.groups !== undefined) {
    vp = withAux.groups['vp'] as string;
    subject = true;
  } else {
    // The alternative is the subject: "Which event happened first", "Who moved abroad first".
    const bare = new RegExp(
      `^(?:which\\s+\\w+(?:\\s+of\\s+\\w+)?|who)\\s+(?:${AUX}\\s+)?(?<vp>.+)$`,
      'i',
    ).exec(head);
    if (bare?.groups === undefined) return undefined;
    vp = bare.groups['vp'] as string;
    subject = false;
  }
  const cue =
    /\s*\b(?:(?:first|second|third|fourth|last)(?:,?\s+(?:and\s+)?(?:second|third|fourth|last))*|earlier|earliest|sooner|later|latest|most recently|more recently)\b\s*/i;
  const at = cue.exec(vp);
  const before = (at === null ? vp : vp.slice(0, at.index)).trim();
  const after = at === null ? '' : vp.slice(at.index + at[0].length).trim();
  // "Which event happened first, A or B": the verb says nothing about A or B.
  if (!subject && /^(?:happened|occurred|took place|came|started|began)$/i.test(before)) {
    return { before: '', after, subject };
  }
  return { before, after, subject };
}

/**
 * "How many days passed between A and B?", "How long between …", "What is the difference in
 * price between A and B?". A list of "and"s is split at the one that repeats how the first part
 * begins ("the time I … and the time I …").
 */
function between(s: string): string[] | undefined {
  const m = new RegExp(
    `^(?:how\\s+(?:many\\s+${TIME_UNITS}|long|much\\s+(?:time|money|more|less))|(?:what|how\\s+big)\\s+(?:is|was|were)\\s+the\\s+(?:difference|gap)\\s+in\\s+\\w+)\\b.*?\\bbetween\\s+(?<list>.+)$`,
    'i',
  ).exec(s);
  const list = m?.groups?.['list'];
  if (list === undefined) return undefined;
  const pair = splitAnd(list);
  if (pair === undefined) return undefined;
  const [a, b] = pair;
  // "between my first and second appointment": the first part is "my first appointment".
  const ord =
    /^(?:the\s+|my\s+|our\s+)?(?:first|second|third|fourth|last|next)\s+(?<rest>.+)$/i.exec(b);
  if (ord?.groups !== undefined && /\b(?:first|second|third|fourth|last|previous)$/i.test(a)) {
    return [clean(`${a} ${ord.groups['rest'] as string}`), clean(b)];
  }
  return [clean(a), clean(b)];
}

function splitAnd(list: string): [string, string] | undefined {
  const ands = [...list.matchAll(/\s+and\s+/gi)];
  if (ands.length === 0) return undefined;
  const at = (i: number): [string, string] => {
    const a = ands[i] as RegExpExecArray;
    return [list.slice(0, a.index), list.slice(a.index + a[0].length)];
  };
  if (ands.length === 1) return at(0);
  // The "and" whose right side starts as the left side does: "the time I …".
  const lead = /^((?:the|that|my|when)\s+\w+(?:\s+(?:I|we))?)\b/i.exec(list)?.[1]?.toLowerCase();
  if (lead !== undefined) {
    for (let i = 0; i < ands.length; i++) {
      if (at(i)[1].toLowerCase().startsWith(lead)) return at(i);
    }
  }
  return undefined;
}

/**
 * "How long had I been A when (I) B?", "How many weeks have I been A when B?", "How many days
 * had passed since I A when I B?", "How many days ago did I A when I B?".
 */
function whenClause(s: string): string[] | undefined {
  const m =
    new RegExp(
      `^how\\s+(?:long|many\\s+${TIME_UNITS}(?:\\s+ago)?)\\s+(?:had|have|did)\\s+(?:I|we)\\s+(?:been\\s+)?(?<a>.+?)\\s+when\\s+(?<b>.+)$`,
      'i',
    ).exec(s) ??
    new RegExp(
      `^how\\s+(?:long|many\\s+${TIME_UNITS})\\s+(?:had|have)\\s+(?:passed|gone\\s+by|elapsed)\\s+since\\s+(?<a>.+?)\\s+when\\s+(?<b>.+)$`,
      'i',
    ).exec(s);
  if (m?.groups === undefined) return undefined;
  return [clean(m.groups['a'] as string), clean(m.groups['b'] as string)];
}

/**
 * "How many days before (after) A did I B?" and "How long did I A before (after) B?", "How many
 * days did it take me to A after B?".
 */
function beforeAfter(s: string): string[] | undefined {
  const lead = `^how\\s+(?:long|many\\s+${TIME_UNITS})`;
  const front = new RegExp(
    `${lead}\\s+(?:before|after)\\s+(?<a>.+?)\\s+(?:did|had|have|was|were)\\s+(?<subj>I|we|[A-Z][\\w'’-]*)\\s+(?<b>.+)$`,
  ).exec(s.replace(/^how/i, 'how'));
  if (front?.groups !== undefined) {
    const { a, subj, b } = front.groups as { a: string; subj: string; b: string };
    const who = /^(?:I|we)$/.test(subj) ? '' : `${subj} `;
    return [clean(a), `${who}${clean(b)}`];
  }
  const back = new RegExp(
    `${lead}\\s+(?:did|had|have|was|were)\\s+(?:(?:it\\s+take\\s+(?:me|us|for\\s+me|for\\s+us)\\s+to)|${SUBJECT}(?:\\s+been)?)\\s+(?<a>.+?)\\s+(?:before|after)\\s+(?<b>.+)$`,
    'i',
  ).exec(s);
  if (back?.groups === undefined) return undefined;
  const b = back.groups['b'] as string;
  if (/^(?:and|or)\b/i.test(b)) return undefined;
  return [clean(back.groups['a'] as string), clean(b)];
}

/**
 * "How long did it take me to read 'A' and 'B' combined?", "How many days did I spend in total
 * hiking in A and in B?", "How much did I spend on A and B combined?".
 */
function combined(s: string, withQuotes: string): string[] | undefined {
  if (!/^how\s+(?:many|much|long)\b/i.test(s)) return undefined;
  const cue = /\b(?:combined|in total|altogether|together|total)\b/i;
  if (!cue.test(s)) return undefined;
  // Two or more quoted titles: each title is a part.
  const titles = [...withQuotes.matchAll(/\d+/g)].map((x) => x[0]);
  if (titles.length >= 2 && /\sand\s/i.test(s)) return titles;
  // "… in total A and in B": the parts follow the cue.
  const after = /\b(?:in total|altogether)\s+(?<list>.+\s+and\s+.+)$/i.exec(s);
  if (after?.groups !== undefined) {
    const pair = splitAnd(after.groups['list'] as string);
    if (pair === undefined) return undefined;
    const [a, b] = pair;
    // "hiking in Norway and in Scotland": the second part takes the first part's verb.
    const prep = /^(in|at|on|to|for|with|from)\s+/i.exec(b)?.[1];
    if (prep !== undefined) {
      const at = new RegExp(`\\s${prep}\\s`, 'i').exec(a);
      if (at !== null) return [clean(a), clean(`${a.slice(0, at.index)} ${b}`)];
    }
    return [clean(a), clean(b)];
  }
  // "… on A and B combined": the parts sit between the last preposition and the cue.
  const before =
    /^(?<lead>.+)\s+(?:on|for|to|of|with|at)\s+(?<list>[^,]+?\s+and\s+[^,]+?)\s+(?:combined|in total|altogether|together)$/i.exec(
      s,
    );
  if (before?.groups === undefined) return undefined;
  const pair = splitAnd(before.groups['list'] as string);
  return pair?.map(clean);
}
