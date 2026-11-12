import type { Embedder, MemoryStore, MemoryWriter, WrittenMemory } from './adapters.js';
import { grantWrites, type Grant } from './grant.js';
import type { Decision, Memory } from './model.js';
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
  for (const m of s.matchAll(
    /(?:[a-z][a-z0-9+.-]*:\/\/|[/~])?[\p{L}\p{N}][^\s,;!?()[\]{}"'<>`]*/giu,
  )) {
    const w = m[0].replace(/[.:]+$/u, '').toLowerCase();
    if (w !== '') out.push(w);
  }
  return out;
}

/** Every word of a memory's text, stub and entities, and each entity whole. */
function wordsOf(m: Text): Set<string> {
  return new Set([
    ...wordsIn(`${m.text} ${m.stub} ${m.entities.join(' ')}`),
    ...m.entities.map((e) => e.toLowerCase()),
  ]);
}

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
 * - A number or version, an identifier, a path or a URL (`STRONG`).
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
  return [...values].filter((v) => words.has(v) && !subject.has(v));
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
    (t) => !before.has(t) && !CONNECTORS.has(t),
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
    [...values].every((v) => !words.has(v) || subject.has(v))
  );
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
 *    described its old text. One the writer leaves as it was is reported as `unchanged`.
 * 3. The chain is re-linked over the gap, and the rewrites and links land in one guarded write
 *    (`upsertManyIfUnchanged` where the store has it): a memory changed meanwhile is reported
 *    as `changed`. Then the memory is forgotten.
 *
 * Every later memory holding a value that is not rewritten is listed in `notRewritten` with the
 * reason, so the caller can tell the person which ones may still restate it.
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

  // The memory it superseded, to re-link; it was written before it, so it restates nothing.
  const chain = new Map<string, Memory>();
  const prior = target.supersedes === null ? null : await store.get(grant, target.supersedes);
  if (prior !== null) chain.set(prior.id, prior);

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
    const restates = isLater(m) && restated(forgotten, m).length > 0;
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
      return { m, next };
    } catch {
      return { m, reason: 'failed' as const };
    }
  });

  const changed = new Map<string, { next: Memory; was: Memory }>();
  for (const r of results) {
    if ('next' in r && r.next !== undefined) changed.set(r.m.id, { next: r.next, was: r.m });
    else if ('reason' in r) outcome.notRewritten.push({ id: r.m.id, reason: r.reason });
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
        ...(m.supersedes === id && { supersedes: target.supersedes }),
        ...(m.supersededBy === id && { supersededBy: target.supersededBy }),
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
      if (candidates.some((c) => c.id === sid)) {
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
