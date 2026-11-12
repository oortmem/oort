/**
 * The RaBitQ index (CON-25, schema version 7; design `docs/design/2026-11-12-rabitq-index.md`).
 *
 * Every hot and warm vector gets a 1-bit code and three factors, computed here when it is written
 * and stored in SQLite (`memories_rq`). A process that searches loads them into an in-memory
 * engine: the native one (`native/`, Rust through napi-rs) when its binary loads, else
 * `TsRabitqIndex`, the reference engine below, which returns the same candidates.
 *
 * The code is the sign of each dimension of the vector's rotated residual `r = R v - R c` (`R`
 * the randomized Hadamard rotation of `binary.ts`, made orthonormal; `c` the index centroid). A
 * query is rotated, scaled to unit length and quantized to 4 bits per dimension; a vector's cosine
 * is then estimated from four popcounts per 64 dimensions, with a standard error that RaBitQ's
 * analysis gives per vector. The candidates are the vectors whose upper bound (estimate plus
 * `RABITQ_EPSILON` standard errors) reaches the k-th best lower bound; the store rescores them
 * with their int8 vectors, best upper bound first, and stops as soon as the next upper bound is
 * below its k-th exact score.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bitWidth, rotate64 } from './binary.js';

/**
 * How many standard errors the bounds allow (RaBitQ's epsilon0, the paper's 1.9). The estimate's
 * error is close to normal: 1.9 leaves about 3% of vectors outside their bound on one side, and a
 * missed vector must also be one of the k best: measured, recall@10 against the exact scan was
 * 0.999 at one million synthetic vectors and identical on the eval corpora (design §6, §11).
 */
export const RABITQ_EPSILON = 1.9;

/** Bits per dimension of the quantized query (RaBitQ's asymmetric query). */
export const RABITQ_QUERY_BITS = 4;

/** Three float32 factors per vector: `a`, `b` and `e` (see `rabitqEncode`). */
export const RABITQ_FACTORS = 3;

/** One search's candidates: row ids, best upper bound first, and the upper bounds (cosines). */
export interface RabitqCandidates {
  rids: Uint32Array;
  upper: Float64Array;
}

/** What the store needs of an in-memory engine; the native one and `TsRabitqIndex` both are. */
export interface RabitqEngine {
  readonly size: number;
  heapBytes(): number;
  /**
   * Inserts or replaces vectors: `codes` holds `width / 8` bytes per vector, `factors` three
   * per vector.
   */
  upsert(
    rids: Uint32Array,
    nodes: Uint32Array,
    projects: Uint32Array,
    authors: Uint32Array,
    codes: Buffer,
    factors: Float32Array,
  ): void;
  remove(rids: Uint32Array): void;
  clear(): void;
  /**
   * The candidates for the exact top `k` among vectors in `node` (and in `projects`, by
   * `author`, with a row id in `allow`, for each that is given). `query` is the rotated unit
   * query, `cq` its inner product with the rotated centroid.
   */
  search(
    query: Float64Array,
    cq: number,
    k: number,
    eps: number,
    node: number,
    projects?: Uint32Array | null,
    author?: number | null,
    allow?: Uint32Array | null,
  ): RabitqCandidates;
}

/** A vector's code and factors, as stored in `memories_rq`. */
export interface RabitqCode {
  code: Buffer;
  factors: Float32Array;
}

/** The rotated centroid of a stored centroid (or zeros): what `rabitqEncode` subtracts. */
export function rotatedCentroid(
  centroid: Float64Array | undefined,
  dimension: number,
): Float64Array {
  const w = bitWidth(dimension);
  if (centroid === undefined) return new Float64Array(w);
  const r = rotate64(centroid);
  for (let i = 0; i < w; i++) r[i] = (r[i] as number) / w;
  return r;
}

/**
 * The code and factors of int8 vector `v` against the rotated centroid `rc`:
 *
 * - `code`: bit i (bit i % 8 of byte i / 8) is set when `r_i > 0`;
 * - `a = |r| / (|v| f)` and `b = 1 / |v|`, so that the cosine with a unit rotated query `q` is
 *   `<rc, q> b + a <code, q>` in expectation (the code read as +-1 / sqrt(W));
 * - `e = (|r| / |v|) sqrt((1 - f^2) / f^2) / sqrt(W - 1)`, the estimate's standard error;
 *
 * with `f = sum |r_i| / (sqrt(W) |r|)`, RaBitQ's `<o_bar, o>`. A zero vector gets an infinite
 * error (it is always rescored, so its exact score decides); a vector equal to the centroid gets
 * `a = 0` and no error (its estimate is exact).
 */
