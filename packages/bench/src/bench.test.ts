import { beforeAll, describe, expect, it } from 'vitest';
import { measureConsolidate, measureRss, RSS_NOTE_MB, type ConsolidateRun } from './bench.js';

it('bench.synthetic-10k-under-150mb', { retry: 1 }, async () => {
  expect(
    typeof (globalThis as { gc?: unknown }).gc,
    'global.gc is missing: the bench vitest project must run with --expose-gc (execArgv in vitest.config.ts)',
  ).toBe('function');
  const r = await measureRss({ count: 10_000, seed: 1 });
  expect(r.memories).toBe(10_000);
  const note = `RSS delta: ${r.lexicalDeltaMb.toFixed(1)} MB after 100 lexical recalls, ${r.denseDeltaMb.toFixed(1)} MB after 100 more dense recalls`;
  if (r.deltaMb > RSS_NOTE_MB) {
    console.warn(`regression note: ${note}; above ${RSS_NOTE_MB} MB (the bound is 150 MB)`);
  } else {
    console.info(note);
  }
  expect(r.deltaMb).toBeLessThan(150);
});

describe('consolidate on 10k memories', () => {
  let run: ConsolidateRun;
  beforeAll(async () => {
    run = await measureConsolidate({ count: 10_000, seed: 1 });
  });

  it('bench.consolidate-10k-completes', () => {
    expect(run.evicted).toBeGreaterThan(0);
    expect(run.skipped).toBe(0); // nothing writes concurrently here
    expect(Number.isFinite(run.firstMs)).toBe(true);
    expect(run.secondMs).toBeLessThan(run.firstMs);
  });

  // A 30 s bound, not the 10 s target: wall-clock bounds in the default suite
  // flake under load. The 10 s target is judged from `pnpm bench` numbers.
  it('bench.consolidate-10k-under-30s', () => {
    expect(run.firstMs).toBeLessThan(30_000);
  });
});
