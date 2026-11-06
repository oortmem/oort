import type { Reranker } from '@oortmem/core';
import { DEFAULT_RERANK_MODEL, type RerankModelSpec } from './catalog.js';
import { clipChars, clipTokens, sigmoid, toBatch } from './encode.js';
import { readyModel } from './errors.js';
import { lazyLoad, onnxRuntime, type Runtime } from './runtime.js';

/**
 * A cross-encoder logit mapped onto the 0 to 1 score `recall.minRerankScore` is set for:
 * `sigmoid(scale * logit + shift)`. With a positive `scale` it is strictly increasing, so it
 * never reorders results; it only places them relative to the relevance gate.
 */
export function rerankScore(logit: number, calibration: { scale: number; shift: number }): number {
  return sigmoid(calibration.scale * logit + calibration.shift);
}

export interface LocalRerankerOptions {
  /** `$OORT_HOME`; models live in `<home>/models/<id>`. */
  home: string;
  /** Catalog id, default `ms-marco-minilm-l6-v2`. */
  model?: string;
  /** Default: ONNX Runtime. */
  runtime?: Runtime;
  threads?: number;
  /** Pairs per forward pass (default 16). */
  batchSize?: number;
  /** A model outside the catalog (tests, experiments); used when its id is `model`. */
  spec?: RerankModelSpec;
}

export interface LocalReranker extends Reranker {
  readonly model: string;
  /** Loads the model now instead of on the first `rerank`. */
  load(): Promise<void>;
}

/**
 * A cross-encoder on this machine's CPU: each (query, document) pair is scored jointly, and the
 * logit is mapped to 0..1 by the model's calibration. Loaded on the first `rerank`.
 */
export function localReranker(opts: LocalRerankerOptions): LocalReranker {
  const id = opts.model ?? DEFAULT_RERANK_MODEL;
  const { spec: s, dir } = readyModel(opts.home, 'rerank', id, opts.spec);
  const spec = s as RerankModelSpec;
  const load = lazyLoad(opts.runtime ?? onnxRuntime(), dir, opts.threads);
  const batchSize = opts.batchSize ?? 16;

  return {
    model: id,
    async load() {
      await load();
    },
    async rerank(query, docs, topK) {
      if (docs.length === 0) return [];
      const m = await load();
      const q = clipChars(query, spec.maxTokens / 4);
      const scores: number[] = [];
      for (let i = 0; i < docs.length; i += batchSize) {
        const encodings = docs
          .slice(i, i + batchSize)
          .map((d) =>
            clipTokens(m.tokenizer.encode(q, clipChars(d.text, spec.maxTokens)), spec.maxTokens),
          );
        const batch = toBatch(encodings, m.session.inputNames);
        const out = (await m.session.run(batch.feeds, ['logits']))['logits'];
        if (out === undefined || out.dims[0] !== encodings.length) {
          throw new Error(`local model ${id}: unexpected output shape`);
        }
        const per = out.dims[1] ?? 1;
        for (let j = 0; j < encodings.length; j++) {
          scores.push(rerankScore(out.data[j * per]!, spec.calibration));
        }
      }
      return docs
        .map((d, i) => ({ id: d.id, score: scores[i]! }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, topK));
    },
  };
}
