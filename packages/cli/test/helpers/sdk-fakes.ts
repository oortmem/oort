import { createHash } from 'node:crypto';
import type { DecisionController, Embedder, MemoryWriter, Reranker } from '@oortmem/core';

/**
 * Deterministic model fakes for the SDK and its contract suite (CON-108 §10.2): a hash embedder,
 * a rule-based decider and an echo writer. Real models are never called.
 */

/** The store's default dimension (the config's `embed.dimension`). */
export const FAKE_DIMENSION = 512;

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/** Each word sets a few hashed dimensions: texts that share words are close in cosine. */
export function hashEmbedder(dimension = FAKE_DIMENSION): Embedder {
  return {
    dimension,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Int8Array(dimension);
        for (const w of words(t)) {
          const h = createHash('sha256').update(w).digest();
          for (let i = 0; i < 3; i++) {
            const at = h.readUInt16BE(i * 2) % dimension;
            v[at] = Math.min(127, (v[at] ?? 0) + 40);
          }
        }
        if (v.every((x) => x === 0)) v[0] = 1;
        return v;
      });
    },
  };
}

/** Keeps the fused order, scored by position. */
export const orderReranker: Reranker = {
  async rerank(_query, docs) {
    return docs.map((d, i) => ({ id: d.id, score: 0.9 - i * 0.001 }));
  },
};

/**
 * Stores a turn unless it is small talk (`hello`, `thanks`); always adds (no reconcile against
 * candidates, so a test's writes are predictable); judges by the precedents' majority verdict.
 */
export const ruleDecider: DecisionController = {
  async gate(obs) {
    const chat = /^(hello|hi|thanks|thank you)\b/i.test(obs.userText.trim());
    return {
      shouldStore: chat ? 0.1 : 0.9,
      salience: 0.5,
      types: { semantic: 1 },
      decisions: [
        {
          stage: 'gate',
          question: 'store?',
          answer: chat ? 'no' : 'yes',
          probability: chat ? 0.1 : 0.9,
        },
      ],
    };
  },
  async reconcile() {
    return [{ candidateId: null, action: 'ADD', probability: 0.9, decisions: [] }];
  },
  async judge(req) {
    const votes = new Map<string, number>();
    for (const p of req.precedents)
      votes.set(p.verdict, (votes.get(p.verdict) ?? 0) + p.similarity);
    const total = [...votes.values()].reduce((a, b) => a + b, 0) || 1;
    const probabilities = Object.fromEntries(
      req.verdicts.map((v) => [v, (votes.get(v) ?? 0) / total]),
    );
    const [verdict = req.verdicts[0]!, weight = 0] =
      [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    return { verdict, probability: weight / total, probabilities, decisions: [] };
  },
};

/** Writes the user's words as the memory, typed as the remember hint says. */
export const echoWriter: MemoryWriter = {
  async write(obs) {
    const text = obs.userText.replace(/^Remember this(?: \(a (\w+) fact\))?: /, '');
    const type = /^Remember this \(a (\w+) fact\)/.exec(obs.userText)?.[1];
    return {
      text,
      stub: text.slice(0, 40),
      entities: [],
      type: (type ?? 'semantic') as 'semantic',
    };
  },
};

/** All four adapters, for `createOortWith(…, { adapters })`. */
export const fakeAdapters = (): {
  embed: Embedder;
  rerank: Reranker;
  decide: DecisionController;
  write: MemoryWriter;
} => ({ embed: hashEmbedder(), rerank: orderReranker, decide: ruleDecider, write: echoWriter });
