/**
 * The links latency bar (CON-146, design section 11): recall p50 / p95 / p99 with links off and
 * on, at 100k and 1M memories, and the gather step's own p50 / p99, on the cached link-shaped
 * stores (`linked-store.ts`).
 *
 * Three recall paths, all without a model or network: `lexical` (no query embedding), `fast` (the
 * fake embedder, no reranker: the prompt hook's default) and `full` (the fake embedder and the
 * fake reranker: the path a neighbour joins the rerank call on). Measured recalls run on a
 * `frozen()` store, after the store's own warm-up.
 */
import { recall, type Embedder, type Reranker, type ResolvedConfig } from '@oortmem/core';
import { frozen } from './bench.js';
import { fakeEmbedder } from './fake-embed.js';
import { fakeReranker } from './fake-rerank.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW } from './generate.js';
import { benchConfig, openLinkedStore, type LinkedManifest } from './linked-store.js';
import { GATHER_TIMING, linksOverride, linksSupported, type LinksMode } from './links.js';
import { createRng } from './prng.js';
import { ALL_SCOPE } from './seed.js';
import { percentile, summarize, type Latency } from './stats.js';

export const RECALL_PATHS = ['lexical', 'fast', 'full'] as const;
export type RecallPath = (typeof RECALL_PATHS)[number];

export type LinksWhich = 'off' | 'on' | 'both';

export interface LinksLatencyOptions {
  /** Store sizes (default 100,000 and 1,000,000). */
  counts?: number[];
  seed?: number;
  /** Measured queries per run (default 200). */
  queries?: number;
  /** Runs per path and links setting (default 3). Each run has its own query sample. */
  repeats?: number;
  /** Unmeasured queries at the start of each run (default 20). */
  warmup?: number;
  paths?: RecallPath[];
  /** `both` (default) measures links on only when this build has `recall.links`. */
  links?: LinksWhich;
  cacheDir?: string;
  rebuild?: boolean;
  log?: (message: string) => void;
}

export interface GatherLatency {
  samples: number;
  p50Ms: number;
  p99Ms: number;
}

export interface PathResult {
  path: RecallPath;
  off: Latency;
  on?: Latency;
  /** On minus off, at p95 and p99. */
  deltaP95Ms?: number;
  deltaP99Ms?: number;
  /** The gather step's own time (`timings.linksMs`) with links on. */
  gather?: GatherLatency;
}

export interface StoreResult {
  count: number;
  manifest: LinkedManifest;
  bytes: number;
  vectorIndex: string;
  /** True when this run built the store (or re-ran its warm-up). */
  built: boolean;
  paths: PathResult[];
}

export interface LinksLatencyResult {
  /** Whether this build has `recall.links`; without it only links off is measured. */
  linksAvailable: boolean;
  queries: number;
  repeats: number;
  warmup: number;
  stores: StoreResult[];
}

function depsFor(path: RecallPath): { embed?: Embedder; rerank?: Reranker } {
  if (path === 'lexical') return {};
  const embed = fakeEmbedder(EMBEDDING_DIMENSION);
  return path === 'fast' ? { embed } : { embed, rerank: fakeReranker() };
}

