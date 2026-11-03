import { MissingCredentialError, type Embedder } from '@oortmem/core';
import { VoyageError, postJson } from './http.js';

export { VoyageError, type VoyageErrorKind } from './http.js';

const URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH = 128;

export interface VoyageEmbedderOptions {
  /** Defaults to `process.env.VOYAGE_API_KEY`. */
  apiKey?: string;
  model: string;
  dimension: number;
  fetch?: typeof fetch;
}

function toInt8(v: unknown, dimension: number): Int8Array {
  if (!Array.isArray(v) || v.length !== dimension) {
    throw new VoyageError(
      'bad-response',
      `Voyage returned an embedding of the wrong dimension (expected ${dimension})`,
    );
  }
  const out = new Int8Array(dimension);
  for (let i = 0; i < dimension; i++) {
    const x: unknown = v[i];
    if (typeof x !== 'number' || !Number.isInteger(x) || x < -128 || x > 127) {
      throw new VoyageError(
        'bad-response',
        'Voyage returned an embedding value outside int8 range',
      );
    }
    out[i] = x;
  }
  return out;
}

export function voyageEmbedder(opts: VoyageEmbedderOptions): Embedder {
  const apiKey = opts.apiKey ?? process.env['VOYAGE_API_KEY'];
  if (!apiKey) throw new MissingCredentialError('VOYAGE_API_KEY', 'embed.apiKey');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const { model, dimension } = opts;

  return {
    dimension,
    async embed(texts, kind) {
      const out: Int8Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const input = texts.slice(i, i + BATCH);
        const res = (await postJson(doFetch, URL, apiKey, {
          input,
          model,
          input_type: kind,
          output_dimension: dimension,
          output_dtype: 'int8',
          truncation: true,
        })) as { data?: { index: number; embedding: unknown }[] } | null;
        const data = res?.data;
        if (!Array.isArray(data) || data.length !== input.length) {
          throw new VoyageError(
            'bad-response',
            'Voyage returned an unexpected number of embeddings',
          );
        }
        const sorted = [...data].sort((a, b) => a.index - b.index);
        for (const d of sorted) out.push(toInt8(d.embedding, dimension));
      }
      return out;
    },
  };
}
