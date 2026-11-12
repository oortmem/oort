/**
 * The RaBitQ engines (CON-25): the encoding's estimate and its error bound, the TypeScript
 * reference engine, and the native engine returning the same candidates.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bitWidth } from './binary.js';
import {
  createRabitqEngine,
  loadNativeRabitq,
  nativePlatformTag,
  rabitqEncode,
  rabitqQuery,
  rotatedCentroid,
  RABITQ_EPSILON,
  TsRabitqIndex,
  type RabitqEngine,
} from './rabitq.js';

const native = loadNativeRabitq();
const HAS_NATIVE = 'module' in native;
/** CI builds the native engine before the tests: there, its absence is a failure, not a skip. */
const REQUIRE_NATIVE = process.env['OORT_REQUIRE_NATIVE'] === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-rabitq-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seed = 11;
const uniform = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const gaussian = () =>
  Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
/** An int8 vector near `centre` (as the bench's clustered vectors), scaled to 127. */
const near = (centre: Float64Array, noise = 1): Int8Array => {
  const v = Float64Array.from(centre, (x) => x + noise * gaussian());
  let n = 0;
  for (const x of v) n += x * x;
  const s = 127 / Math.sqrt(n);
  return Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * s))));
};
const cosine = (a: Int8Array, b: Int8Array) => {
  let d = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    d += (a[i] as number) * (b[i] as number);
    aa += (a[i] as number) ** 2;
    bb += (b[i] as number) ** 2;
  }
  return aa === 0 || bb === 0 ? 0 : d / Math.sqrt(aa * bb);
};

/** A corpus of clustered vectors, its mean as the centroid, and both engines loaded with it. */
function corpus(dim: number, n: number, clusters: number) {
  const centres = Array.from({ length: clusters }, () =>
    Float64Array.from({ length: dim }, gaussian),
  );
  const vectors = Array.from({ length: n }, () => near(centres[Math.floor(uniform() * clusters)]!));
  const mean = new Float64Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] = (mean[i] as number) + (v[i] as number) / n;
  const rc = rotatedCentroid(mean, dim);
  const w = bitWidth(dim);
  const codes = Buffer.alloc((n * w) / 8);
  const factors = new Float32Array(n * 3);
  vectors.forEach((v, i) => {
    const e = rabitqEncode(v, rc);
    e.code.copy(codes, (i * w) / 8);
    factors.set(e.factors, i * 3);
  });
  const rids = Uint32Array.from({ length: n }, (_, i) => i + 1);
  const nodes = Uint32Array.from({ length: n }, (_, i) => i % 3);
  const projects = Uint32Array.from({ length: n }, (_, i) => i % 5);
  const authors = Uint32Array.from({ length: n }, (_, i) => i % 2);
  const load = (engine: RabitqEngine) => {
    engine.upsert(rids, nodes, projects, authors, codes, factors);
    return engine;
  };
  return { centres, vectors, rc, w, load, nodes, projects, authors };
}

describe('rabitq encoding', () => {
  it('rabitq.estimate-error-matches-its-standard-error', () => {
    // The bound is only as good as the standard error: the normalised error must look normal
    // (about 6% beyond 1.9 standard errors in all, 0.3% beyond 3).
    const dim = 384;
    const c = corpus(dim, 3000, 30);
    const ts = c.load(new TsRabitqIndex(c.w));
    let beyond19 = 0;
    let beyond3 = 0;
    let count = 0;
    for (let qn = 0; qn < 20; qn++) {
      const qv = near(c.centres[qn % c.centres.length]!);
      const { query, cq } = rabitqQuery(qv, c.rc);
      // eps 0 and k = n: every vector is a candidate and `upper` is its estimate.
      const est = ts.search(query, cq, 3000, 0, 0);
      const sd = ts.search(query, cq, 3000, 1, 0);
      const sdOf = new Map<number, number>();
      sd.rids.forEach((rid, i) => sdOf.set(rid, sd.upper[i] as number));
      est.rids.forEach((rid, i) => {
        const e = est.upper[i] as number;
        const s = (sdOf.get(rid) as number) - e;
        const z = Math.abs(e - cosine(c.vectors[rid - 1]!, qv)) / s;
        count++;
        if (z > RABITQ_EPSILON) beyond19++;
        if (z > 3) beyond3++;
      });
    }
    expect(count).toBe(20 * 1000); // node 0 holds every third vector
    expect(beyond19 / count).toBeLessThan(0.08);
    expect(beyond3 / count).toBeLessThan(0.006);
  });

  it('rabitq.zero-vectors-are-always-candidates-and-the-centroid-is-exact', () => {
    const dim = 64;
    const rc = rotatedCentroid(Float64Array.from({ length: dim }, (_, i) => (i % 7) - 3), dim);
    const zero = rabitqEncode(new Int8Array(dim), rc);
    expect(zero.factors[2]).toBe(Infinity);
    const centre = Int8Array.from({ length: dim }, (_, i) => (i % 7) - 3);
    const atCentre = rabitqEncode(centre, rc);
    expect(atCentre.factors[0]).toBe(0);
    expect(atCentre.factors[2]).toBe(0);
    const ix = new TsRabitqIndex(bitWidth(dim));
    const z = new Uint32Array([1, 2]);
    ix.upsert(
      z,
      new Uint32Array(2),
      new Uint32Array(2),
      new Uint32Array(2),
      Buffer.concat([zero.code, atCentre.code]),
      Float32Array.from([...zero.factors, ...atCentre.factors]),
    );
    const q = Int8Array.from({ length: dim }, (_, i) => (i % 5) - 2);
    const { query, cq } = rabitqQuery(q, rc);
    const got = ix.search(query, cq, 1, RABITQ_EPSILON, 0);
    // The zero vector's bound is infinite: it is first, whatever its exact score.
    expect([...got.rids]).toContain(1);
    // The centroid's estimate is its exact cosine (no error): bounds collapse onto it.
    const exact = ix.search(query, cq, 2, 0, 0);
    const i = [...exact.rids].indexOf(2);
    expect(exact.upper[i]).toBeCloseTo(cosine(centre, q), 5);
  });
});

