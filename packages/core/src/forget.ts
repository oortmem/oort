import type { Embedder, MemoryStore, MemoryWriter, WrittenMemory } from './adapters.js';
import { checkOccurrences, occurrencesOf, type Occurrence } from './event-time.js';
import { grantWrites, type Grant } from './grant.js';
import { factInterval, startBefore, type FactInterval } from './temporal.js';
import { purgeFeedbackFor } from './feedback.js';
import { purgePredictionsCiting } from './judgment.js';
import { isJudgment, type Decision, type Memory } from './model.js';
import { tokenizeLexical } from './tokenize.js';

export interface ForgetDeps {
  store: MemoryStore;
  /** Rewrites the later memories that restate the forgotten one; without it they are reported. */
  write?: MemoryWriter;
  /** Embeds a rewritten memory; without it the rewrite is kept without a vector. */
  embed?: Embedder;
  now?: Date;
}

/**
 * Why a later memory that restates the forgotten one was left as it was:
 * - `no-writer`: no writer with `rewriteCurrent` is wired;
 * - `failed`: the writer or the embedder failed;
 * - `rejected`: the rewrite added words, grew, or still held a value of the forgotten memory;
 * - `unchanged`: the writer returned it as it was, still holding such a value;
 * - `changed`: another write changed it while this one ran;
 * - `not-writable`: it is outside the grant's `write`;
 * - `chain-too-long`: it lies past the first `MAX_CHAIN` later memories of the chain.
 */
export type NotRewrittenReason =
  'no-writer' | 'failed' | 'rejected' | 'unchanged' | 'changed' | 'not-writable' | 'chain-too-long';

export interface ForgetOutcome {
  /** The id forgotten; null for an unknown id or one outside the grant (nothing was changed). */
  forgotten: string | null;
  /** Later memories that restated it, rewritten to their current fact, with their new text. */
  rewritten: { id: string; text: string }[];
  /** Later memories that may still restate it, left as they were. */
  notRewritten: { id: string; reason: NotRewrittenReason }[];
}

/** How many later memories of the chain are rewritten at most; supersede chains are short. */
export const MAX_CHAIN = 64;
/** How many writer calls run at once. */
const PARALLEL_REWRITES = 4;

const REWRITTEN: Decision = {
  stage: 'forget',
  question: 'rewritten',
  answer: 'to its current fact, after a forget',
  probability: 1,
};

/**
 * Decisions that quote or describe the memory's earlier wording: a refine's previous text, and
 * the dates the write path read from the text. A rewrite drops them; what they describe is gone.
 */
const describesOldWording = (d: Decision): boolean =>
  (d.stage === 'refine' && d.question === 'previous-text') ||
  (d.stage === 'temporal' && (d.question === 'writer-date' || d.question === 'interval'));

/** Words a value never is: articles, connectors, auxiliaries (English; other languages compare whole). */
const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for from with as into onto over under ' +
    'is are was were be been being am has have had do does did will would can could should may ' +
    'might must now currently still no not this that these those it its they them their there ' +
    'he she we you i our your his her which who what when where how than also only just set ' +
    'use uses used run runs running changed change changes moved switched updated replaced ' +
    'instead anymore longer earlier previously before after since until'
  ).split(' '),
);

/**
 * Words a rewrite may add that the old text did not hold: the connectors that turn "changed from
 * 3000 to 8080" into "is 8080". Anything else a rewrite adds is rejected.
 */
const CONNECTORS = new Set(
  'a an the is are was were be now currently uses use runs run on at in of to for and its it set'.split(
    ' ',
  ),
);

type Text = Pick<Memory, 'text' | 'stub' | 'entities'>;

/** The words of `s`, lower-cased, a URL, path or identifier kept whole (no trailing punctuation). */
function wordsIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s
    .normalize('NFKC')
    .matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|[/~])?[\p{L}\p{N}][^\s,;!?()[\]{}"'<>`]*/giu)) {
    const w = m[0].replace(/[.:]+$/u, '').toLowerCase();
    if (w !== '') out.push(w);
  }
  return out;
}

