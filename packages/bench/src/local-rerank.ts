import type { Reranker } from '@oortmem/core';
import { rerankScore } from '@oortmem/local-models';

/**
 * Recall settings for the local reranker's eval runs and their replay: the reranker is given as
 * long as it takes (a loaded machine would otherwise time out and fall back to fused order, and
 * the run would not repeat). Everything else is recall's default.
 */
export const REPLAY_RECALL = { rerankBudgetMs: 0 } as const;

/** Raw reranker logits per query, per memory id. */
export type LogitTable = Record<string, Record<string, number>>;

/**
 * A `Reranker` that reads recorded logits instead of running the model, and maps them with
 * `calibration` exactly as `localReranker` does. With `scoreMissing`, pairs not yet in `logits`
 * are scored (and recorded) first; without it a missing pair throws, naming the re-record
 * command, so a change in recall's candidates cannot silently skip the check.
 */
export function calibratedReranker(
  logits: LogitTable,
  calibration: { scale: number; shift: number },
  scoreMissing?: Reranker,
): Reranker {
  return {
    async rerank(query, docs, topK) {
      if (scoreMissing !== undefined) await scoreMissing.rerank(query, docs, docs.length);
      const row = logits[query] ?? {};
      return docs
        .map((d) => {
          const l = row[d.id];
          if (l === undefined) {
            throw new Error(
              `no recorded logit for "${query}" / ${d.id}; re-record with ` +
                '`pnpm --filter @oortmem/bench run calibrate:local -- --record packages/bench/eval/minilm-logits.json`',
            );
          }
          return { id: d.id, score: rerankScore(l, calibration) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, topK));
    },
  };
}
