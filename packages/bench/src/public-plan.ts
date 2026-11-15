/**
 * `--plan` for the public sets (CON-147): what a run with a paid embedder or reranker would send,
 * computed without calling anything, so the cost is known before anyone runs it.
 *
 * Exact: the number of document texts (each turn's text as `observe` embeds it, deduplicated
 * across haystacks, minus any already in the embedding cache), the requests they take in batches
 * of 128, and their characters. Tokens are counted with the provider's published tokenizer when it
 * is in the cache (`--tokenizer`), else estimated at 4 characters each and labelled so.
 *
 * Upper bounds: query embeddings (one per question; recall skips some when its lexical search is
 * already sure) and rerank calls (one per question, each with at most `rerankK` documents; recall
 * skips some when fusion is confident), for each run that reranks (a `fast` run does not). The
 * rerank bound assumes every call carries that haystack's longest documents.
 *
 * With `--entities writer`: one writer call per distinct turn text not yet in the entity cache,
 * and the characters they carry. Tokens there are estimated at 4 characters each (the writer's
 * tokenizer is not published), before the writer's own instructions, and not priced here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { truncateUtf8 } from '@oortmem/core';
import { embedTextOf, type PublicSet } from './public-sets.js';
import { turnText } from './verbatim.js';

/** The adapters' byte caps (`@oortmem/embed-voyage`, `@oortmem/rerank-voyage`). */
const EMBED_INPUT_MAX_BYTES = 8 * 1024;
const RERANK_QUERY_MAX_BYTES = 2 * 1024;
const RERANK_DOC_MAX_BYTES = 4 * 1024;
const EMBED_BATCH = 128;

/** List prices in US dollars per million tokens (docs.voyageai.com/docs/pricing, 2026-11-12). */
export const PRICE_PER_MTOK: Record<string, number> = {
  'voyage-3.5-lite': 0.02,
  'rerank-3-lite': 0.02,
};

export type TokenCounter = { exact: boolean; count(text: string): number };

export const estimateTokens: TokenCounter = { exact: false, count: (t) => Math.ceil(t.length / 4) };

/** A counter over a Hugging Face `tokenizer.json` (Voyage publishes theirs; see eval/public/README.md). */
export async function tokenizerCounter(dir: string): Promise<TokenCounter> {
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const read = (name: string): object =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as object;
  const t = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'));
  return {
    exact: true,
    count: (text) => t.encode(text, { add_special_tokens: false }).ids.length,
  };
}

export interface PublicPlan {
  set: string;
  haystacks: number;
  turns: number;
  questions: number;
  tokensExact: boolean;
  embed?: {
    model: string;
    documents: { texts: number; cached: number; requests: number; chars: number; tokens: number };
    /** Upper bound: one request per question. */
    queries: { requests: number; tokens: number };
    usd: number;
  };
  rerank?: {
    model: string;
    /** Upper bound: one call per question per run that reranks. */
    calls: number;
    /** Runs that rerank (each links mode at speed `full`). */
    runs: number;
    documentsPerCall: number;
    tokens: number;
    usd: number;
  };
  writer?: {
    model: string;
    /** Distinct turn texts, and those already in the entity cache. */
    texts: number;
    cached: number;
    /** One call per uncached text. */
    calls: number;
    chars: number;
    /** Estimated at 4 characters each, without the writer's instructions. */
    tokens: number;
  };
}

