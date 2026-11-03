import * as fs from 'node:fs';
import * as path from 'node:path';

/** Nearest-rank percentile (p in 0..100) of `xs`; 0 for an empty list. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

export const toMb = (bytes: number): number => bytes / (1024 * 1024);

/** Size of a file in bytes, 0 when it does not exist. */
export function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Total size in bytes of every file under `dir` (0 when missing). */
export function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : fileBytes(p);
  }
  return total;
}

/** Runs the garbage collector when the process was started with `--expose-gc`. */
export function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
}

export const rssMb = (): number => toMb(process.memoryUsage().rss);

export interface Latency {
  /** Samples pooled across the repeated runs. */
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** The lowest and highest p95 among the repeated runs. */
  p95MinMs: number;
  p95MaxMs: number;
}

/** p50/p95/p99 of the pooled samples, and the spread of p95 across the runs. */
export function summarize(runs: number[][]): Latency {
  const pooled = runs.flat();
  const p95s = runs.map((r) => percentile(r, 95));
  return {
    samples: pooled.length,
    p50Ms: percentile(pooled, 50),
    p95Ms: percentile(pooled, 95),
    p99Ms: percentile(pooled, 99),
    p95MinMs: Math.min(...p95s),
    p95MaxMs: Math.max(...p95s),
  };
}
