/** A small seeded PRNG (mulberry32): the same seed always yields the same stream. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform integer in [lo, hi]. */
  range(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  /**
   * A uniformly shuffled copy (Fisher-Yates). It draws exactly `xs.length - 1` values, so the
   * stream stays the same on every JavaScript engine, unlike `sort` with a random comparator.
   */
  shuffle<T>(xs: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    pick: (xs) => xs[int(xs.length)] as (typeof xs)[number],
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
  };
}