export function planPublicSet(
  set: PublicSet,
  opts: {
    embedModel?: string;
    rerankModel?: string;
    rerankK: number;
    tokens: TokenCounter;
    /** True when the embedding cache already holds this document text. */
    cached?: (text: string) => boolean;
    /** Runs that rerank (default 1). */
    rerankRuns?: number;
    /** The writer model asked for entities (`--entities writer`). */
    writerModel?: string;
    /** True when the entity cache already holds this turn text. */
    writerCached?: (text: string) => boolean;
  },
): PublicPlan {
  const questions = set.haystacks.reduce((n, h) => n + h.questions.length, 0);
  const plan: PublicPlan = {
    set: set.name,
    haystacks: set.haystacks.length,
    turns: set.haystacks.reduce((n, h) => n + h.turns.length, 0),
    questions,
    tokensExact: opts.tokens.exact,
  };
  const count = new Map<string, number>();
  const tokensOf = (text: string): number => {
    let n = count.get(text);
    if (n === undefined) {
      n = opts.tokens.count(text);
      count.set(text, n);
    }
    return n;
  };
  if (opts.embedModel !== undefined) {
    const unique = [
      ...new Set(set.haystacks.flatMap((h) => h.turns.flatMap((t) => embedTextOf(t) ?? []))),
    ];
    const todo = unique.filter((t) => opts.cached?.(t) !== true);
    const sent = todo.map((t) => truncateUtf8(t, EMBED_INPUT_MAX_BYTES));
    const docTokens = sent.reduce((n, t) => n + tokensOf(t), 0);
    const queryTokens = set.haystacks
      .flatMap((h) => h.questions)
      .reduce((n, q) => n + tokensOf(q.question), 0);
    plan.embed = {
      model: opts.embedModel,
      documents: {
        texts: unique.length,
        cached: unique.length - todo.length,
        requests: Math.ceil(todo.length / EMBED_BATCH),
        chars: sent.reduce((n, t) => n + t.length, 0),
        tokens: docTokens,
      },
      queries: { requests: questions, tokens: queryTokens },
      usd: ((docTokens + queryTokens) / 1e6) * (PRICE_PER_MTOK[opts.embedModel] ?? Number.NaN),
    };
  }
  const runs = opts.rerankRuns ?? 1;
  if (opts.rerankModel !== undefined && runs > 0) {
    let tokens = 0;
    let perCall = 0;
    for (const h of set.haystacks) {
      const docs = h.turns
        .map((t) =>
          tokensOf(truncateUtf8(turnText({ ...t, toolSummaries: [] }), RERANK_DOC_MAX_BYTES)),
        )
        .sort((a, b) => b - a)
        .slice(0, opts.rerankK);
      perCall = Math.max(perCall, docs.length);
      const docSum = docs.reduce((a, b) => a + b, 0);
      for (const q of h.questions) {
        const qt = tokensOf(truncateUtf8(q.question, RERANK_QUERY_MAX_BYTES));
        tokens += qt * docs.length + docSum;
      }
    }
    tokens *= runs;
    plan.rerank = {
      model: opts.rerankModel,
      calls: questions * runs,
      runs,
      documentsPerCall: perCall,
      tokens,
      usd: (tokens / 1e6) * (PRICE_PER_MTOK[opts.rerankModel] ?? Number.NaN),
    };
  }
  if (opts.writerModel !== undefined) {
    const unique = [
      ...new Set(set.haystacks.flatMap((h) => h.turns.flatMap((t) => embedTextOf(t) ?? []))),
    ];
    const todo = unique.filter((t) => opts.writerCached?.(t) !== true);
    const chars = todo.reduce((n, t) => n + t.length, 0);
    plan.writer = {
      model: opts.writerModel,
      texts: unique.length,
      cached: unique.length - todo.length,
      calls: todo.length,
      chars,
      tokens: todo.reduce((n, t) => n + estimateTokens.count(t), 0),
    };
  }
  return plan;
}

const n = (x: number): string => x.toLocaleString('en-US');
/** Dollars: cents for a dollar or more, four places below (these runs cost fractions of a cent). */
const usd = (x: number): string => x.toFixed(x >= 1 ? 2 : 4);

export function renderPlan(p: PublicPlan): string {
  const tok = p.tokensExact ? 'tokens' : 'tokens (estimated at 4 chars each: no tokenizer)';
  const lines = [
    `Plan for ${p.set}: ${n(p.haystacks)} haystacks, ${n(p.turns)} turns, ${n(p.questions)} questions. Nothing was sent.`,
    '',
  ];
  if (p.embed !== undefined) {
    const d = p.embed.documents;
    lines.push(
      `Embed (${p.embed.model}): ${n(d.texts)} distinct turn texts, ${n(d.cached)} already cached; ${n(d.requests)} requests of up to 128, ${n(d.chars)} chars, ${n(d.tokens)} ${tok}.`,
      `  Queries, at most: ${n(p.embed.queries.requests)} requests, ${n(p.embed.queries.tokens)} ${tok}.`,
      `  Cost at list price, at most: $${usd(p.embed.usd)}.`,
    );
  }
  if (p.rerank !== undefined) {
    lines.push(
      `Rerank (${p.rerank.model}), at most: ${n(p.rerank.calls)} calls (${n(p.rerank.runs)} run(s) that rerank) of up to ${p.rerank.documentsPerCall} documents, ${n(p.rerank.tokens)} ${tok} (query tokens x documents + document tokens).`,
      `  Cost at list price, at most: $${usd(p.rerank.usd)}.`,
    );
  }
  if (p.writer !== undefined) {
    const w = p.writer;
    lines.push(
      `Entities (writer ${w.model}): ${n(w.texts)} distinct turn texts, ${n(w.cached)} already cached; ${n(w.calls)} writer calls, ${n(w.chars)} chars, about ${n(w.tokens)} input tokens (estimated at 4 chars each) plus the writer's instructions on every call, and its output.`,
      `  Not priced here: see the model provider's price list.`,
    );
  }
  if (p.embed === undefined && p.rerank === undefined && p.writer === undefined) {
    lines.push(
      'No paid model is configured (--embed voyage, --rerank voyage or --entities writer): this run is free.',
    );
  }
  return lines.join('\n');
}