export function rabitqEncode(v: Int8Array, rc: Float64Array): RabitqCode {
  const w = bitWidth(v.length);
  const rv = rotate64(v);
  const code = Buffer.alloc(w / 8);
  let nv2 = 0;
  for (let i = 0; i < v.length; i++) nv2 += (v[i] as number) * (v[i] as number);
  let nr2 = 0;
  let l1 = 0;
  for (let i = 0; i < w; i++) {
    const r = (rv[i] as number) / w - (rc[i] as number);
    nr2 += r * r;
    l1 += Math.abs(r);
    if (r > 0) code[i >> 3] = (code[i >> 3] as number) | (1 << (i & 7));
  }
  const nv = Math.sqrt(nv2);
  const nr = Math.sqrt(nr2);
  const factors = new Float32Array(RABITQ_FACTORS);
  if (nv === 0) {
    factors[2] = Infinity;
  } else if (nr === 0) {
    factors[1] = 1 / nv;
  } else {
    const f = l1 / Math.sqrt(w) / nr;
    factors[0] = nr / (nv * f);
    factors[1] = 1 / nv;
    factors[2] = ((nr / nv) * Math.sqrt(Math.max(0, 1 - f * f) / (f * f))) / Math.sqrt(w - 1);
  }
  return { code, factors };
}

