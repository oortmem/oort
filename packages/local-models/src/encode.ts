import type { Encoding, Feed } from './runtime.js';

/** Roughly four characters per token: text past this many characters cannot fit anyway. */
export function clipChars(text: string, maxTokens: number): string {
  const max = maxTokens * 6;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * At most `maxTokens` tokens. The tail is cut but the final special token (`[SEP]`, `</s>`,
 * `<|endoftext|>`) is kept, so a cross-encoder pair loses the end of its document, never the
 * structure, and last-token pooling still reads the end-of-text token.
 */
export function clipTokens(e: Encoding, maxTokens: number): Encoding {
  if (e.ids.length <= maxTokens) return e;
  const last = e.ids.length - 1;
  const out: Encoding = { ids: [...e.ids.slice(0, maxTokens - 1), e.ids[last]!] };
  if (e.token_type_ids !== undefined) {
    const tt = e.token_type_ids;
    out.token_type_ids = [...tt.slice(0, maxTokens - 1), tt[last] ?? 0];
  }
  return out;
}

export interface Batch {
  feeds: Record<string, Feed>;
  /** Padded sequence length. */
  length: number;
  /** Real (unpadded) length of each row. */
  lengths: number[];
}

/**
 * Right-padded int64 inputs for the names the session declares: `input_ids`, `attention_mask`,
 * and when declared `token_type_ids` and `position_ids`; a decoder export also gets empty past
 * key/value tensors.
 */
export function toBatch(
  encodings: Encoding[],
  inputNames: readonly string[],
  kvCache?: { layers: number; heads: number; headDim: number },
): Batch {
  const n = encodings.length;
  const length = Math.max(1, ...encodings.map((e) => e.ids.length));
  const ids = new BigInt64Array(n * length);
  const mask = new BigInt64Array(n * length);
  const types = new BigInt64Array(n * length);
  const positions = new BigInt64Array(n * length);
  encodings.forEach((e, i) => {
    for (let j = 0; j < e.ids.length; j++) {
      const at = i * length + j;
      ids[at] = BigInt(e.ids[j]!);
      mask[at] = 1n;
      types[at] = BigInt(e.token_type_ids?.[j] ?? 0);
      positions[at] = BigInt(j);
    }
  });
  const dims = [n, length];
  const feeds: Record<string, Feed> = {
    input_ids: { type: 'int64', data: ids, dims },
    attention_mask: { type: 'int64', data: mask, dims },
  };
  if (inputNames.includes('token_type_ids'))
    feeds['token_type_ids'] = { type: 'int64', data: types, dims };
  if (inputNames.includes('position_ids'))
    feeds['position_ids'] = { type: 'int64', data: positions, dims };
  if (kvCache !== undefined) {
    const empty = [n, kvCache.heads, 0, kvCache.headDim];
    for (let l = 0; l < kvCache.layers; l++) {
      for (const kv of ['key', 'value']) {
        feeds[`past_key_values.${l}.${kv}`] = {
          type: 'float32',
          data: new Float32Array(0),
          dims: empty,
        };
      }
    }
  }
  return { feeds, length, lengths: encodings.map((e) => e.ids.length) };
}

/** Float vector to int8 with a per-vector scale (cosine similarity is scale-free). */
export function quantize(v: Float32Array): Int8Array {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const out = new Int8Array(v.length);
  if (max === 0) return out;
  const s = 127 / max;
  for (let i = 0; i < v.length; i++) out[i] = Math.round(v[i]! * s);
  return out;
}

/** In place: unit length (a zero vector stays zero). */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
