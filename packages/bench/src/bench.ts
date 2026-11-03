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
import {
  collectGarbage,
  dirBytes,
  fileBytes,
  percentile,
  rssMb,
  summarize,
  toMb,
  type Latency,
} from './stats.js';

export interface BenchOptions {
  /** Memories to seed (default 10,000). */
  count?: number;
  seed?: number;
  /** Measured latency queries per run (default 200). */
  queries?: number;
  /** Run the Voyage adapters too (needs `VOYAGE_API_KEY`); capped at 20 queries. */
  real?: boolean;
  /**
   * Called with the token estimate before any Voyage call; `--real` proceeds
   * only when it resolves true. Without it, `--real` never calls Voyage.
   */
  confirmReal?: (estimate: RealEstimate) => Promise<boolean>;
  log?: (message: string) => void;
}

/** `--real` was requested but not confirmed, so no Voyage call was made. */
export class RealNotConfirmedError extends Error {
  constructor() {
    super('--real not confirmed: no Voyage call was made (pass --yes to proceed)');
    this.name = 'RealNotConfirmedError';
  }
}

export interface RealEstimate {
  queries: number;
  /** Tokens at about 4 characters each. */
  embedTokens: number;
  rerankTokens: number;
}

const WARMUP = 20;
const REPEATS = 3;
const RSS_RECALLS = 100;
const REAL_QUERIES = 20;

interface Env {
  dir: string;
  dbPath: string;
  coldDir: string;
  store: MemoryStore;
  config: ResolvedConfig;
  close(): Promise<void>;
}