describe('rabitq engines', () => {
  it('rabitq.candidates-hold-the-exact-top-k', () => {
    const c = corpus(512, 4000, 40);
    const ts = c.load(new TsRabitqIndex(c.w));
    let missed = 0;
    let candidates = 0;
    for (let qn = 0; qn < 30; qn++) {
      const qv = near(c.centres[qn % 40]!);
      const { query, cq } = rabitqQuery(qv, c.rc);
      const got = ts.search(query, cq, 10, 3, 1);
      candidates += got.rids.length;
      const exact = c.vectors
        .map((v, i) => ({ rid: i + 1, s: cosine(v, qv) }))
        .filter((x) => c.nodes[x.rid - 1] === 1)
        .sort((a, b) => b.s - a.s)
        .slice(0, 10);
      const have = new Set(got.rids);
      missed += exact.filter((x) => !have.has(x.rid)).length;
    }
    expect(missed).toBe(0);
    // ...and far fewer than all 1,333 vectors of the node.
    expect(candidates / 30).toBeLessThan(400);
  });

  it('rabitq.filters-and-the-allowlist-apply-before-k', () => {
    const c = corpus(64, 600, 6);
    const ts = c.load(new TsRabitqIndex(c.w));
    const { query, cq } = rabitqQuery(near(c.centres[0]!), c.rc);
    for (const rid of ts.search(query, cq, 5, RABITQ_EPSILON, 2, new Uint32Array([3]), 1).rids) {
      expect(c.nodes[rid - 1]).toBe(2);
      expect(c.projects[rid - 1]).toBe(3);
      expect(c.authors[rid - 1]).toBe(1);
    }
    // Rows 1, 4, 7 and 10 are in node 0; 600 is in node 2; 9999 does not exist.
    const allow = new Uint32Array([1, 4, 7, 10, 600, 9999]);
    const got = ts.search(query, cq, 50, RABITQ_EPSILON, 0, null, null, allow);
    expect([...got.rids].sort((a, b) => a - b)).toEqual([1, 4, 7, 10]);
  });

  it('rabitq.remove-and-replace-keep-every-slot-consistent', () => {
    const c = corpus(64, 300, 3);
    const ts = c.load(new TsRabitqIndex(c.w));
    ts.remove(Uint32Array.from({ length: 150 }, (_, i) => 2 * i + 1));
    expect(ts.size).toBe(150);
    const { query, cq } = rabitqQuery(near(c.centres[1]!), c.rc);
    for (const node of [0, 1, 2]) {
      for (const rid of ts.search(query, cq, 300, 0, node).rids) {
        expect(rid % 2).toBe(0);
        expect(c.nodes[rid - 1]).toBe(node);
      }
    }
    ts.clear();
    expect(ts.size).toBe(0);
    expect(ts.search(query, cq, 10, 0, 0).rids).toHaveLength(0);
  });

  it.runIf(HAS_NATIVE || REQUIRE_NATIVE)(
    'rabitq.native-and-typescript-return-the-same-candidates',
    () => {
      expect('module' in native, `native engine: ${'error' in native ? native.error : ''}`).toBe(
        true,
      );
      for (const dim of [8, 100, 384, 512, 1024]) {
        const c = corpus(dim, 1500, 15);
        const ts = c.load(new TsRabitqIndex(c.w));
        const nat = c.load(createRabitqEngine(c.w, 'native').engine);
        nat.remove(new Uint32Array([5, 77, 1500]));
        ts.remove(new Uint32Array([5, 77, 1500]));
        expect(nat.size).toBe(ts.size);
        for (let qn = 0; qn < 10; qn++) {
          const { query, cq } = rabitqQuery(near(c.centres[qn]!), c.rc);
          const args = [
            [query, cq, 50, RABITQ_EPSILON, qn % 3],
            [query, cq, 10, 1, qn % 3, new Uint32Array([1, 4]), 0],
            [query, cq, 20, 2.5, 0, null, null, Uint32Array.from({ length: 200 }, (_, i) => i * 3)],
          ] as const;
          for (const a of args) {
            const x = (ts.search as (...x: unknown[]) => ReturnType<RabitqEngine['search']>)(...a);
            const y = (nat.search as (...x: unknown[]) => ReturnType<RabitqEngine['search']>)(
              ...a,
            );
            expect([...y.rids], `dim ${dim}`).toEqual([...x.rids]);
            expect([...y.upper]).toEqual([...x.upper]);
          }
        }
      }
    },
  );

  it('rabitq.the-loader-says-why-the-native-engine-is-missing', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(loadNativeRabitq(empty)).toEqual({
      error: `no prebuilt binary for ${nativePlatformTag()}`,
    });
    const broken = path.join(tmp, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, `oort-rabitq.${nativePlatformTag()}.node`), 'not a binary');
    const r = loadNativeRabitq(broken);
    expect('error' in r && r.error).toMatch(/binary did not load/);
    expect(createRabitqEngine(64, 'typescript').kind).toBe('typescript');
    if (!HAS_NATIVE) {
      expect(createRabitqEngine(64).fallback).toMatch(/no prebuilt binary|did not load/);
      expect(() => createRabitqEngine(64, 'native')).toThrow(/native engine is unavailable/);
    } else {
      expect(createRabitqEngine(64).kind).toBe('native');
    }
  });
});