export async function runLinksLatency(opts: LinksLatencyOptions = {}): Promise<LinksLatencyResult> {
  const counts = opts.counts ?? [100_000, 1_000_000];
  const seed = opts.seed ?? 42;
  const n = opts.queries ?? 200;
  const repeats = opts.repeats ?? 3;
  const warmup = opts.warmup ?? 20;
  const paths = opts.paths ?? [...RECALL_PATHS];
  const log = opts.log ?? (() => {});
  const stores: StoreResult[] = [];
  let available = false;
  for (const count of counts) {
    const linked = await openLinkedStore({
      count,
      seed,
      log,
      ...(opts.cacheDir !== undefined && { cacheDir: opts.cacheDir }),
      ...(opts.rebuild === true && { rebuild: true }),
    });
    try {
      const config = benchConfig(linked.dir);
      available = linksSupported(config);
      const which = opts.links ?? 'both';
      if (which === 'on' && !available) linksOverride('all', config); // throws, naming CON-149
      const modes: LinksMode[] =
        which === 'off' ? ['off'] : which === 'on' ? ['all'] : available ? ['off', 'all'] : ['off'];
      const store = frozen(linked.store);
      const results: PathResult[] = [];
      for (const path of paths) {
        const extra = depsFor(path);
        const byMode = new Map<LinksMode, { latency: Latency; gather: number[] }>();
        for (const mode of modes) {
          const recallConfig = {
            ...config,
            recall: { ...config.recall, ...linksOverride(mode, config) },
          } as ResolvedConfig;
          const runs: number[][] = [];
          const gather: number[] = [];
          for (let run = 0; run < repeats; run++) {
            // The same samples for off and on, so the delta compares like with like.
            const rng = createRng(seed * 31 + run);
            const sample = Array.from({ length: warmup + n }, () => rng.pick(linked.queries));
            const times: number[] = [];
            for (const [i, text] of sample.entries()) {
              const t = performance.now();
              const r = await recall(
                { text, scope: ALL_SCOPE },
                { store, config: recallConfig, now: GENERATOR_NOW, ...extra },
              );
              const ms = performance.now() - t;
              if (i < warmup) continue;
              times.push(ms);
              const g = r.timings[GATHER_TIMING];
              if (g !== undefined) gather.push(g);
            }
            runs.push(times);
          }
          byMode.set(mode, { latency: summarize(runs), gather });
          log(
            `  ${count} ${path} links ${mode}: p95 ${byMode.get(mode)?.latency.p95Ms.toFixed(2)} ms`,
          );
        }
        const off = byMode.get('off') ?? byMode.get('all');
        const on = modes.includes('all') ? byMode.get('all') : undefined;
        const result: PathResult = { path, off: (off as { latency: Latency }).latency };
        if (on !== undefined && byMode.has('off')) {
          result.on = on.latency;
          result.deltaP95Ms = on.latency.p95Ms - result.off.p95Ms;
          result.deltaP99Ms = on.latency.p99Ms - result.off.p99Ms;
        }
        if (on !== undefined && on.gather.length > 0) {
          result.gather = {
            samples: on.gather.length,
            p50Ms: percentile(on.gather, 50),
            p99Ms: percentile(on.gather, 99),
          };
        }
        results.push(result);
      }
      stores.push({
        count,
        manifest: linked.manifest,
        bytes: linked.bytes,
        vectorIndex: linked.vectorIndex?.index ?? 'unknown',
        built: linked.built,
        paths: results,
      });
    } finally {
      await linked.close();
    }
  }
  return { linksAvailable: available, queries: n, repeats, warmup, stores };
}

const f2 = (x: number): string => x.toFixed(2);
const lat = (l: Latency): string => `${f2(l.p50Ms)} / ${f2(l.p95Ms)} / ${f2(l.p99Ms)}`;
const signed = (x: number | undefined): string =>
  x === undefined ? '-' : `${x >= 0 ? '+' : ''}${f2(x)}`;

/** The Markdown report `pnpm bench --suite links` prints. */
export function renderLinksLatency(r: LinksLatencyResult): string {
  const out: string[] = [];
  out.push(
    r.linksAvailable
      ? 'Links: measured off and on (`recall.links`, every kind).'
      : 'Links: off only. This build has no `recall.links` (CON-149), so the "on" columns and the gather step are `-`: this is the baseline the bar is held to.',
    '',
  );
  for (const s of r.stores) {
    const st = s.manifest.stats;
    const w = s.manifest.warmUp;
    out.push(
      `### ${s.count.toLocaleString('en-US')} memories`,
      '',
      `Store: ${(s.bytes / 1024 / 1024).toFixed(0)} MB, ${s.vectorIndex} vector index; ${st.sessions} sessions (longest ${st.longestSession}), ${st.turns} turns; ${st.entities} entities, ${st.hubs} with 50 or more memories, median ${st.medianFan} memories per entity; top: ${st.topEntities
        .slice(0, 5)
        .map(([e, c]) => `${e} ${c}`)
        .join(
          ', ',
        )}. ${s.built ? 'Built' : 'Cached'} (build ${(s.manifest.buildMs / 60_000).toFixed(1)} min).`,
      '',
      `Warm-up: ${w.queries} recalls with access recording live (${w.accessCalls} access records of ${w.accessIds} memories), links ${w.links ? 'on' : 'absent'}; learned pairs: ${w.pairs ?? '- (no link table)'}.`,
      '',
      '| Path | Links off p50 / p95 / p99 ms | Links on p50 / p95 / p99 ms | p95 delta | p99 delta | Gather p50 / p99 ms |',
      '| --- | --- | --- | --- | --- | --- |',
      ...s.paths.map(
        (p) =>
          `| ${p.path} | ${lat(p.off)} | ${p.on === undefined ? '-' : lat(p.on)} | ${signed(p.deltaP95Ms)} | ${signed(p.deltaP99Ms)} | ${p.gather === undefined ? '-' : `${f2(p.gather.p50Ms)} / ${f2(p.gather.p99Ms)}`} |`,
      ),
      '',
    );
  }
  out.push(
    `Each cell pools ${r.repeats} runs of ${r.queries} queries (${r.warmup} unmeasured first); links off and on use the same query samples. \`lexical\`: no query embedding; \`fast\`: the fake embedder, no reranker (the prompt hook's default); \`full\`: the fake embedder and the fake reranker. Measured on a \`frozen()\` store after the warm-up.`,
    '',
  );
  return out.join('\n');
}
