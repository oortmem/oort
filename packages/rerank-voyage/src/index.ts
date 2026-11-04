import { MissingCredentialError, type Reranker } from '@oortmem/core';
import { VoyageError, postJson } from './http.js';

export { VoyageError, type VoyageErrorKind } from './http.js';

/** The Voyage API root; the Oort Pro relay serves the same routes under its own root. */
export const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

export interface VoyageRerankerOptions {
  /** Defaults to `process.env.VOYAGE_API_KEY`. */
  apiKey?: string;
  model: string;
  /**
   * API root, default `VOYAGE_BASE_URL`. The Oort Pro relay is
   * `https://relay.oortcloud.dev/v1/voyage` (with an Oort key as `apiKey`, sent as
   * `Authorization: Bearer`, as Voyage expects too).
   */
  baseUrl?: string;
  /**
   * `baseUrl` is the Oort Pro relay: a 429 without `Retry-After` (the monthly cap) is not
   * retried, and the relay's message is kept on the error as `relayMessage`.
   */
  relay?: boolean;
  fetch?: typeof fetch;
}

export function voyageReranker(opts: VoyageRerankerOptions): Reranker {
  const apiKey = opts.apiKey ?? process.env['VOYAGE_API_KEY'];
  if (!apiKey) throw new MissingCredentialError('VOYAGE_API_KEY', 'rerank.apiKey');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const post = { relay: opts.relay === true };
  const endpoint = `${(opts.baseUrl ?? VOYAGE_BASE_URL).replace(/\/+$/, '')}/rerank`;

  return {
    async rerank(query, docs, topK) {
      if (docs.length === 0) return [];
      const res = (await postJson(
        doFetch,
        endpoint,
        apiKey,
        {
          query,
          documents: docs.map((d) => d.text),
          model: opts.model,
          top_k: topK,
          truncation: true,
        },
        post,
      )) as { data?: { index: number; relevance_score: number }[] } | null;
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
