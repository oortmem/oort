/**
 * Loaded by the bin on a hook that `oort serve` answered, so it imports nothing.
 *
 * `OORT_HOOK_TIMING=1`: the one stderr line with where a hook's time went, `oort-timing {json}`,
 * each timing rounded to 0.1 ms. Numbers only (the hook log's own timings): never a prompt, a
 * memory or a key.
 */
export function timingLine(via: string, timings: Record<string, number>): string {
  const t: Record<string, number> = {};
  for (const [k, v] of Object.entries(timings)) {
    if (Number.isFinite(v)) t[k] = Math.round(v * 10) / 10;
  }
  return `oort-timing ${JSON.stringify({ via, ...t })}\n`;
}
