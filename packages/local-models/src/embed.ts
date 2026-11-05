import type { Embedder } from '@oortmem/core';
import { DEFAULT_EMBED_MODEL, type EmbedModelSpec } from './catalog.js';
import { clipChars, clipTokens, normalize, quantize, toBatch } from './encode.js';
import { LocalModelError, readyModel } from './errors.js';
import { lazyLoad, onnxRuntime, type LoadedModel, type Runtime } from './runtime.js';

export interface LocalEmbedderOptions {
  /** `$OORT_HOME`; models live in `<home>/models/<id>`. */
  home: string;
  /** Catalog id, default `bge-small-en-v1.5`. */
  model?: string;
  /**
   * The store's dimension. A narrower model is zero-padded to it (cosine similarity is
   * unchanged); a wider Matryoshka model is truncated to it; a wider plain model is refused.
   */
  dimension: number;
  /** Default: ONNX Runtime. */
  runtime?: Runtime;
  threads?: number;
  /** Texts per forward pass (default 16). */
  batchSize?: number;
  /** A model outside the catalog (tests, experiments); used when its id is `model`. */
  spec?: EmbedModelSpec;
}

export interface LocalEmbedder extends Embedder {
  readonly model: string;
  /** Loads the model now instead of on the first `embed` (a warm process can preload). */
  load(): Promise<void>;
}

/**
 * Embeddings on this machine's CPU. Nothing is loaded until the first `embed` (or `load`):
 * constructing one only checks that the model was pulled, so a hook whose lexical search
 * answers on its own pays nothing. Vectors are unit length, then int8 with a per-vector scale.
 */
export function localEmbedder(opts: LocalEmbedderOptions): LocalEmbedder {
  const id = opts.model ?? DEFAULT_EMBED_MODEL;
  const { spec: s, dir } = readyModel(opts.home, 'embed', id, opts.spec);
  const spec = s as EmbedModelSpec;
  const { dimension } = opts;
  if (spec.nativeDimension > dimension && !spec.matryoshka) {
    throw new LocalModelError(
      'dimension',
      `local model ${id} has ${spec.nativeDimension} dimensions and cannot be truncated to the store's ${dimension}.`,
    );
  }
  const keep = Math.min(spec.nativeDimension, dimension);
  const runtime = opts.runtime ?? onnxRuntime();
  const batchSize = opts.batchSize ?? 16;
  const load = lazyLoad(runtime, dir, opts.threads);

  async function forward(m: LoadedModel, texts: string[]): Promise<Int8Array[]> {
    const encodings = texts.map((t) =>
      clipTokens(m.tokenizer.encode(clipChars(t, spec.maxTokens)), spec.maxTokens),
    );
    const batch = toBatch(encodings, m.session.inputNames, spec.kvCache);
    const out = (await m.session.run(batch.feeds, ['last_hidden_state']))['last_hidden_state'];
    if (out === undefined || out.dims.length !== 3) {
      throw new Error(`local model ${id}: unexpected output shape`);
    }
    const hidden = out.dims[2]!;
    if (hidden !== spec.nativeDimension) {
      throw new Error(
        `local model ${id}: output has ${hidden} dimensions, expected ${spec.nativeDimension}`,
      );
    }
    const L = batch.length;
    const d = out.data;
    return batch.lengths.map((len, i) => {
      const v = new Float32Array(hidden);
      const row = (j: number): number => (i * L + j) * hidden;
      if (spec.pooling === 'cls') v.set(d.subarray(row(0), row(0) + hidden));
      else if (spec.pooling === 'last') v.set(d.subarray(row(len - 1), row(len - 1) + hidden));
      else {
        for (let j = 0; j < len; j++) {
          const at = row(j);
          for (let h = 0; h < hidden; h++) v[h] = v[h]! + d[at + h]!;
        }
        for (let h = 0; h < hidden; h++) v[h] = v[h]! / len;
      }
      // Matryoshka: normalise the prefix; a narrow model is padded with zeros after it.
      const prefix = normalize(v.slice(0, keep));
      const full = new Float32Array(dimension);
      full.set(prefix);
      return quantize(full);
    });
  }

  return {
    dimension,
    model: id,
    async load() {
      await load();
    },
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      const m = await load();
      const prefix = kind === 'query' ? spec.queryPrefix : spec.documentPrefix;
      const out: Int8Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize).map((t) => prefix + t);
        out.push(...(await forward(m, chunk)));
      }
      return out;
    },
  };
}
