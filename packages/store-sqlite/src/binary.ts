/**
 * Binary quantization of the store's int8 vectors (CON-17, schema version 5). A memory's binary
 * code is one bit per dimension of its vector after a fixed random rotation: the sign of each
 * rotated value (positive is 1), packed as sqlite-vec's `vec_quantize_binary` packs a float
 * vector (element i is bit i % 8 of byte i / 8).
 *
 * The rotation is the randomized Hadamard transform RaBitQ uses: flip the sign of each dimension
 * by a fixed pattern, apply the (unnormalised) Walsh-Hadamard transform, and do both again. It is
 * orthogonal up to scale, so cosines are unchanged, and it spreads every vector over all of its
 * dimensions, so the bits are random hyperplanes and the Hamming distance between two codes
 * estimates the angle between the vectors (each bit differs with probability angle / pi).
 * Without it a sparse vector's code is mostly 0 bits and barely ranks (design §5).
 *
 * The codes are part of the schema: changing the rotation, its sign pattern or the packing needs
 * a migration that rebuilds the binary index.
 */

/**
 * The width in bits of a dimension's binary code: the Hadamard transform's length, the dimension
 * rounded up to a power of two, and at least 8 (one byte). 512 dimensions take 512 bits, 384
 * take 512, 1024 take 1024.
 */
export function bitWidth(dimension: number): number {
  let p = 8;
  while (p < dimension) p *= 2;
  return p;
}

/** The fixed sign of dimension `i` in round `round` (0 or 1): a 32-bit integer hash's low bit. */
function sign(i: number, round: number): number {
  let h = (i + 1) * 0x9e3779b1 + round * 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h & 1) === 1 ? -1 : 1;
}

const signs = new Map<number, Float64Array[]>();

/** The two rounds' sign patterns for a transform of length `n`, computed once. */
function signsFor(n: number): Float64Array[] {
  let s = signs.get(n);
  if (s === undefined) {
    s = [0, 1].map((round) => Float64Array.from({ length: n }, (_, i) => sign(i, round)));
    signs.set(n, s);
  }
  return s;
}

/** The Walsh-Hadamard transform of `a` in place (`a.length` a power of two). */
function hadamard(a: Float64Array): void {
  for (let h = 1; h < a.length; h *= 2) {
    for (let i = 0; i < a.length; i += 2 * h) {
      for (let j = i; j < i + h; j++) {
        const x = a[j] as number;
        const y = a[j + h] as number;
        a[j] = x + y;
        a[j + h] = x - y;
      }
    }
  }
}

/**
 * `v` rotated: padded with zeros to `bitWidth(v.length)`, then two rounds of fixed sign flips and
 * the Walsh-Hadamard transform. Orthogonal up to scale.
 */
export function rotate(v: Int8Array): Float32Array {
  const a = new Float64Array(bitWidth(v.length));
  for (let i = 0; i < v.length; i++) a[i] = v[i] as number;
  for (const s of signsFor(a.length)) {
    for (let i = 0; i < a.length; i++) a[i] = (a[i] as number) * (s[i] as number);
    hadamard(a);
  }
  return Float32Array.from(a);
}

/** The binary code of `v`: `bitWidth(v.length) / 8` bytes, the signs of `rotate(v)`. */
export function binaryCode(v: Int8Array): Buffer {
  const r = rotate(v);
  const out = Buffer.alloc(r.length / 8);
  for (let i = 0; i < r.length; i++) {
    if ((r[i] as number) > 0) out[i >> 3] = (out[i >> 3] as number) | (1 << (i & 7));
  }
  return out;
}

/**
 * How many binary candidates a dense query rescores per result it returns: `k` results read
 * `BINARY_OVERSAMPLE × k` int8 vectors (at most sqlite-vec's 4096). Oversampling with rescoring is
 * the issue's fallback for when the index cannot use RaBitQ-style error bounds; the issue's 4 ×
 * found 0.87 of the exact top 10 at one million clustered vectors, 10 × found them all (design §4).
 */
export const BINARY_OVERSAMPLE = 10;

/**
 * `vectorIndex: 'auto'` builds the binary index once the store holds this many searchable vectors
 * (hot and warm). Below it, an exact int8 scan is fast enough and needs no second index (design §7).
 */
export const BINARY_AUTO_THRESHOLD = 100_000;
