import { MissingCredentialError, truncateUtf8, type Embedder } from '@oortmem/core';
import { VoyageError, postJson } from './http.js';

export { VoyageError, type VoyageErrorKind } from './http.js';

/** The Voyage API root; the Oort Pro relay serves the same routes under its own root. */
export const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';
const BATCH = 128;
/** The Oort Pro relay refuses an input over 8 KB; Voyage truncates by tokens anyway. */
const INPUT_MAX_BYTES = 8 * 1024;

export interface VoyageEmbedderOptions {
  /** Defaults to `process.env.VOYAGE_API_KEY`. */
  apiKey?: string;
  model: string;
  dimension: number;
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
  const post = { relay: opts.relay === true };
  const endpoint = `${(opts.baseUrl ?? VOYAGE_BASE_URL).replace(/\/+$/, '')}/embeddings`;
  const { model, dimension } = opts;

  return {
    dimension,
    async embed(texts, kind) {
      const out: Int8Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const input = texts.slice(i, i + BATCH).map((t) => truncateUtf8(t, INPUT_MAX_BYTES));
        const res = (await postJson(
          doFetch,
          endpoint,
          apiKey,
          {
            input,
            model,
            input_type: kind,
            output_dimension: dimension,
            output_dtype: 'int8',
            truncation: true,
          },
          post,
        )) as { data?: { index: number; embedding: unknown }[] } | null;
        const data = res?.data;
        if (!Array.isArray(data) || data.length !== input.length) {
          throw new VoyageError(
            'bad-response',
            'Voyage returned an unexpected number of embeddings',
          );
        }
        const sorted = [...data].sort((a, b) => a.index - b.index);
        sorted.forEach((d, i) => {
          if (!Number.isInteger(d.index) || d.index !== i) {
            throw new VoyageError(
              'bad-response',
              'Voyage returned embeddings with invalid indices',
            );
          }
        });
        for (const d of sorted) out.push(toInt8(d.embedding, dimension));
      }
      return out;
    },
  };
}