/** The rotated unit query for int8 query `v` (zeros for a zero vector), and `<rc, q>`. */
export function rabitqQuery(v: Int8Array, rc: Float64Array): { query: Float64Array; cq: number } {
  const q = rotate64(v);
  let n2 = 0;
  for (const x of q) n2 += x * x;
  const n = Math.sqrt(n2);
  let cq = 0;
  for (let i = 0; i < q.length; i++) {
    q[i] = n === 0 ? 0 : (q[i] as number) / n;
    cq += (rc[i] as number) * (q[i] as number);
  }
  return { query: q, cq };
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The reference engine in TypeScript: the same arithmetic as the native one (`native/src/lib.rs`),
 * in the same order and in doubles, so both return the same candidates. Used when the native
 * binary does not load (another platform, or `rabitqEngine: 'typescript'`); about ten times
 * slower to scan (design §7).
 */
export class TsRabitqIndex implements RabitqEngine {
  private readonly words: number; // 32-bit words per code
  private codes = new Uint32Array(0);
  private factors = new Float32Array(0);
  private rids = new Uint32Array(0);
  private nodes = new Uint32Array(0);
  private projects = new Uint32Array(0);
  private authors = new Uint32Array(0);
  private n = 0;
  private readonly slotOf = new Map<number, number>();

  constructor(private readonly width: number) {
    if (!Number.isInteger(width) || width < 8 || (width & (width - 1)) !== 0) {
      throw new RangeError(`rabitq: width must be a power of two of at least 8, got ${width}`);
    }
    this.words = Math.ceil(width / 32);
  }

  get size(): number {
    return this.n;
  }

  heapBytes(): number {
    return (
      this.codes.byteLength +
      this.factors.byteLength +
      this.rids.byteLength * 4 +
      this.slotOf.size * 16
    );
  }

  private grow(need: number): void {
    if (need <= this.rids.length) return;
    const cap = Math.max(need, this.rids.length * 2, 1024);
    const grown = <T extends Uint32Array | Float32Array>(a: T, per: number): T => {
      const b = new (a.constructor as new (n: number) => T)(cap * per);
      b.set(a);
      return b;
    };
    this.codes = grown(this.codes, this.words);
    this.factors = grown(this.factors, RABITQ_FACTORS);
    this.rids = grown(this.rids, 1);
    this.nodes = grown(this.nodes, 1);
    this.projects = grown(this.projects, 1);
    this.authors = grown(this.authors, 1);
  }

  upsert(
    rids: Uint32Array,
    nodes: Uint32Array,
    projects: Uint32Array,
    authors: Uint32Array,
    codes: Buffer,
    factors: Float32Array,
  ): void {
    const n = rids.length;
    const bytes = this.width / 8;
    if (nodes.length !== n || projects.length !== n || authors.length !== n) {
      throw new RangeError('rabitq: upsert arrays differ in length');
    }
    if (codes.length !== n * bytes || factors.length !== n * RABITQ_FACTORS) {
      throw new RangeError(
        `rabitq: upsert of ${n} vectors needs ${n * bytes} code bytes and ${n * RABITQ_FACTORS} factors, got ${codes.length} and ${factors.length}`,
      );
    }
    for (let i = 0; i < n; i++) {
      const rid = rids[i] as number;
      let slot = this.slotOf.get(rid);
      if (slot === undefined) {
        slot = this.n++;
        this.grow(this.n);
        this.slotOf.set(rid, slot);
        this.rids[slot] = rid;
      }
      this.nodes[slot] = nodes[i] as number;
      this.projects[slot] = projects[i] as number;
      this.authors[slot] = authors[i] as number;
      const o = slot * this.words;
      for (let w = 0; w < this.words; w++) {
        let x = 0;
        for (let k = 0; k < 4; k++) {
          const at = i * bytes + w * 4 + k;
          if (w * 4 + k < bytes) x |= (codes[at] as number) << (8 * k);
        }
        this.codes[o + w] = x >>> 0;
      }
      this.factors.set(factors.subarray(i * 3, i * 3 + 3), slot * 3);
    }
  }

  remove(rids: Uint32Array): void {
    for (const rid of rids) {
      const slot = this.slotOf.get(rid);
      if (slot === undefined) continue;
      this.slotOf.delete(rid);
      const last = --this.n;
      if (slot !== last) {
        const moved = this.rids[last] as number;
        this.rids[slot] = moved;
        this.nodes[slot] = this.nodes[last] as number;
        this.projects[slot] = this.projects[last] as number;
        this.authors[slot] = this.authors[last] as number;
        this.codes.copyWithin(slot * this.words, last * this.words, (last + 1) * this.words);
        this.factors.copyWithin(slot * 3, last * 3, last * 3 + 3);
        this.slotOf.set(moved, slot);
      }
      this.codes.fill(0, last * this.words, (last + 1) * this.words);
      this.factors.fill(0, last * 3, last * 3 + 3);
      this.rids[last] = 0;
    }
  }

  clear(): void {
    this.codes.fill(0);
    this.factors.fill(0);
    this.codes = new Uint32Array(0);
    this.factors = new Float32Array(0);
    this.rids = new Uint32Array(0);
    this.nodes = new Uint32Array(0);
    this.projects = new Uint32Array(0);
    this.authors = new Uint32Array(0);
    this.n = 0;
    this.slotOf.clear();
  }

  search(
    query: Float64Array,
    cq: number,
    k: number,
    eps: number,
    node: number,
    projects?: Uint32Array | null,
    author?: number | null,
    allow?: Uint32Array | null,
  ): RabitqCandidates {
    const W = this.width;
    if (query.length !== W) {
      throw new RangeError(`rabitq: query has ${query.length} values, index width is ${W}`);
    }
    // Quantize the query: as `Index::prepare` in the native engine.
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    for (const x of query) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      sum += x;
    }
    const levels = (1 << RABITQ_QUERY_BITS) - 1;
    let delta = (hi - lo) / levels;
    const words = this.words;
    const planes = new Uint32Array(RABITQ_QUERY_BITS * words);
    if (delta > 0) {
      for (let i = 0; i < W; i++) {
        const u = Math.min(
          levels,
          Math.max(0, Math.floor(((query[i] as number) - lo) / delta + 0.5)),
        );
        for (let j = 0; j < RABITQ_QUERY_BITS; j++) {
          if ((u & (1 << j)) !== 0) {
            const at = j * words + (i >> 5);
            planes[at] = ((planes[at] as number) | (1 << (i & 31))) >>> 0;
          }
        }
      }
    } else delta = 0;
    const sqrtW = Math.sqrt(W);

    const outRid: number[] = [];
    const outUpper: number[] = [];
    const outLower: number[] = [];
    const visit = (s: number): void => {
      if (this.nodes[s] !== node) return;
      if (projects != null && !projects.includes(this.projects[s] as number)) return;
      if (author != null && this.authors[s] !== author) return;
      const o = s * words;
      let acc = 0;
      let pop = 0;
      for (let w = 0; w < words; w++) {
        const c = this.codes[o + w] as number;
        pop += popcount(c);
        for (let j = 0; j < RABITQ_QUERY_BITS; j++) {
          acc += popcount(c & (planes[j * words + w] as number)) * (1 << j);
        }
      }
      const a = this.factors[s * 3] as number;
      const b = this.factors[s * 3 + 1] as number;
      const e = this.factors[s * 3 + 2] as number;
      const sbq = delta * acc + lo * pop;
      const ip = (2 * sbq - sum) / sqrtW;
      const est = cq * b + a * ip;
      const qe = a * delta;
      const sd = Math.sqrt(e * e + (qe * qe * pop) / (3 * W));
      outRid.push(this.rids[s] as number);
      outUpper.push(est + eps * sd);
      outLower.push(est - eps * sd);
    };
    if (allow != null) {
      for (const rid of allow) {
        const s = this.slotOf.get(rid);
        if (s !== undefined) visit(s);
      }
    } else {
      for (let s = 0; s < this.n; s++) visit(s);
    }
    if (k <= 0 || outRid.length === 0) {
      return { rids: new Uint32Array(0), upper: new Float64Array(0) };
    }
    const tau =
      outRid.length <= k
        ? -Infinity
        : (Float64Array.from(outLower).sort().reverse()[k - 1] as number);
    const kept: number[] = [];
    for (let i = 0; i < outRid.length; i++) if ((outUpper[i] as number) >= tau) kept.push(i);
    kept.sort(
      (x, y) =>
        (outUpper[y] as number) - (outUpper[x] as number) ||
        (outRid[x] as number) - (outRid[y] as number),
    );
    return {
      rids: Uint32Array.from(kept, (i) => outRid[i] as number),
      upper: Float64Array.from(kept, (i) => outUpper[i] as number),
    };
  }
}

