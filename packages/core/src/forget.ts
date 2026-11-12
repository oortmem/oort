import type { Embedder, MemoryStore, MemoryWriter } from './adapters.js';
import { grantWrites, type Grant } from './grant.js';
import type { Decision, Memory } from './model.js';

export interface ForgetDeps {
  store: MemoryStore;
  /** Rewrites the memories written from the forgotten one; without it they are reported. */
  write?: MemoryWriter;
  /** Embeds a rewritten memory; without it the rewrite is kept without a vector. */
  embed?: Embedder;
  now?: Date;
}

/** Why a memory written from the forgotten one was left as it was. */
export type NotRewrittenReason = 'no-writer' | 'failed' | 'not-writable';

export interface ForgetOutcome {
  /** The id forgotten; null for an unknown id or one outside the grant (nothing was changed). */
  forgotten: string | null;
  /** The memories written from it, rewritten without what it said, with their new text. */
  rewritten: { id: string; text: string }[];
  /** The memories written from it that were left as they were: they may still repeat it. */
  notRewritten: { id: string; reason: NotRewrittenReason }[];
}

/** How far the chain walk goes either way; supersede chains are short. */
const MAX_CHAIN = 64;

const REWRITTEN: Decision = {
  stage: 'forget',
  question: 'rewritten',
  answer: 'without a forgotten memory',
  probability: 1,
};

/** A refine keeps the wording it replaced; that wording may restate the forgotten value. */
const isPreviousText = (d: Decision): boolean =>
  d.stage === 'refine' && d.question === 'previous-text';

/**
 * Forgets a memory and what was written from it (CON-144). A memory that superseded or
 * corrected it was written with it as the prior, so its text can restate it ("changed from 3000
 * to 8080"). Each memory of its supersede chain written after it is rewritten by the writer
 * (`MemoryWriter.rewriteWithout`), re-embedded, and loses the earlier wordings a refine kept.
 * That happens now, while the forgotten text is still in hand: keeping it for later would keep
 * what was forgotten. The chain is re-linked over the gap (its predecessor and successor point at
 * each other), then the memory is forgotten.
 *
 * A memory that could not be rewritten (no writer, a failed call, outside the grant) is listed in
 * `notRewritten` and left as it was, so the caller can tell the person which ones may still
 * repeat it. The rewrites land in one atomic write before the forget, so a failure leaves the
 * memory in place.
 */
export async function forgetMemory(
  deps: ForgetDeps,
  grant: Grant,
  id: string,
): Promise<ForgetOutcome> {
  const { store } = deps;
  const none: ForgetOutcome = { forgotten: null, rewritten: [], notRewritten: [] };
  const target = await store.get(grant, id);
  if (target === null || !grantWrites(grant, target)) return none;
  const forgotten = (target.tier === 'cold' && (await store.coldGet(grant, id))) || target;
  const iso = (deps.now ?? new Date()).toISOString();

  // The chain both ways, as far as the grant reads.
  const chain = new Map<string, Memory>();
  const queue = [target.supersedes, target.supersededBy];
  while (queue.length > 0 && chain.size < MAX_CHAIN) {
    const next = queue.shift();
    if (next === null || next === undefined || next === id || chain.has(next)) continue;
    const m = await store.get(grant, next);
    if (m === null) continue;
    chain.set(next, m);
    queue.push(m.supersedes, m.supersededBy);
  }

  const changed = new Map<string, Memory>();
  const outcome: ForgetOutcome = { forgotten: id, rewritten: [], notRewritten: [] };
  const born = Date.parse(target.createdAt);
  for (const m of chain.values()) {
    // Written before it existed: it cannot have been written from it.
    if (!(Date.parse(m.createdAt) > born)) continue;
    if (!grantWrites(grant, m)) {
      outcome.notRewritten.push({ id: m.id, reason: 'not-writable' });
      continue;
    }
    const rewrite = deps.write?.rewriteWithout?.bind(deps.write);
    if (rewrite === undefined) {
      outcome.notRewritten.push({ id: m.id, reason: 'no-writer' });
      continue;
    }
    const full = (m.tier === 'cold' && (await store.coldGet(grant, m.id))) || m;
    let next: Memory;
    try {
      const w = await rewrite(full, forgotten);
      const same =
        w.text === full.text &&
        w.stub === full.stub &&
        JSON.stringify(w.entities) === JSON.stringify(full.entities);
      if (same) continue;
      const embedding =
        deps.embed === undefined ? undefined : (await deps.embed.embed([w.text], 'document'))[0];
      next = {
        ...m,
        text: w.text,
        stub: w.stub,
        entities: w.entities,
        tier: m.tier === 'cold' ? 'warm' : m.tier,
        updatedAt: iso,
        source: {
          ...m.source,
          decisions: [...m.source.decisions.filter((d) => !isPreviousText(d)), REWRITTEN],
        },
      };
      // The old vector was computed from the old text: never kept beside the new one.
      delete next.embedding;
      if (embedding !== undefined) next.embedding = embedding;
    } catch {
      outcome.notRewritten.push({ id: m.id, reason: 'failed' });
      continue;
    }
    changed.set(m.id, next);
    outcome.rewritten.push({ id: m.id, text: next.text });
  }

  // Re-link the neighbours over the gap. One the grant cannot change keeps its link to the
  // missing row, which readers of the chain stop at.
  for (const m of chain.values()) {
    if (m.supersedes !== id && m.supersededBy !== id) continue;
    if (!grantWrites(grant, m)) continue;
    const base = changed.get(m.id) ?? m;
    changed.set(m.id, {
      ...base,
      ...(m.supersedes === id && { supersedes: target.supersedes }),
      ...(m.supersededBy === id && { supersededBy: target.supersededBy }),
      updatedAt: iso,
    });
  }

  if (changed.size > 0) await store.upsertMany(grant, [...changed.values()]);
  await store.forget(grant, id);
  return outcome;
}
