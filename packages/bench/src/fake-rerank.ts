import { informativeTokens, type Reranker } from '@oortmem/core';

/**
 * A deterministic in-process reranker for latency runs: each document scores the share of the
 * query's informative words it holds. No model, no network, so a `full` recall path (fusion, the
 * rerank call with its candidates, the rerank gate) can be timed without paying for one. Its
 * ranking means nothing; only the shape of the call does.
 */
export function fakeReranker(): Reranker {
  return {
    async rerank(query, docs, topK) {
      const q = informativeTokens(query);
      return docs
        .map((d) => {
          const have = informativeTokens(d.text);
          let hit = 0;
          for (const t of q) if (have.has(t)) hit++;
          return { id: d.id, score: q.size === 0 ? 0 : hit / q.size };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
}
