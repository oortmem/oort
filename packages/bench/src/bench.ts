import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  consolidate,
  isCurrent,
  recall,
  resolveConfig,
  tokenizeLexical,
  type Embedder,
  type Memory,
  type MemoryStore,
  type RecallDeps,
  type Reranker,
  type ResolvedConfig,
  type Tier,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { fakeEmbedder } from './fake-embed.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { createRng } from './prng.js';
import { ALL_SCOPE, seedStore } from './seed.js';
import { collectGarbage, dirBytes, fileBytes, percentile, rssMb, toMb } from './stats.js';

export interface BenchOptions {
  /** Memories to seed (default 10,000). */
  count?: number;
  seed?: number;
  /** Latency queries per path (default 200). */
  queries?: number;
  /** Run the Voyage adapters too (needs `VOYAGE_API_KEY`); capped at 20 queries. */
  real?: boolean;
  log?: (message: string) => void;
}

interface Env {
  dir: string;
  dbPath: string;
  coldDir: string;
  store: MemoryStore;
  config: ResolvedConfig;
  memories: Memory[];
  close(): Promise<void>;
}

/** A fresh SQLite store in a temp directory; nothing under the real `$OORT_HOME` is touched. */
async function openEnv(count: number, seed: number): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-bench-'));
  const dbPath = path.join(dir, 'oort.sqlite');
  const coldDir = path.join(dir, 'cold');
  const store = await openSqliteStore({
    path: dbPath,
    coldDir,
    dimension: EMBEDDING_DIMENSION,
    log: () => {},
  });
  const config = resolveConfig(dir, { OORT_HOME: dir }, { projectConfig: false });
  const memories = generateMemories(count, seed);
  return {
    dir,
    dbPath,
    coldDir,
    store,
    config,
    memories,
    async close() {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Search-style queries: 3 to 5 distinctive stub tokens of a random memory. */
export function makeQueries(memories: Memory[], count: number, seed: number): string[] {
  const rng = createRng(seed ^ 0x9e3779b9);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = rng.pick(memories);
    out.push(queryFor(m, rng));
  }
  return out;
}

function queryFor(m: Memory, rng: ReturnType<typeof createRng>): string {
  const tokens = [...new Set(tokenizeLexical(m.stub))].filter((t) => t.length >= 4);
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [tokens[i], tokens[j]] = [tokens[j] as string, tokens[i] as string];
  }
  return tokens.slice(0, rng.range(3, 5)).join(' ');
}

function deps(env: Env, extra: { embed?: Embedder; rerank?: Reranker } = {}): RecallDeps {
  return { store: env.store, config: env.config, now: GENERATOR_NOW, ...extra };
}

async function timedRecalls(
  env: Env,
  queries: string[],
  extra: { embed?: Embedder; rerank?: Reranker } = {},
): Promise<number[]> {
  const times: number[] = [];
  for (const text of queries) {
    const t = performance.now();
    await recall({ text, scope: ALL_SCOPE }, deps(env, extra));
    times.push(performance.now() - t);
  }
  return times;
}

export interface RssResult {
  memories: number;
  beforeMb: number;
  afterSeedMb: number;
  afterRecallMb: number;
  /** After 100 lexical recalls minus before seeding. */
  deltaMb: number;
}

/** RSS before seeding, after seeding and after 100 lexical recalls (GC between phases when exposed). */
export async function measureRss(opts: { count: number; seed: number }): Promise<RssResult> {
  const env = await openEnv(opts.count, opts.seed);
  try {
    collectGarbage();
    const beforeMb = rssMb();
    await seedStore(env.store, env.memories);
    collectGarbage();
    const afterSeedMb = rssMb();
    await timedRecalls(env, makeQueries(env.memories, 100, opts.seed));
    collectGarbage();
    const afterRecallMb = rssMb();
    return {
      memories: env.memories.length,
      beforeMb,
      afterSeedMb,
      afterRecallMb,
      deltaMb: afterRecallMb - beforeMb,
    };
  } finally {
    await env.close();
  }
}

export interface CallProfile {
  method: string;
  calls: number;
  totalMs: number;
}

