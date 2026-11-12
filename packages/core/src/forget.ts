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
 * - `chain-too-long`: it lies past the first `MAX_CHAIN` memories of the chain, unread.
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

/** How many memories of the chain are read, either way; supersede chains are short. */
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

/**
 * The tokens of `m` that name a value rather than the thing it is about (CON-144): numbers,
 * versions, identifiers (`auth-service`, `foo_bar`, `api.example.com`), the pieces of a path or a
 * URL, and names written with a capital other than at the start of a sentence (`MySQL`,
 * `Postgres`). Lower-cased, in `tokenizeLexical`'s form so they compare with any memory's tokens.
 * Plain lower-case words are left out: a memory and the one that superseded it share the words
 * for what they are about, so those cannot tell a restated value from the subject.
 */
export function distinctiveTokens(m: Pick<Memory, 'text' | 'stub' | 'entities'>): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    for (const t of tokenizeLexical(s)) if (!STOPWORDS.has(t)) out.add(t);
  };
  for (const field of [m.text, m.stub, ...m.entities]) {
    const words = field.split(/\s+/).filter((w) => w !== '');
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}\p{N}/~]+|[^\p{L}\p{N}]+$/gu, '');
      if (w === '') return;
      const sentenceStart = i === 0 || /[.!?:]["')\]]*$/.test(words[i - 1] ?? '');
      if (
        /\p{N}/u.test(w) ||
        /[\p{L}\p{N}][._\-@#:/\\][\p{L}\p{N}]/u.test(w) ||
        /^[/~]/.test(w) ||
        /\p{Ll}\p{Lu}/u.test(w) ||
        /^\p{Lu}{2,}$/u.test(w) ||
        (!sentenceStart && /^\p{Lu}/u.test(w))
      ) {
        add(w);
      }
    });
  }
  return out;
}

/** Every token of `m`'s text, stub and entities. */
function tokensOf(m: Pick<Memory, 'text' | 'stub' | 'entities'>): Set<string> {
  return new Set(tokenizeLexical([m.text, m.stub, ...m.entities].join(' ')));
}

/**
 * The values of `forgotten` (`distinctiveTokens`) that `m` restates, in its text, stub, entities
 * or a wording it keeps; empty when it restates none. For callers that cannot rewrite (Oort
 * Cloud) and still must name what may repeat a forgotten memory.
 */
export function restatedValues(
  m: Pick<Memory, 'text' | 'stub' | 'entities' | 'source'>,
  forgotten: Pick<Memory, 'text' | 'stub' | 'entities'>,
): string[] {
  return restated(m, distinctiveTokens(forgotten));
}

/** The distinctive tokens of `forgotten` that `m` (with the wordings it keeps) still holds. */
function restated(
  m: Pick<Memory, 'text' | 'stub' | 'entities' | 'source'>,
  values: Set<string>,
): string[] {
  const kept = m.source.decisions.filter(describesOldWording).map((d) => d.answer);
  const tokens = tokensOf({ ...m, entities: [...m.entities, ...kept] });
  return [...values].filter((t) => tokens.has(t));
}

/**
 * What the memories are about, as opposed to a value: the names without a digit that the
 * forgotten memory, the later one and its rewrite all list as entities (`auth-service` in
 * "auth-service listens on 5582" and "auth-service port changed from 5582 to 6000"). The current
 * fact keeps them. A number, version, path or URL is never one.
 */
function subjectTokens(...ms: Pick<Memory, 'entities'>[]): Set<string> {
  const [first, ...rest] = ms.map((m) => new Set(m.entities.map((e) => e.toLowerCase())));
  const out = new Set<string>();
  for (const e of first ?? []) {
    if (/\p{N}/u.test(e) || /[/\\]/.test(e) || !rest.every((r) => r.has(e))) continue;
    for (const t of tokenizeLexical(e)) out.add(t);
  }
  return out;
}

/**
 * Accepts a rewrite only when it can hold nothing new (CON-144): every word of its text and stub
 * is in the old memory or is a connector, its entities are old ones, it is no longer than before,
 * and it holds none of the forgotten memory's values but the shared subject (`subjectTokens`).
 * The writer never sees the forgotten memory, and this check keeps a model from adding anything
 * to the store on the way.
 */
function acceptable(
  forgotten: Memory,
  old: Memory,
  w: WrittenMemory,
  values: Set<string>,
): boolean {
  const before = tokensOf(old);
  const added = tokenizeLexical(`${w.text} ${w.stub}`).filter(
    (t) => !before.has(t) && !CONNECTORS.has(t),
  );
  const oldEntities = new Set(old.entities.map((e) => e.toLowerCase()));
  const subject = subjectTokens(forgotten, old, w);
  return (
    added.length === 0 &&
    w.entities.every((e) => oldEntities.has(e.toLowerCase())) &&
    w.text.length <= old.text.length &&
    w.stub.length <= Math.max(old.stub.length, 1) &&
    [...tokensOf(w)].every((t) => !values.has(t) || subject.has(t))
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
 * 1. The forgotten memory's values (`distinctiveTokens`) are found locally. Only a later memory
 *    (created after it, or with a creation time that cannot be compared) that holds one of them,
 *    in its text, stub, entities or a wording it keeps, is rewritten; the rest are left alone.
 * 2. The writer (`MemoryWriter.rewriteCurrent`) gets that memory alone, never the forgotten one,
 *    and states its current fact without history. A rewrite is kept only when `acceptable`: no
 *    new words, no longer, none of the values left but the subject both name as an entity
 *    (`subjectTokens`). Re-embedded, it loses the wordings that described its old text. One the
 *    writer leaves as it was, sharing only that subject, restated nothing and is not reported.
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
  const values = distinctiveTokens(forgotten);
  const iso = (deps.now ?? new Date()).toISOString();
  const outcome: ForgetOutcome = { forgotten: id, rewritten: [], notRewritten: [] };

  // The chain both ways, as far as the grant reads. Ids past the cap are reported, never dropped.
  const chain = new Map<string, Memory>();
  const queue = [target.supersedes, target.supersededBy];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === null || next === undefined || seen.has(next)) continue;
    seen.add(next);
    if (chain.size >= MAX_CHAIN) {
      outcome.notRewritten.push({ id: next, reason: 'chain-too-long' });
      continue;
    }
    const m = await store.get(grant, next);
    if (m === null) continue;
    chain.set(next, m);
    queue.push(m.supersedes, m.supersededBy);
  }

  // Only a memory written before it cannot have been written from it. A creation time that is
  // equal, or that does not parse, counts as later.
  const born = Date.parse(target.createdAt);
  const later = (m: Memory) => !(Date.parse(m.createdAt) < born);
  const candidates = [...chain.values()].filter((m) => later(m) && restated(m, values).length > 0);

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
      if (same) {
        // Left as it was, it restates nothing when all it shares is what both are about.
        const subject = subjectTokens(forgotten, full);
        if (restated(full, values).every((t) => subject.has(t)))
          return { m, reason: 'none' as const };
        return { m, reason: 'unchanged' as const };
      }
      if (!acceptable(forgotten, full, w, values)) return { m, reason: 'rejected' as const };
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
    else if ('reason' in r && r.reason !== 'none') {
      outcome.notRewritten.push({ id: r.m.id, reason: r.reason });
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