/** Every word of a memory's text, stub and entities, and each entity whole. */
function wordsOf(m: Text): Set<string> {
  const words = [
    ...wordsIn(`${m.text} ${m.stub} ${m.entities.join(' ')}`),
    ...m.entities.map((e) => e.toLowerCase()),
  ];
  return new Set([...words, ...words.map(canonical)]);
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A URL or path as compared: NFKC (full-width letters are the plain ones), lower-cased, without
 * its scheme, a leading `www.`, a default port (`:80`, `:443`) or a trailing slash.
 */
function canonical(w: string): string {
  const n = w.normalize('NFKC').toLowerCase();
  const c = n
    .replace(SCHEME, '')
    .replace(/^www\./, '')
    .replace(/^([^/?#]*?):(?:80|443)(?=[/?#]|$)/, '$1')
    .replace(/\/+$/, '');
  return c === '' ? n : c;
}

/**
 * The forms a value can be restated in (final check of #108): a URL without its scheme or
 * trailing slash, or as its host alone (`old.example.com` for `https://old.example.com/v1`).
 */
function formsOf(v: string): string[] {
  const c = canonical(v);
  if (!SCHEME.test(v.normalize('NFKC'))) return [c];
  const host = c.split(/[/?#]/)[0] ?? '';
  return host !== '' && host !== c ? [c, host] : [c];
}

/** Whether `words` (from `wordsOf`) holds value `v` in any of its forms. */
const holds = (words: Set<string>, v: string): boolean =>
  words.has(v) || formsOf(v).some((f) => words.has(f));

/** A number or version, an identifier (`db-primary`, `foo_bar`), a path or a URL. */
const STRONG = (w: string): boolean =>
  /\p{N}/u.test(w) || /[\p{L}\p{N}][._\-@#:/\\][\p{L}\p{N}]/u.test(w) || /^[/~]/.test(w);

/** Never a value: the scheme or host prefix of a URL written apart. */
const URL_PARTS = new Set(['http', 'https', 'www']);

/**
 * Words that mark the next one as the old value: "from X", "was X", "instead of X", … (not when
 * a number or identifier follows X: "from port 3000" names 3000).
 */
const OLD_MARKERS = [
  ['from'],
  ['was'],
  ['previously'],
  ['replaced'],
  ['instead', 'of'],
  ['no', 'longer'],
];

/**
 * The values of `forgotten` that `later`, written from it, could restate (CON-144), lower-cased
 * and whole: a URL, path or identifier is one value, never its pieces.
 * - A number or version, an identifier, a path or a URL (`STRONG`). A URL also matches without
 *   its scheme or trailing slash, and as its host alone (`formsOf`).
 * - A word with a capital (`MySQL`, `API`) only when `forgotten` lists it as an entity and
 *   `later` does not: a name both list is what they are about.
 * - Any other word of `forgotten` (not a stopword) that `later` writes right after "from",
 *   "was", "instead of", "previously", "replaced" or "no longer": "switched from postgres".
 */
export function forgottenValues(forgotten: Text, later: Text): Set<string> {
  const out = new Set<string>();
  const aEntities = new Set(forgotten.entities.map((e) => e.toLowerCase()));
  const bEntities = new Set(later.entities.map((e) => e.toLowerCase()));
  const raw = [...`${forgotten.text} ${forgotten.stub}`.split(/\s+/), ...forgotten.entities];
  for (const r of raw) {
    for (const w of wordsIn(r)) {
      if (URL_PARTS.has(w) || STOPWORDS.has(w)) continue;
      if (STRONG(w)) out.add(w);
      else if (/\p{Lu}/u.test(r) && aEntities.has(w) && !bEntities.has(w)) out.add(w);
    }
  }
  for (const e of forgotten.entities) {
    const w = e.toLowerCase();
    if (STRONG(w) && !URL_PARTS.has(w)) out.add(w);
    else if (/\p{Lu}/u.test(e) && !bEntities.has(w)) out.add(w);
  }
  const aWords = new Set(wordsIn(`${forgotten.text} ${forgotten.stub}`));
  const b = wordsIn(later.text);
  for (let i = 0; i < b.length; i++) {
    for (const marker of OLD_MARKERS) {
      if (!marker.every((m, k) => b[i + k] === m)) continue;
      let k = i + marker.length;
      while (b[k] === 'the' || b[k] === 'a' || b[k] === 'an') k++;
      const w = b[k];
      // "from port 3000": the number is the value, the word before it a label.
      const label = b[k + 1] !== undefined && STRONG(b[k + 1] as string);
      if (w !== undefined && !label && aWords.has(w) && !STOPWORDS.has(w) && !URL_PARTS.has(w)) {
        out.add(w);
      }
    }
  }
  return out;
}

/** Every token of `m`'s text, stub and entities, as the lexical index splits them. */
function tokensOf(m: Text): Set<string> {
  return new Set(tokenizeLexical([m.text, m.stub, ...m.entities].join(' ')));
}

/** `m` with the wordings it keeps of its old text (a refine's previous text, dates read). */
function withKept(m: Pick<Memory, 'text' | 'stub' | 'entities' | 'source'>): Text {
  const kept = m.source.decisions.filter(describesOldWording).map((d) => d.answer);
  return { text: [m.text, ...kept].join(' '), stub: m.stub, entities: m.entities };
}

/**
 * What a forgotten memory and a later one are about, as opposed to a value: the names without
 * a digit or a slash that both list as entities, and that `rewrite` (when given) still lists.
 * None when the later memory lists a name of its own without a digit: then the shared one is
 * the value it replaced ("db-primary" beside a new "db-replica").
 */
function subjectOf(forgotten: Text, later: Text, rewrite?: Text): Set<string> {
  const a = new Set(forgotten.entities.map((e) => e.toLowerCase()));
  const b = later.entities.map((e) => e.toLowerCase());
  if (b.some((e) => !a.has(e) && !/\p{N}/u.test(e))) return new Set();
  const w =
    rewrite === undefined ? undefined : new Set(rewrite.entities.map((e) => e.toLowerCase()));
  return new Set(
    b.filter((e) => a.has(e) && !/[\p{N}/\\]/u.test(e) && (w === undefined || w.has(e))),
  );
}

/** The values of `forgotten` that `m` (with the wordings it keeps) holds, but its subject. */
function restated(
  forgotten: Text,
  m: Pick<Memory, 'text' | 'stub' | 'entities' | 'source'>,
): string[] {
  const values = forgottenValues(forgotten, m);
  const subject = subjectOf(forgotten, m);
  const words = wordsOf(withKept(m));
  return [...values].filter((v) => holds(words, v) && !subject.has(v));
}

/**
 * The values of `forgotten` that `m` restates, in its text, stub, entities or a wording it keeps;
 * empty when it restates none. For callers that cannot rewrite (Oort Cloud) and still must name
 * what may repeat a forgotten memory.
 */
export function restatedValues(
  m: Pick<Memory, 'text' | 'stub' | 'entities' | 'source'>,
  forgotten: Text,
): string[] {
  return restated(forgotten, m);
}

/**
 * Accepts a rewrite only when it can hold nothing new (CON-144): every word of its text and stub
 * is in the old memory or is a connector, its entities are old ones, it is no longer than before,
 * and it holds none of the forgotten memory's values but the shared subject (`subjectOf`). The
 * writer never sees the forgotten memory, and this check keeps a model from adding anything to
 * the store on the way. A rewrite reuses the old words but can still change what they say ("do
 * not" dropped): the caller prints it for the person to read.
 */
function acceptable(forgotten: Text, old: Memory, w: WrittenMemory): boolean {
  const before = tokensOf(old);
  const added = tokenizeLexical(`${w.text} ${w.stub}`).filter(
    (t) => !before.has(t) && !CONNECTORS.has(t) && !URL_PARTS.has(t),
  );
  const oldEntities = new Set(old.entities.map((e) => e.toLowerCase()));
  const values = forgottenValues(forgotten, old);
  const subject = subjectOf(forgotten, old, w);
  const words = wordsOf(w);
  return (
    added.length === 0 &&
    w.entities.every((e) => oldEntities.has(e.toLowerCase())) &&
    w.text.length <= old.text.length &&
    w.stub.length <= Math.max(old.stub.length, 1) &&
    [...values].every((v) => !holds(words, v) || subject.has(v))
  );
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The turn a memory's text was read against: its time and UTC offset (minutes east). */
export interface RewriteTurn {
  at: Date;
  offset: number;
}

/** Where one write's decisions end: the write path's action, or a forget's rewrite. */
const endsWrite = (d: Decision): boolean =>
  (d.stage === 'write' && d.question === 'action') ||
  (d.stage === 'forget' && d.question === 'rewritten');

/**
 * A memory's decisions, one list per write: each ends at a write's end (`endsWrite`), and any
 * decisions after the last end belong to that last write. A refine keeps the decisions of the
 * writes before it, so the first lists describe earlier texts.
 */
function writesOf(m: Memory): Decision[][] {
  const out: Decision[][] = [];
  let cur: Decision[] = [];
  for (const d of m.source.decisions) {
    cur.push(d);
    if (endsWrite(d)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) {
    if (out.length === 0) out.push(cur);
    else out[out.length - 1]!.push(...cur);
  }
  return out;
}

/** The bounds one write recorded reading from its text, in its `temporal/interval` decision. */
function intervalIn(ds: Decision[]): FactInterval | undefined {
  const d = ds.findLast((x) => x.stage === 'temporal' && x.question === 'interval');
  if (d === undefined) return undefined;
  const [from, to] = d.answer.split(' .. ');
  return {
    ...(from !== undefined && from !== 'turn' && { validFrom: from }),
    ...(to !== undefined && to !== 'open' && { validTo: to }),
  };
}

/** The bounds the latest write read from its own text (the text the memory has now). */
function recordedInterval(m: Memory): FactInterval | undefined {
  return intervalIn(writesOf(m).at(-1) ?? []);
}

/**
 * Each bound as the last write that read one from its text recorded it. A write whose text sets
 * no bound carries the earlier one over (a refine, a correction's copy of its prior's end), so
 * the bound still came from an earlier text.
 */
function carriedInterval(m: Memory): FactInterval {
  const out: FactInterval = {};
  for (const w of writesOf(m)) {
    const i = intervalIn(w);
    if (i?.validFrom !== undefined) out.validFrom = i.validFrom;
    if (i?.validTo !== undefined) out.validTo = i.validTo;
  }
  return out;
}

const sameOccurrences = (a: Occurrence[], b: Occurrence[] | undefined): boolean =>
  b !== undefined &&
  a.length === b.length &&
  a.every(
    (o, i) =>
      o.from === b[i]?.from &&
      o.to === b[i]?.to &&
      o.precision === b[i]?.precision &&
      o.source === b[i]?.source,
  );

/** What `factInterval` reads, or nothing when it fails. */
function intervalOf(text: string, turn: RewriteTurn): FactInterval {
  try {
    return factInterval(text, turn.at, turn.offset);
  } catch {
    return {};
  }
}

/**
 * The turn a memory's text was read against, recovered from the day it was said (its `mention`
 * occurrence, which the write path reads from the turn's time and UTC offset).
 *
 * The time is `validFrom` when it lies in that day, else `createdAt` when it does, else the day's
 * noon. The offset is one that makes the day start at midnight. Two offsets 24 hours apart do
 * (UTC-11:00 and UTC+13:00, for example): each one in UTC-12:00 to UTC+14:00 is tried by reading
 * the old text again, and the one that gives back the stored `occurred` (and the bounds the write
 * path recorded, when it recorded any) is taken. When both or neither do, the offset is taken in
 * UTC-10:59 to UTC+13:00, so a turn in UTC-11:00, UTC-12:00, UTC+13:45 or UTC+14:00 whose text
 * states no date that tells them apart reads a day off in name (a date on its own, a month or a
 * weekday then lands 24 hours away, a month and day near the new year a year away).
 *
 * Without a mention, `createdAt` (else `validFrom`) in UTC, as the store migration reads stored
 * text against `created_at`.
 */
export function rewriteTurnOf(m: Memory): RewriteTurn {
  const mention = m.occurred?.find((o) => o.source === 'mention');
  const from = mention === undefined ? NaN : Date.parse(mention.from);
  const to = mention === undefined ? NaN : Date.parse(mention.to);
  if (!Number.isFinite(from) || to - from !== DAY_MS) {
    const made = Date.parse(m.createdAt);
    return { at: new Date(Number.isFinite(made) ? made : Date.parse(m.validFrom)), offset: 0 };
  }
  const inDay = (iso: string): number | undefined => {
    const t = Date.parse(iso);
    return t >= from && t < to ? t : undefined;
  };
  const at = new Date(inDay(m.validFrom) ?? inDay(m.createdAt) ?? from + DAY_MS / 2);
  const east = ((-Math.round(from / MINUTE_MS) % 1440) + 1440) % 1440;
  const usual = east <= 13 * 60 ? east : east - 1440;
  const recorded = recordedInterval(m);
  const fits = (offset: number): boolean => {
    try {
      if (!sameOccurrences(occurrencesOf(m.text, at, offset), m.occurred)) return false;
    } catch {
      return false;
    }
    if (recorded === undefined) return true;
    const read = intervalOf(m.text, { at, offset });
    return read.validFrom === recorded.validFrom && read.validTo === recorded.validTo;
  };
  const matching = [east, east - 1440]
    .filter((o) => o >= -12 * 60 && o <= 14 * 60)
    .filter((o) => fits(o));
  return { at, offset: matching.length === 1 ? (matching[0] as number) : usual };
}

/**
 * A rewritten memory's event time: the dates its new text states, read as the write path reads
 * them (`occurrencesOf`, against the turn it was written in, `rewriteTurnOf`), then the day it
 * was said, kept as it was. A date only the old text stated is gone. Undefined when it had no
 * event time, or when, without a day it was said, the new text states no date. When the reading
 * fails or returns what a store would refuse, only the day it was said is kept, as `observe` keeps
 * it, and nothing when that day is not one a store accepts either.
 */
export function rewrittenOccurred(
  m: Memory,
  text: string,
  turn: RewriteTurn = rewriteTurnOf(m),
): Occurrence[] | undefined {
  if (m.occurred === undefined) return undefined;
  const mention = m.occurred.find((o) => o.source === 'mention');
  const kept = mention === undefined ? [] : [{ ...mention }];
  let out: Occurrence[];
  try {
    const stated = occurrencesOf(text, turn.at, turn.offset).filter((o) => o.source !== 'mention');
    out = checkOccurrences([...stated, ...kept]);
  } catch {
    try {
      out = checkOccurrences(kept);
    } catch {
      out = [];
    }
  }
  return out.length === 0 ? undefined : out;
}

/**
 * Whether a supersede ended `m`, so its end may be where the newer fact starts. A correction
 * leaves its prior's validity as the prior's own: only a supersede sets an end.
 */
const isSuperseded = (m: Memory): boolean =>
  m.endReason === 'superseded' || (m.supersededBy !== null && m.endReason !== 'corrected');

/**
 * A rewritten memory's validity: each bound its old text set is read again from the new text
 * against the same turn. A bound counts as set by the text when it equals what `factInterval`
 * reads from the old text again, or what the last write that recorded one recorded
 * (`carriedInterval`: a refine or a correction that set none carries an earlier text's over). A
 * start the write path moved back a day before that end (`startBefore`) counts too. A bound the
 * new text does not set falls back as the write path's does: the turn's time for `validFrom`,
 * none for `validTo`. The end of a superseded memory is never changed: it may be where the next
 * fact starts. Any other bound is kept, and a start is then moved back before the end as the
 * write path moves it, so the end never comes first. `bounds` is what the new text sets, and
 * `startRead` and `endRead` whether the start and the end were read again.
 */
export function rewrittenValidity(
  m: Memory,
  text: string,
  turn: RewriteTurn = rewriteTurnOf(m),
): {
  validFrom: string;
  validTo: string | null;
  bounds: FactInterval;
  startRead: boolean;
  endRead: boolean;
} {
  const recorded = carriedInterval(m);
  const old = intervalOf(m.text, turn);
  const fromText = (v: string | null, said: string | undefined, read: string | undefined) =>
    v !== null && (v === said || v === read);
  const bounds = intervalOf(text, turn);
  const endFromText = fromText(m.validTo, recorded.validTo, old.validTo);
  const endRead = endFromText && !isSuperseded(m);
  const validTo = endRead ? (bounds.validTo ?? null) : m.validTo;
  const startFromText =
    fromText(m.validFrom, recorded.validFrom, old.validFrom) ||
    (endFromText &&
      m.validFrom ===
        startBefore(recorded.validFrom ?? old.validFrom ?? turn.at.toISOString(), m.validTo));
  const start = startFromText ? (bounds.validFrom ?? turn.at.toISOString()) : m.validFrom;
  return {
    validFrom: startBefore(start, validTo),
    validTo,
    bounds,
    startRead: startFromText,
    endRead,
  };
}

/** Runs `fn` over `items`, at most `limit` at once, results in order. */
async function pooled<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Forgets a memory and takes its values out of the later memories of its supersede chain
 * (CON-144). A memory that superseded or corrected it was written with it as the prior, so its
 * text can restate it ("changed from 3000 to 8080").
 *
 * 1. The forgotten memory's values (`forgottenValues`) are found locally, for each later memory
 *    (created after it, or with a creation time that cannot be compared). Only one that holds a
 *    value, in its text, stub, entities or a wording it keeps, and not as the subject both are
 *    about (`subjectOf`), is rewritten; the rest are left alone. Past the first `MAX_CHAIN`, each
 *    one that holds a value is named instead.
 * 2. The writer (`MemoryWriter.rewriteCurrent`) gets that memory alone, never the forgotten one,
 *    and states its current fact without history. A rewrite is kept only when `acceptable`: no
 *    new words, no longer, none of the values left. Re-embedded, it loses the wordings that
 *    described its old text, and its event time is read again from the new text
 *    (`rewrittenOccurred`): a date only the old text stated is gone, the day it was said stays.
 *    So are the validity bounds its old text set (`rewrittenValidity`). A memory that corrected
 *    it and copied the old start or end, setting none of its own, gets the new one (its validity
 *    only), unless a supersede has ended it since.
 *    One the writer leaves as it was is reported as `unchanged`.
 * 3. The chain is re-linked over the gap, and the rewrites and links land in one guarded write
 *    (`upsertManyIfUnchanged` where the store has it): a memory changed meanwhile is reported
 *    as `changed`. Then the memory is forgotten.
 *
 * Before anything changes, feedback about the memory is removed at every address
 * (`purgeFeedbackFor`; `FeedbackPurgeError` when a row could not be), and predictions that
 * cite a forgotten judgment are purged.
 *
 * Every later memory holding a value that is not rewritten is listed in `notRewritten` with the
 * reason, so the caller can tell the person which ones may still restate it.
 *
 * A judgment is never rewritten, re-embedded or ended here: it is the expert's own words, never
 * written from another memory, and only the judgment commands change it. A supersede link between
 * a judgment and another memory (such as a crafted import could plant) is not a chain: the walk
 * stops at it, the judgment is left exactly as it was, and the re-link over the gap points at
 * nothing past it. Forgetting a judgment re-links the judgments that corrected it, links only.
 */
export async function forgetMemory(
  deps: ForgetDeps,
  grant: Grant,
  id: string,
): Promise<ForgetOutcome> {
  const { store } = deps;
  const target = await store.get(grant, id);
  if (target === null || !grantWrites(grant, target)) {
    return { forgotten: null, rewritten: [], notRewritten: [] };
  }
  const forgotten = (target.tier === 'cold' && (await store.coldGet(grant, id))) || target;
  const iso = (deps.now ?? new Date()).toISOString();
  const outcome: ForgetOutcome = { forgotten: id, rewritten: [], notRewritten: [] };
  // Forget wins: a prediction that cited a forgotten judgment keeps none of its text. First, so a
  // purge that fails leaves the judgment in place for a retry, and before the store's last WAL
  // truncate.
  if (target.type === 'judgment') {
    await purgePredictionsCiting(store, grant, [id], 'forget', deps.now ?? new Date());
  }
  // Feedback about it goes too, at every address (other principals' included), first for the
  // same reason: a purge that fails leaves the memory for a retry.
  await purgeFeedbackFor(store, grant, id);

  // A judgment and another memory never share a chain: a link between them is not followed.
  const apart = (m: Memory) => isJudgment(m) !== isJudgment(target);
  // The memory it superseded, to re-link; it was written before it, so it restates nothing.
  const chain = new Map<string, Memory>();
  const prior = target.supersedes === null ? null : await store.get(grant, target.supersedes);
  if (prior !== null && !apart(prior)) chain.set(prior.id, prior);
  // What the neighbours link to over the gap: never across into a judgment, or out of one.
  const over = {
    supersedes: prior !== null && apart(prior) ? null : target.supersedes,
    supersededBy: target.supersededBy,
  };

  // The later memories, newest last: the first MAX_CHAIN are handled, and every one past them
  // that restates a value is named, never dropped.
  // Only a memory written before it cannot have been written from it. A creation time that is
  // equal, or that does not parse, counts as later.
  const born = Date.parse(target.createdAt);
  const isLater = (m: Memory) => !(Date.parse(m.createdAt) < born);
  const candidates: Memory[] = [];
  const seen = new Set<string>([id]);
  let walked = 0;
  for (let next = target.supersededBy; next !== null && !seen.has(next);) {
    seen.add(next);
    const m = await store.get(grant, next);
    if (m === null) break;
    if (apart(m)) {
      if (next === target.supersededBy) over.supersededBy = null;
      break;
    }
    // A judgment in a chain of judgments is the expert's own words, never written from this one.
    const restates = !isJudgment(m) && isLater(m) && restated(forgotten, m).length > 0;
    if (walked < MAX_CHAIN) {
      chain.set(m.id, m);
      if (restates) candidates.push(m);
    } else if (restates) {
      outcome.notRewritten.push({ id: m.id, reason: 'chain-too-long' });
    }
    walked++;
    next = m.supersededBy;
  }

  const rewrite = deps.write?.rewriteCurrent?.bind(deps.write);
  const results = await pooled(candidates, PARALLEL_REWRITES, async (m) => {
    if (!grantWrites(grant, m)) return { m, reason: 'not-writable' as const };
    if (rewrite === undefined) return { m, reason: 'no-writer' as const };
    try {
      const full = (m.tier === 'cold' && (await store.coldGet(grant, m.id))) || m;
      const w = await rewrite(full);
      const same =
        w.text === full.text &&
        w.stub === full.stub &&
        JSON.stringify(w.entities) === JSON.stringify(full.entities);
      // Left as it was, it still holds a value (it was selected for that): reported.
      if (same) return { m, reason: 'unchanged' as const };
      if (!acceptable(forgotten, full, w)) return { m, reason: 'rejected' as const };
      const embedding =
        deps.embed === undefined ? undefined : (await deps.embed.embed([w.text], 'document'))[0];
      const next: Memory = {
        ...m,
        text: w.text,
        stub: w.stub,
        entities: w.entities,
        tier: m.tier === 'cold' ? 'warm' : m.tier,
        updatedAt: iso,
        source: {
          ...m.source,
          decisions: [...m.source.decisions.filter((d) => !describesOldWording(d)), REWRITTEN],
        },
      };
      // The old vector was computed from the old text: never kept beside the new one.
      delete next.embedding;
      if (embedding !== undefined) next.embedding = embedding;
      // So are its event time and the validity bounds its text set: read again from the new
      // text against the turn it was written in, written in the same guarded write.
      // The live row holds its validity, links, event time and decisions; a cold copy keeps
      // them as they were when it went cold (a supersede since writes only the live row). Only
      // the words come from the cold copy, as the writer read them.
      const live: Memory = { ...m, text: full.text, stub: full.stub, entities: full.entities };
      const turn = rewriteTurnOf(live);
      const occurred = rewrittenOccurred(live, w.text, turn);
      delete next.occurred;
      if (occurred !== undefined) next.occurred = occurred;
      const validity = rewrittenValidity(live, w.text, turn);
      next.validFrom = validity.validFrom;
      next.validTo = validity.validTo;
      if (validity.bounds.validFrom !== undefined || validity.bounds.validTo !== undefined) {
        next.source.decisions.splice(-1, 0, {
          stage: 'temporal',
          question: 'interval',
          answer: `${validity.bounds.validFrom ?? 'turn'} .. ${validity.bounds.validTo ?? 'open'}`,
          probability: 1,
        });
      }
      // A new start or end replaces the old one in the memories that corrected it and copied it.
      const ends =
        validity.endRead && validity.validTo !== live.validTo
          ? { from: live.validTo, to: validity.validTo }
          : undefined;
      const starts =
        validity.startRead && validity.validFrom !== live.validFrom
          ? { from: live.validFrom, to: validity.validFrom }
          : undefined;
      return { m, next, starts, ends };
    } catch {
      return { m, reason: 'failed' as const };
    }
  });

  const changed = new Map<string, { next: Memory; was: Memory }>();
  for (const r of results) {
    if ('next' in r && r.next !== undefined) changed.set(r.m.id, { next: r.next, was: r.m });
    else if ('reason' in r) outcome.notRewritten.push({ id: r.m.id, reason: r.reason });
  }

  // A correction copies its prior's start and end when its own text sets none (`observe`'s
  // CORRECT), so a rewrite that reads a new one for the prior gives it to each correction down
  // the chain that still holds the old one: its validity only, no new text and no new vector, in
  // the same guarded write. A correction a supersede has ended since is left as it is (its end
  // may be where the newer fact starts), and the walk stops there.
  const corrections = new Set<string>();
  const listed = (cid: string) => outcome.notRewritten.some((x) => x.id === cid);
  for (const r of results) {
    if (!('next' in r) || (r.starts === undefined && r.ends === undefined)) continue;
    let { starts, ends } = r;
    let prior: Memory = r.m;
    const walkedCorrections = new Set<string>([prior.id]);
    while (prior.endReason === 'corrected' && prior.supersededBy !== null) {
      const cid = prior.supersededBy;
      if (walkedCorrections.has(cid) || cid === id) break;
      walkedCorrections.add(cid);
      const c = chain.get(cid) ?? (await store.get(grant, cid));
      if (c === null || isJudgment(c) || isSuperseded(c)) break;
      const own = carriedInterval(c);
      const takesEnd = ends !== undefined && own.validTo === undefined && c.validTo === ends.from;
      const takesStart =
        starts !== undefined &&
        own.validFrom === undefined &&
        (c.validFrom === starts.from || c.validFrom === startBefore(starts.from, c.validTo));
      if (!takesStart && !takesEnd) break;
      // A correction that kept a bound (its own text set it, or it no longer holds the old one)
      // is what later corrections copied: that bound is carried no further.
      if (!takesStart) starts = undefined;
      if (!takesEnd) ends = undefined;
      if (!grantWrites(grant, c)) {
        if (!listed(c.id)) outcome.notRewritten.push({ id: c.id, reason: 'not-writable' });
        break;
      }
      const base = changed.get(c.id)?.next ?? c;
      const validTo = ends !== undefined ? ends.to : base.validTo;
      const validFrom = startBefore(starts !== undefined ? starts.to : base.validFrom, validTo);
      changed.set(c.id, {
        was: changed.get(c.id)?.was ?? c,
        next: { ...base, validFrom, validTo, updatedAt: iso },
      });
      corrections.add(c.id);
      prior = c;
    }
  }

  // Re-link the neighbours over the gap. One the grant cannot change keeps its link to the
  // missing row, which readers of the chain stop at.
  for (const m of chain.values()) {
    if (m.supersedes !== id && m.supersededBy !== id) continue;
    if (!grantWrites(grant, m)) continue;
    const base = changed.get(m.id)?.next ?? m;
    changed.set(m.id, {
      was: m,
      next: {
        ...base,
        ...(m.supersedes === id && { supersedes: over.supersedes }),
        ...(m.supersededBy === id && { supersededBy: over.supersededBy }),
        updatedAt: iso,
      },
    });
  }

  if (changed.size > 0) {
    const writes = [...changed.values()];
    let skipped: string[];
    if (store.upsertManyIfUnchanged !== undefined) {
      skipped = (await store.upsertManyIfUnchanged(grant, writes)).skipped;
    } else {
      // A store without the guarded write: compare just before writing (a narrow window).
      const fresh = await Promise.all(writes.map((x) => store.get(grant, x.was.id)));
      const ok = writes.filter((x, i) => fresh[i]?.updatedAt === x.was.updatedAt);
      skipped = writes.filter((x) => !ok.includes(x)).map((x) => x.was.id);
      if (ok.length > 0)
        await store.upsertMany(
          grant,
          ok.map((x) => x.next),
        );
    }
    for (const sid of skipped) {
      const i = outcome.notRewritten.findIndex((x) => x.id === sid);
      if (i >= 0) outcome.notRewritten.splice(i, 1);
      // A link-only write that lost the race is not a restatement: the next forget finds no row.
      if (candidates.some((c) => c.id === sid) || corrections.has(sid)) {
        outcome.notRewritten.push({ id: sid, reason: 'changed' });
      }
    }
    for (const r of results) {
      if ('next' in r && r.next !== undefined && !skipped.includes(r.m.id)) {
        outcome.rewritten.push({ id: r.m.id, text: r.next.text });
      }
    }
  }
  await store.forget(grant, id);
  return outcome;
}
