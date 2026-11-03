import { MissingCredentialError, type Reranker } from '@oortmem/core';
import { VoyageError, postJson } from './http.js';

export { VoyageError, type VoyageErrorKind } from './http.js';

const URL = 'https://api.voyageai.com/v1/rerank';

export interface VoyageRerankerOptions {
  /** Defaults to `process.env.VOYAGE_API_KEY`. */
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
}

export function voyageReranker(opts: VoyageRerankerOptions): Reranker {
  const apiKey = opts.apiKey ?? process.env['VOYAGE_API_KEY'];
  if (!apiKey) throw new MissingCredentialError('VOYAGE_API_KEY', 'rerank.apiKey');
  const doFetch = opts.fetch ?? globalThis.fetch;

  return {
    async rerank(query, docs, topK) {
      if (docs.length === 0) return [];
      const res = (await postJson(doFetch, URL, apiKey, {
        query,
        documents: docs.map((d) => d.text),
        model: opts.model,
        top_k: topK,
        truncation: true,
      })) as { data?: { index: number; relevance_score: number }[] } | null;
      const data = res?.data;
      if (!Array.isArray(data)) {
        throw new VoyageError('bad-response', 'Voyage returned an unexpected rerank response');
      }
      const out: { id: string; score: number }[] = [];
      for (const r of data) {
        const doc = docs[r.index];
        if (doc === undefined || typeof r.relevance_score !== 'number') {
          throw new VoyageError('bad-response', 'Voyage returned an invalid rerank result');
        }
        out.push({ id: doc.id, score: r.relevance_score });
      }
      return out.sort((a, b) => b.score - a.score);
    },
  };
}