/** A fresh SQLite store in a temp directory; nothing under the real `$OORT_HOME` is touched. */
async function openEnv(): Promise<Env> {
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
  return {
    dir,
    dbPath,
    coldDir,
    store,
    config,
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

/**
 * Every query list the bench needs, drawn from the generated memories up
 * front so the memories themselves can be released before RSS is read. Each
 * measured run and path gets its own sample.
 */
interface Plan {
  rssLexical: string[];
  rssDense: string[];
  /** `REPEATS` runs of `WARMUP + n` queries each. */
  lexicalRuns: string[][];
  denseRuns: string[][];
  postLexical: string[];
  postDense: string[];
  real: string[];
  meanTextChars: number;
}

function makePlan(memories: Memory[], seed: number, n: number): Plan {
  const q = (offset: number, count: number): string[] =>
    makeQueries(memories, count, seed + offset);
  const runs = (base: number): string[][] =>
    Array.from({ length: REPEATS }, (_, i) => q(base + i, WARMUP + n));
  return {
    rssLexical: q(100, RSS_RECALLS),
    rssDense: q(101, RSS_RECALLS),
    lexicalRuns: runs(110),
    denseRuns: runs(120),
    postLexical: q(130, WARMUP + n),
    postDense: q(131, WARMUP + n),
    real: q(140, REAL_QUERIES),
    meanTextChars: memories.reduce((a, m) => a + m.text.length, 0) / Math.max(memories.length, 1),
  };
}

export function estimateReal(plan: Plan, rerankK: number): RealEstimate {
  const embedChars = plan.real.reduce((a, t) => a + t.length, 0);
  const rerankChars = plan.real.reduce((a, t) => a + t.length + rerankK * plan.meanTextChars, 0);
  return {
    queries: plan.real.length,
    embedTokens: Math.ceil(embedChars / 4),
    rerankTokens: Math.ceil(rerankChars / 4),
  };
}

/** `recall` records accesses; latency runs stub that write so the store does not drift under them. */
function frozen(store: MemoryStore): MemoryStore {
  return { ...store, recordAccess: async () => {} };
}

type Extra = { embed?: Embedder; rerank?: Reranker };

async function timedRecalls(
  env: Env,
  store: MemoryStore,
  queries: string[],
  extra: Extra = {},
): Promise<number[]> {
  const times: number[] = [];
  for (const text of queries) {
    const t = performance.now();
    await recall(
      { text, scope: ALL_SCOPE },
      { store, config: env.config, now: GENERATOR_NOW, ...extra },
    );
    times.push(performance.now() - t);
  }
  return times;
}

/** Each run's first `WARMUP` queries are executed but not measured. */
async function latencyRuns(env: Env, runs: string[][], extra: Extra = {}): Promise<Latency> {
  const store = frozen(env.store);
  const measured: number[][] = [];
  for (const run of runs) {
    await timedRecalls(env, store, run.slice(0, WARMUP), extra);
    measured.push(await timedRecalls(env, store, run.slice(WARMUP), extra));
  }
  return summarize(measured);
}

export interface RssResult {
  memories: number;
  beforeMb: number;
  afterSeedMb: number;
  afterLexicalMb: number;
  afterDenseMb: number;
  /** After 100 lexical recalls minus before seeding. */
  lexicalDeltaMb: number;
  /** After a further 100 dense recalls (fake embedder) minus before seeding. */
  denseDeltaMb: number;
  /** The bound's number: the larger of the two (the dense reading includes the lexical phase). */
  deltaMb: number;
}

function requireGc(): void {
  if (typeof (globalThis as { gc?: unknown }).gc !== 'function') {
    throw new Error(
      'RSS measurement needs global.gc: run node with --expose-gc (pnpm bench and the bench vitest project do)',
    );
  }
}

/** Generates and seeds the memories (the consolidate measurement needs no RSS). */
async function seedAndPlan(
  env: Env,
  count: number,
  seed: number,
  n: number,
  onPlan?: (plan: Plan) => Promise<void>,
): Promise<{ plan: Plan; seeded: number }> {
  const memories = generateMemories(count, seed);
  const plan = makePlan(memories, seed, n);
  await onPlan?.(plan);
  await seedStore(env.store, memories);
  return { plan, seeded: memories.length };
}

/**
 * The generated memories stay referenced through every reading, baseline
 * included, so the deltas are the store's growth only. (Releasing the array
 * before the "after" reading was tried: V8 frees the heap but the process
 * keeps the pages, so RSS does not fall and the delta then counts the
 * generator's transient, about 100 MB, as if it were store memory.)
 */
async function rssPhases(
  env: Env,
  count: number,
  seed: number,
  n: number,
  onPlan?: (plan: Plan) => Promise<void>,
): Promise<{ rss: RssResult; plan: Plan }> {
  requireGc();
  const memories = generateMemories(count, seed);
  const plan = makePlan(memories, seed, n);
  await onPlan?.(plan);
  collectGarbage();
  const beforeMb = rssMb();
  await seedStore(env.store, memories);
  collectGarbage();
  const afterSeedMb = rssMb();
  // recordAccess is live here (not stubbed): real recalls write.
  const deps = { store: env.store, config: env.config, now: GENERATOR_NOW };
  for (const text of plan.rssLexical) await recall({ text, scope: ALL_SCOPE }, deps);
  collectGarbage();
  const afterLexicalMb = rssMb();
  const embed = fakeEmbedder(EMBEDDING_DIMENSION);
  for (const text of plan.rssDense) await recall({ text, scope: ALL_SCOPE }, { ...deps, embed });
  collectGarbage();
  const afterDenseMb = rssMb();
  return {
    plan,
    rss: {
      memories: memories.length,
      beforeMb,
      afterSeedMb,
      afterLexicalMb,
      afterDenseMb,
      lexicalDeltaMb: afterLexicalMb - beforeMb,
      denseDeltaMb: afterDenseMb - beforeMb,
      deltaMb: Math.max(afterLexicalMb, afterDenseMb) - beforeMb,
    },
  };
}

/** RSS before seeding, after seeding, after 100 lexical and after 100 dense recalls (GC between phases). */
export async function measureRss(opts: { count: number; seed: number }): Promise<RssResult> {
  const env = await openEnv();
  try {
    return (await rssPhases(env, opts.count, opts.seed, 0)).rss;
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
  /** Guarded writes skipped by the first run (0 unless something wrote concurrently). */
  skipped: number;
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
    skipped: first.r.skipped,
    profile: firstProfile,
  };
}

/** Seeds `count` memories and times `consolidate` (first and second run, same `now`). */
export async function measureConsolidate(opts: {
  count: number;
  seed: number;
}): Promise<ConsolidateRun> {
  const env = await openEnv();
  try {
    await seedAndPlan(env, opts.count, opts.seed, 0);
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
  /** The estimate printed before any call, and the same measure over what was actually sent. */
  estimate: RealEstimate;
  sentEmbedTokens: number;
  sentRerankTokens: number;
}

export interface BenchResult {
  memories: number;
  rss: RssResult;
  sqliteMb: { beforeConsolidate: number; afterConsolidate: number; walAfterConsolidate: number };
  coldMb: { before: number; after: number };
  lexical: Latency;
  dense: Latency;
  /** After consolidate, so queries touch cold memories (first touch hydrates them). One run each. */
  postLexical: Latency;
  postDense: Latency;
  warmup: number;
  consolidate: ConsolidateRun;
  tiers: Record<Tier, number>;
  coldHydration: { hits: number; hydrated: number; p50Ms: number; hydrateP50Ms: number };
  real?: RealResult | { skipped: string };
}

async function runReal(
  env: Env,
  plan: Plan,
  estimate: RealEstimate,
): Promise<RealResult | { skipped: string }> {
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
  const store = frozen(env.store);
  const times: number[] = [];
  let degraded = 0;
  for (const text of plan.real.slice(0, REAL_QUERIES)) {
    const t = performance.now();
    const r = await recall(
      { text, scope: ALL_SCOPE },
      { store, config: env.config, now: GENERATOR_NOW, embed, rerank },
    );
    times.push(performance.now() - t);
    if (r.degraded?.some((d) => d === 'embed-failed' || d === 'rerank-failed')) degraded++;
  }
  return {
    queries: times.length,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    degraded,
    estimate,
    sentEmbedTokens: Math.ceil(embedChars / 4),
    sentRerankTokens: Math.ceil(rerankChars / 4),
  };
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const count = opts.count ?? 10_000;
  const seed = opts.seed ?? 42;
  const n = opts.queries ?? 200;
  const log = opts.log ?? (() => {});
  const env = await openEnv();
  try {
    let estimate: RealEstimate | undefined;
    const keyed = (process.env['VOYAGE_API_KEY'] ?? '') !== '';
    log(`seeding ${count} memories, then ${RSS_RECALLS} lexical and ${RSS_RECALLS} dense recalls`);
    const { rss, plan } = await rssPhases(env, count, seed, n, async (p) => {
      // Before any seeding or Voyage call: show the estimate and require consent.
      if (opts.real === true && keyed) {
        estimate = estimateReal(p, env.config.recall.rerankK);
        if (opts.confirmReal === undefined || !(await opts.confirmReal(estimate))) {
          throw new RealNotConfirmedError();
        }
      }
    });

    log(`lexical-only latency (${REPEATS} runs of ${n}, ${WARMUP} warm-up each)`);
    const lexical = await latencyRuns(env, plan.lexicalRuns);
    log('dense latency (fake embedder)');
    const dense = await latencyRuns(env, plan.denseRuns, {
      embed: fakeEmbedder(EMBEDDING_DIMENSION),
    });

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
    const store = frozen(env.store);
    const coldTimes: number[] = [];
    const hydrateTimes: number[] = [];
    let hydrated = 0;
    for (const m of picked) {
      // Every distinctive stub word, so the cold memory is in the lexical candidates.
      const text = [...new Set(tokenizeLexical(m.stub))].filter((t) => t.length >= 4).join(' ');
      const t = performance.now();
      const r = await recall(
        { text, scope: ALL_SCOPE },
        { store, config: env.config, now: GENERATOR_NOW },
      );
      coldTimes.push(performance.now() - t);
      // Recall hydrates every cold candidate, returned or not; the target is hydrated when it left cold.
      if ((await env.store.get(m.id))?.tier !== 'cold') {
        hydrated++;
        hydrateTimes.push(r.timings['hydrateMs'] ?? 0);
      }
    }

    log('post-consolidate latency (cold hits included)');
    const postLexical = await latencyRuns(env, [plan.postLexical]);
    const postDense = await latencyRuns(env, [plan.postDense], {
      embed: fakeEmbedder(EMBEDDING_DIMENSION),
    });

    const result: BenchResult = {
      memories: all.length,
      rss,
      sqliteMb: {
        beforeConsolidate: toMb(sqliteBefore),
        afterConsolidate: toMb(sqliteAfter),
        walAfterConsolidate: toMb(fileBytes(`${env.dbPath}-wal`)),
      },
      coldMb: { before: toMb(coldBefore), after: toMb(coldAfter) },
      lexical,
      dense,
      postLexical,
      postDense,
      warmup: WARMUP,
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
      result.real = keyed
        ? await runReal(env, plan, estimate ?? estimateReal(plan, env.config.recall.rerankK))
        : { skipped: 'VOYAGE_API_KEY is not set' };
    }
    return result;
  } finally {
    await env.close();
  }
}

const f1 = (n: number): string => n.toFixed(1);
const f2 = (n: number): string => n.toFixed(2);
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${f1(n)}`;

/** The RSS delta above which the report adds a regression note (the test bound is 150). */
export const RSS_NOTE_MB = 60;

const lat = (l: Latency): string =>
  `${f2(l.p50Ms)} / ${f2(l.p95Ms)} / ${f2(l.p99Ms)} ms (p95 over runs ${f2(l.p95MinMs)} to ${f2(l.p95MaxMs)})`;

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
      'RSS after 100 lexical recalls',
      `${f1(r.rss.afterLexicalMb)} MB (${signed(r.rss.lexicalDeltaMb)} MB)`,
    ],
    [
      'RSS after a further 100 dense recalls',
      `${f1(r.rss.afterDenseMb)} MB (${signed(r.rss.denseDeltaMb)} MB)`,
    ],
    ['SQLite file + WAL, before consolidate', `${f2(r.sqliteMb.beforeConsolidate)} MB`],
    [
      'SQLite file + WAL, after consolidate',
      `${f2(r.sqliteMb.afterConsolidate)} MB (WAL ${f2(r.sqliteMb.walAfterConsolidate)} MB)`,
    ],
    ['Cold dir, before consolidate', `${f2(r.coldMb.before)} MB`],
    ['Cold dir, after consolidate', `${f2(r.coldMb.after)} MB`],
    [`recall lexical-only p50 / p95 / p99 (${r.lexical.samples} queries)`, lat(r.lexical)],
    [`recall dense, fake embedder p50 / p95 / p99 (${r.dense.samples} queries)`, lat(r.dense)],
    [
      `after consolidate: lexical p50 / p95 / p99 (${r.postLexical.samples} queries, cold hits)`,
      lat(r.postLexical),
    ],
    [
      `after consolidate: dense p50 / p95 / p99 (${r.postDense.samples} queries, cold hits)`,
      lat(r.postDense),
    ],
    ['consolidate, first run', `${f1(r.consolidate.firstMs)} ms`],
    ['consolidate, second run', `${f1(r.consolidate.secondMs)} ms`],
    [
      'consolidate first run moves',
      `${r.consolidate.evicted} to cold, ${r.consolidate.promoted} promoted, ${r.consolidate.demoted} demoted (incl. evicted), ${r.consolidate.skipped} skipped`,
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
          'API tokens, estimated before the calls (about 4 chars each)',
          `embed ${x.estimate.embedTokens}, rerank ${x.estimate.rerankTokens}`,
        ],
        ['API tokens, sent', `embed ${x.sentEmbedTokens}, rerank ${x.sentRerankTokens}`],
      );
    }
  }
  const lines = ['| Metric | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
  const profile = r.consolidate.profile
    .slice(0, 6)
    .map((p) => `| ${p.method} | ${p.calls} | ${f1(p.totalMs)} |`);
  const notes = [
    `Latency rows: ${r.warmup} warm-up queries per run are excluded; lexical and dense use different query samples; \`recordAccess\` is stubbed so the store does not drift; pre-consolidate rows pool ${REPEATS} runs, post-consolidate rows are one run.`,
  ];
  if (r.rss.deltaMb > RSS_NOTE_MB) {
    notes.push(
      `Regression note: RSS delta ${f1(r.rss.deltaMb)} MB is above ${RSS_NOTE_MB} MB (the bound is 150 MB).`,
    );
  }
  if (r.real !== undefined && !('skipped' in r.real)) {
    notes.push(
      'Real adapters pair real query embeddings with the fake stored embeddings, so only the --real latency is meaningful, not its ranking.',
    );
  }
  return [
    ...lines,
    '',
    ...notes.flatMap((n) => [n, '']),
    'Store calls during the first consolidate (by total time):',
    '',
    '| Store call | Calls | Total ms |',
    '| --- | --- | --- |',
    ...profile,
    '',
  ].join('\n');
}