/** Wraps `store` so every method's call count and wall time are recorded. */
export function profileStore(store: MemoryStore): { store: MemoryStore; profile(): CallProfile[] } {
  const stats = new Map<string, CallProfile>();
  const wrapped = {} as Record<string, unknown>;
  for (const key of Object.keys(store) as (keyof MemoryStore)[]) {
    const fn = store[key] as (...args: unknown[]) => Promise<unknown>;
    wrapped[key] = async (...args: unknown[]) => {
      const t = performance.now();
      try {
        return await fn.apply(store, args);
      } finally {
        const s = stats.get(key) ?? { method: key, calls: 0, totalMs: 0 };
        s.calls++;
        s.totalMs += performance.now() - t;
        stats.set(key, s);
      }
    };
  }
  return {
    store: wrapped as unknown as MemoryStore,
    profile: () => [...stats.values()].sort((a, b) => b.totalMs - a.totalMs),
  };
}

export interface ConsolidateRun {
  firstMs: number;
  secondMs: number;
  evicted: number;
  promoted: number;
  demoted: number;
  profile: CallProfile[];
}

async function runConsolidate(env: Env): Promise<ConsolidateRun> {
  const { store, profile } = profileStore(env.store);
  const run = async (): Promise<{ ms: number; r: Awaited<ReturnType<typeof consolidate>> }> => {
    const t = performance.now();
    const r = await consolidate(ALL_SCOPE, { store, config: env.config, now: GENERATOR_NOW });
    return { ms: performance.now() - t, r };
  };
  const first = await run();
  const firstProfile = profile();
  const second = await run();
  return {
    firstMs: first.ms,
    secondMs: second.ms,
    evicted: first.r.evicted.length,
    promoted: first.r.promoted.length,
    demoted: first.r.demoted.length,
    profile: firstProfile,
  };
}

/** Seeds `count` memories and times `consolidate` (first and second run, same `now`). */
export async function measureConsolidate(opts: {
  count: number;
  seed: number;
}): Promise<ConsolidateRun> {
  const env = await openEnv(opts.count, opts.seed);
  try {
    await seedStore(env.store, env.memories);
    return await runConsolidate(env);
  } finally {
    await env.close();
  }
}

export interface RealResult {
  queries: number;
  p50Ms: number;
  p95Ms: number;
  degraded: number;
  /** Estimated tokens at about 4 characters each; embedding queries plus rerank query and documents. */
  estimatedEmbedTokens: number;
  estimatedRerankTokens: number;
}

export interface BenchResult {
  memories: number;
  rss: { beforeMb: number; afterSeedMb: number; afterRecallMb: number };
  sqliteMb: { beforeConsolidate: number; afterConsolidate: number; walAfterConsolidate: number };
  coldMb: { before: number; after: number };
  lexical: { queries: number; p50Ms: number; p95Ms: number };
  dense: { queries: number; p50Ms: number; p95Ms: number };
  consolidate: ConsolidateRun;
  tiers: Record<Tier, number>;
  coldHydration: { hits: number; hydrated: number; p50Ms: number; hydrateP50Ms: number };
  real?: RealResult | { skipped: string };
}

