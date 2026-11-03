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