/** Which engine a store asks for: the native one when it loads (`auto`), or one of the two. */
export type RabitqEngineChoice = 'auto' | 'native' | 'typescript';

/** The platform tag of this process's prebuilt binary, e.g. `darwin-arm64`, `linux-x64-gnu`. */
export function nativePlatformTag(): string {
  if (process.platform !== 'linux') return `${process.platform}-${process.arch}`;
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
    ?.header;
  return `linux-${process.arch}-${header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu'}`;
}

/** Where this package keeps its prebuilt binaries: `native/` beside `dist/` (or `src/`). */
export function nativeDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native');
}

type NativeModule = { RabitqIndex: new (width: number) => RabitqEngine };

let nativeLoad: { module: NativeModule } | { error: string } | undefined;

/**
 * The native engine's constructor, or why it did not load: no binary for this platform
 * (`oort-rabitq.<tag>.node` in `dir`, default `nativeDir()`), one that fails to load, or
 * `OORT_RABITQ_NATIVE=0` in the environment. Loaded once per process from the default
 * directory. Never throws.
 */
export function loadNativeRabitq(dir?: string): { module: NativeModule } | { error: string } {
  // The off switch, for a native engine that misbehaves somewhere: the TypeScript engine answers.
  if (process.env['OORT_RABITQ_NATIVE'] === '0') {
    return { error: 'turned off by OORT_RABITQ_NATIVE=0' };
  }
  if (dir === undefined && nativeLoad !== undefined) return nativeLoad;
  const tag = nativePlatformTag();
  const file = path.join(dir ?? nativeDir(), `oort-rabitq.${tag}.node`);
  let result: { module: NativeModule } | { error: string };
  if (!fs.existsSync(file)) {
    result = { error: `no prebuilt binary for ${tag}` };
  } else {
    try {
      const module = createRequire(import.meta.url)(file) as NativeModule;
      if (typeof module.RabitqIndex !== 'function') throw new Error('RabitqIndex is missing');
      result = { module };
    } catch (e) {
      result = {
        error: `the ${tag} binary did not load (${(e as Error).message.split('\n')[0]})`,
      };
    }
  }
  if (dir === undefined) nativeLoad = result;
  return result;
}

/**
 * An engine for codes of `width` bits: native when asked for and available (`auto` falls back to
 * TypeScript and says why; `native` throws when it cannot load).
 */
export function createRabitqEngine(
  width: number,
  choice: RabitqEngineChoice = 'auto',
): { engine: RabitqEngine; kind: 'native' | 'typescript'; fallback?: string } {
  if (choice !== 'typescript') {
    const loaded = loadNativeRabitq();
    if ('module' in loaded) {
      return { engine: new loaded.module.RabitqIndex(width), kind: 'native' };
    }
    if (choice === 'native')
      throw new Error(`rabitq: the native engine is unavailable: ${loaded.error}`);
    return { engine: new TsRabitqIndex(width), kind: 'typescript', fallback: loaded.error };
  }
  return { engine: new TsRabitqIndex(width), kind: 'typescript' };
}