async function runReal(env: Env, queries: string[]): Promise<RealResult | { skipped: string }> {
  const apiKey = process.env['VOYAGE_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    return { skipped: 'VOYAGE_API_KEY is not set' };
  }
  const { voyageEmbedder } = await import('@oortmem/embed-voyage');
  const { voyageReranker } = await import('@oortmem/rerank-voyage');
  const base = voyageEmbedder({
    apiKey,
    model: env.config.embed.model,
    dimension: env.config.embed.dimension,
  });
  const baseRerank = voyageReranker({ apiKey, model: env.config.rerank.model });
  let embedChars = 0;
  let rerankChars = 0;
  const embed: Embedder = {
    dimension: base.dimension,
    embed(texts, kind) {
      embedChars += texts.reduce((n, t) => n + t.length, 0);
      return base.embed(texts, kind);
    },
  };
  const rerank: Reranker = {
    rerank(query, docs, topK) {
      rerankChars += query.length + docs.reduce((n, d) => n + d.text.length, 0);
      return baseRerank.rerank(query, docs, topK);
    },
  };
  const capped = queries.slice(0, 20);
  const times: number[] = [];
  let degraded = 0;
  for (const text of capped) {
    const t = performance.now();
    const r = await recall({ text, scope: ALL_SCOPE }, deps(env, { embed, rerank }));
    times.push(performance.now() - t);
    if (r.degraded?.some((d) => d === 'embed-failed' || d === 'rerank-failed')) degraded++;
  }
  return {
    queries: capped.length,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    degraded,
    estimatedEmbedTokens: Math.ceil(embedChars / 4),
    estimatedRerankTokens: Math.ceil(rerankChars / 4),
  };
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const count = opts.count ?? 10_000;
  const seed = opts.seed ?? 42;
  const nQueries = opts.queries ?? 200;
  const log = opts.log ?? (() => {});
  const env = await openEnv(count, seed);
  try {
    collectGarbage();
    const beforeMb = rssMb();
    log(`seeding ${count} memories`);
    await seedStore(env.store, env.memories);
    collectGarbage();
    const afterSeedMb = rssMb();

    log('100 lexical recalls (RSS)');
    await timedRecalls(env, makeQueries(env.memories, 100, seed));
    collectGarbage();
    const afterRecallMb = rssMb();

    const queries = makeQueries(env.memories, nQueries, seed + 1);
    log(`${nQueries} lexical-only recalls`);
    const lexical = await timedRecalls(env, queries);
    log(`${nQueries} dense recalls (fake embedder)`);
    const dense = await timedRecalls(env, queries, { embed: fakeEmbedder(EMBEDDING_DIMENSION) });

    const sqliteBefore = fileBytes(env.dbPath) + fileBytes(`${env.dbPath}-wal`);
    const coldBefore = dirBytes(env.coldDir);

    log('consolidate (twice)');
    const consolidateRun = await runConsolidate(env);

    const sqliteAfter = fileBytes(env.dbPath) + fileBytes(`${env.dbPath}-wal`);
    const coldAfter = dirBytes(env.coldDir);

    const all = await env.store.list(ALL_SCOPE, { validOnly: false });
    const tiers: Record<Tier, number> = { hot: 0, warm: 0, cold: 0 };
    for (const m of all) tiers[m.tier]++;

    // Cold hydration: recall 20 distinct current cold memories by their stubs.
    const rng = createRng(seed + 2);
    const coldCurrent = all.filter((m) => m.tier === 'cold' && isCurrent(m, GENERATOR_NOW));
    const picked: Memory[] = [];
    while (picked.length < 20 && coldCurrent.length > 0) {
      picked.push(coldCurrent.splice(rng.int(coldCurrent.length), 1)[0] as Memory);
    }
    const coldTimes: number[] = [];
    const hydrateTimes: number[] = [];
    let hydrated = 0;
    for (const m of picked) {
      // Every distinctive stub word, so the cold memory is in the lexical candidates.
      const text = [...new Set(tokenizeLexical(m.stub))].filter((t) => t.length >= 4).join(' ');
      const t = performance.now();
      const r = await recall({ text, scope: ALL_SCOPE }, deps(env));
      coldTimes.push(performance.now() - t);
      // Recall hydrates every cold candidate, returned or not; the target is hydrated when it left cold.
      if ((await env.store.get(m.id))?.tier !== 'cold') {
        hydrated++;
        hydrateTimes.push(r.timings['hydrateMs'] ?? 0);
      }
    }

    const result: BenchResult = {
      memories: all.length,
      rss: { beforeMb, afterSeedMb, afterRecallMb },
      sqliteMb: {
        beforeConsolidate: toMb(sqliteBefore),
        afterConsolidate: toMb(sqliteAfter),
        walAfterConsolidate: toMb(fileBytes(`${env.dbPath}-wal`)),
      },
      coldMb: { before: toMb(coldBefore), after: toMb(coldAfter) },
      lexical: {
        queries: nQueries,
        p50Ms: percentile(lexical, 50),
        p95Ms: percentile(lexical, 95),
      },
      dense: { queries: nQueries, p50Ms: percentile(dense, 50), p95Ms: percentile(dense, 95) },
      consolidate: consolidateRun,
      tiers,
      coldHydration: {
        hits: picked.length,
        hydrated,
        p50Ms: percentile(coldTimes, 50),
        hydrateP50Ms: percentile(hydrateTimes, 50),
      },
    };
    if (opts.real === true) {
      log('real adapters (20 queries max)');
      result.real = await runReal(env, queries);
    }
    return result;
  } finally {
    await env.close();
  }
}

