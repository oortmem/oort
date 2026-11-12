import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { BINARY_OVERSAMPLE, binaryCode, bitWidth, rotate } from './binary.js';

let seed = 7;
const next = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed;
};
const randomVec = (dim: number) => Int8Array.from({ length: dim }, () => (next() % 255) - 127);
/** A hashed bag-of-words vector: a handful of non-zero dimensions, as the bench's fake embedder. */
const sparseVec = (dim: number, words: number[]) => {
  const v = new Int8Array(dim);
  for (const w of words) v[(w * 2654435761) % dim] = (w & 1 ? 1 : -1) * 60;
  return v;
};
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b) || 1);
const hamming = (a: Buffer, b: Buffer) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (a[i] as number) ^ (b[i] as number);
    while (x !== 0) {
      x &= x - 1;
      n++;
    }
  }
  return n;
};

describe('binary codes', () => {
  it('binary.is-vec-quantize-binary-of-the-rotated-vector', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const quantize = db.prepare<[Buffer], { code: Buffer }>(
      'SELECT vec_quantize_binary(vec_f32(?)) AS code',
    );
    for (const dim of [8, 16, 384, 512, 1024]) {
      for (let n = 0; n < 20; n++) {
        expect(binaryCode(randomVec(dim)).length).toBe(bitWidth(dim) / 8);
        const v = randomVec(dim);
        const rv = rotate(v);
        const code = quantize.get(Buffer.from(rv.buffer, rv.byteOffset, rv.byteLength))!.code;
        expect(binaryCode(v).equals(code), `dim ${dim}`).toBe(true);
      }
    }
    db.close();
  });

  it('binary.rotation-keeps-angles', () => {
    // An orthogonal transform (up to scale): cosines are unchanged.
    for (const dim of [16, 384, 512]) {
      for (let n = 0; n < 10; n++) {
        const a = randomVec(dim);
        const b = randomVec(dim);
        expect(cosine(rotate(a), rotate(b))).toBeCloseTo(cosine(a, b), 5);
      }
    }
  });

  it('binary.pads-to-a-power-of-two-of-whole-bytes', () => {
    expect(bitWidth(4)).toBe(8);
    expect(bitWidth(8)).toBe(8);
    expect(bitWidth(9)).toBe(16);
    // The rotation needs a power of two: 384 dimensions take 512 bits.
    expect(bitWidth(384)).toBe(512);
    expect(bitWidth(1024)).toBe(1024);
    expect(binaryCode(Int8Array.from([5, -5, 0, 1])).length).toBe(1);
    expect(binaryCode(new Int8Array(9).fill(1)).length).toBe(2);
  });

  it('binary.sparse-vectors-keep-their-neighbours', () => {
    // Without the rotation a sparse vector's code is mostly 0 bits (zero and negative alike),
    // and Hamming distance barely ranks: rescoring 4k candidates missed half the exact top k.
    const dim = 512;
    const docs = Array.from({ length: 1500 }, () =>
      sparseVec(
        dim,
        Array.from({ length: 8 }, () => next() % 400),
      ),
    );
    const codes = docs.map(binaryCode);
    let found = 0;
    let wanted = 0;
    for (let q = 0; q < 50; q++) {
      const query = sparseVec(
        dim,
        Array.from({ length: 4 }, () => next() % 400),
      );
      const exact = docs
        .map((d, i) => ({ i, s: cosine(query, d) }))
        .sort((x, y) => y.s - x.s)
        .slice(0, 10);
      const qc = binaryCode(query);
      const cand = new Set(
        codes
          .map((c, i) => ({ i, h: hamming(qc, c) }))
          .sort((x, y) => x.h - y.h)
          .slice(0, 40)
          .map((x) => x.i),
      );
      // Ties in the exact order count as found when an equal score made the cut.
      const cut = exact.at(-1)!.s;
      for (const e of exact) {
        wanted++;
        if (
          cand.has(e.i) ||
          (e.s === cut && [...cand].some((i) => cosine(query, docs[i]!) === cut))
        )
          found++;
      }
    }
    expect(found / wanted).toBeGreaterThan(0.85);
  });

  it('binary.oversampling-finds-the-top-10-in-a-dense-cluster', () => {
    // The hard case the 1M bench showed (design §9): 500 vectors per cluster, all about equally
    // close to a query near the centre. Recall asks for k = 50; 4 × 50 candidates found 0.85 of
    // the exact top 10, so the factor is 10.
    const dim = 512;
    const gauss = () => {
      const u = (next() % 100_000) / 100_000 + 1e-6;
      const w = (next() % 100_000) / 100_000;
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    };
    const centre = Float64Array.from({ length: dim }, gauss);
    const near = () => {
      const v = Float64Array.from(centre, (x) => x + gauss());
      const n = Math.sqrt(dot(v, v));
      return Int8Array.from(v, (x) => Math.round((x * 127) / n));
    };
    const docs = Array.from({ length: 500 }, near);
    // Plus noise from elsewhere, so the codes must also rank the cluster first.
    for (let i = 0; i < 1500; i++)
      docs.push(Int8Array.from({ length: dim }, () => Math.round(gauss() * 20)));
    const codes = docs.map(binaryCode);
    const candidates = BINARY_OVERSAMPLE * 50;
    let found = 0;
    for (let q = 0; q < 20; q++) {
      const query = near();
      const exact = docs
        .map((d, i) => ({ i, s: cosine(query, d) }))
        .sort((x, y) => y.s - x.s)
        .slice(0, 10);
      const qc = binaryCode(query);
      const cand = new Set(
        codes
          .map((c, i) => ({ i, h: hamming(qc, c) }))
          .sort((x, y) => x.h - y.h)
          .slice(0, candidates)
          .map((x) => x.i),
      );
      found += exact.filter((e) => cand.has(e.i)).length;
    }
    expect(found / 200).toBeGreaterThanOrEqual(0.99);
  });
});
