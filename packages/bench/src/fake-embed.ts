import { tokenizeLexical, type Embedder } from '@oortmem/core';

/** FNV-1a over UTF-16 code units. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A deterministic fake embedding: signed feature hashing of the text's tokens
 * (and the parts of hyphenated or dotted tokens) into `dimension` bins,
 * L2-normalised, then scaled to int8. Texts sharing words land near each
 * other, so the dense path returns plausible neighbours without any model.
 */
export function fakeEmbedding(text: string, dimension = 512): Int8Array {
  const v = new Float64Array(dimension);
  for (const token of tokenizeLexical(text)) {
    const parts = token.split(/[-_.]/).filter((p) => p.length > 0);
    for (const t of parts.length > 1 ? [token, ...parts] : [token]) {
      const h = fnv(t);
      v[h % dimension] = (v[h % dimension] ?? 0) + ((h >>> 16) & 1 ? 1 : -1);
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  const out = new Int8Array(dimension);
  if (norm === 0) return out;
  const scale = 127 / Math.sqrt(norm);
  for (let i = 0; i < dimension; i++) out[i] = Math.round((v[i] ?? 0) * scale);
  return out;
}

/** An in-process `Embedder` over `fakeEmbedding`: no network, no model. */
export function fakeEmbedder(dimension = 512): Embedder {
  return {
    dimension,
    async embed(texts) {
      return texts.map((t) => fakeEmbedding(t, dimension));
    },
  };
}