const f1 = (n: number): string => n.toFixed(1);
const f2 = (n: number): string => n.toFixed(2);
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${f1(n)}`;

/** The Markdown report `pnpm bench` prints. */
export function renderMarkdown(r: BenchResult): string {
  const rows: [string, string][] = [
    ['Memories', String(r.memories)],
    ['RSS before seeding', `${f1(r.rss.beforeMb)} MB`],
    [
      'RSS after seeding',
      `${f1(r.rss.afterSeedMb)} MB (${signed(r.rss.afterSeedMb - r.rss.beforeMb)} MB)`,
    ],
    [
      'RSS after 100 recalls',
      `${f1(r.rss.afterRecallMb)} MB (${signed(r.rss.afterRecallMb - r.rss.beforeMb)} MB)`,
    ],
    ['SQLite file + WAL, before consolidate', `${f2(r.sqliteMb.beforeConsolidate)} MB`],
    [
      'SQLite file + WAL, after consolidate',
      `${f2(r.sqliteMb.afterConsolidate)} MB (WAL ${f2(r.sqliteMb.walAfterConsolidate)} MB)`,
    ],
    ['Cold dir, before consolidate', `${f2(r.coldMb.before)} MB`],
    ['Cold dir, after consolidate', `${f2(r.coldMb.after)} MB`],
    [
      `recall lexical-only p50 / p95 (${r.lexical.queries} queries)`,
      `${f2(r.lexical.p50Ms)} / ${f2(r.lexical.p95Ms)} ms`,
    ],
    [
      `recall dense, fake embedder p50 / p95 (${r.dense.queries} queries)`,
      `${f2(r.dense.p50Ms)} / ${f2(r.dense.p95Ms)} ms`,
    ],
    ['consolidate, first run', `${f1(r.consolidate.firstMs)} ms`],
    ['consolidate, second run', `${f1(r.consolidate.secondMs)} ms`],
    [
      'consolidate first run moves',
      `${r.consolidate.evicted} to cold, ${r.consolidate.promoted} promoted, ${r.consolidate.demoted} demoted (incl. evicted)`,
    ],
    [
      'Tier counts after consolidate',
      `hot ${r.tiers.hot}, warm ${r.tiers.warm}, cold ${r.tiers.cold}`,
    ],
    [
      `Cold hydration p50, recall total (${r.coldHydration.hits} cold hits)`,
      `${f2(r.coldHydration.p50Ms)} ms`,
    ],
    [
      'Cold hydration p50, hydrate step only',
      `${f2(r.coldHydration.hydrateP50Ms)} ms (${r.coldHydration.hydrated} of ${r.coldHydration.hits} hydrated)`,
    ],
  ];
  if (r.real !== undefined) {
    if ('skipped' in r.real) {
      rows.push(['Real adapters (Voyage)', `skipped: ${r.real.skipped}`]);
    } else {
      const x = r.real;
      rows.push(
        [
          `recall real embedder + reranker p50 / p95 (${x.queries} queries)`,
          `${f2(x.p50Ms)} / ${f2(x.p95Ms)} ms (${x.degraded} degraded)`,
        ],
        [
          'Estimated API tokens (about 4 chars each)',
          `embed ${x.estimatedEmbedTokens}, rerank ${x.estimatedRerankTokens}`,
        ],
      );
    }
  }
  const lines = ['| Metric | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
  const profile = r.consolidate.profile
    .slice(0, 6)
    .map((p) => `| ${p.method} | ${p.calls} | ${f1(p.totalMs)} |`);
  return [
    ...lines,
    '',
    'Store calls during the first consolidate (by total time):',
    '',
    '| Store call | Calls | Total ms |',
    '| --- | --- | --- |',
    ...profile,
    '',
  ].join('\n');
}
