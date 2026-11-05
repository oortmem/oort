import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const embed = z
  .strictObject({
    provider: z.string().default('voyage'),
    model: z.string().default('voyage-3.5-lite'),
    dimension: z.number().int().positive().default(512),
    dtype: z.enum(['int8', 'float32']).default('int8'),
  })
  .default({ provider: 'voyage', model: 'voyage-3.5-lite', dimension: 512, dtype: 'int8' });

const rerank = z
  .strictObject({
    provider: z.string().default('voyage'),
    model: z.string().default('rerank-3-lite'),
    topK: z.number().int().positive().default(10),
  })
  .default({ provider: 'voyage', model: 'rerank-3-lite', topK: 10 });

const decide = z.strictObject({ provider: z.string().default('jev') }).default({ provider: 'jev' });

const writer = z
  .strictObject({
    provider: z.string().default('anthropic'),
    model: z.string().default('claude-haiku-5-5'),
    /** A turn becomes at most this many memories, one fact each (CON-56). */
    maxMemoriesPerObservation: z.number().int().min(1).max(10).default(5),
  })
  .default({ provider: 'anthropic', model: 'claude-haiku-5-5', maxMemoriesPerObservation: 5 });

const activation = z
  .strictObject({
    d: z.number().default(0.5),
    ws: z.number().default(1.0),
    hotTopN: z.number().int().positive().default(50),
    coldBelow: z.number().default(-2.0),
  })
  .default({ d: 0.5, ws: 1.0, hotTopN: 50, coldBelow: -2.0 });

const recall = z
  .strictObject({
    lexicalK: z.number().int().positive().default(50),
    denseK: z.number().int().positive().default(50),
    rerankK: z.number().int().positive().default(30),
    returnK: z.number().int().positive().default(10),
    budgetChars: z.number().int().positive().default(6000),
    /**
     * Relevance gate (CON-45). A reranked memory needs at least this reranker score, from 0 to 1.
     * Provisional until calibrated with real scores (`pnpm --filter @oortmem/bench run calibrate`).
     */
    minRerankScore: z.number().min(0).max(1).default(0.35),
    /**
     * Without a rerank score, a memory needs this share of the query's informative words, or a
     * dense similarity of at least `minDenseScore`. Calibrated on the bench eval fixture.
     */
    minCoverage: z.number().min(0).max(1).default(0.5),
    /** Dense (cosine) similarity that lets a memory through without shared words. Provisional. */
    minDenseScore: z.number().min(0).max(1).default(0.6),
    /** Skip the rerank call when lexical and dense agree on a clear top result (CON-57). */
    skipRerankWhenConfident: z.boolean().default(true),
    /**
     * Run the lexical search first and skip the query embedding when its top result holds every
     * informative query word and the runner-up is clearly weaker (CON-57).
     */
    lexicalFirst: z.boolean().default(true),
    /** Longest wait for the reranker, in ms; past it the fused order is used. 0 waits forever. */
    rerankBudgetMs: z.number().int().min(0).default(400),
    /** How long a query embedding is reused, in seconds. 0 turns the cache off. */
    queryCacheTtlSec: z.number().int().min(0).default(600),
    /**
     * Days after which a volatile memory (a status, a current version) that nobody confirmed is
     * marked "may be outdated" when injected, and listed by `oort revalidate`. 0 turns it off.
     */
    staleAfterDays: z.number().int().min(0).default(30),
    /**
     * The specificity prior ε (spec 7.2): when a recall reads several nodes, each fused score is
     * scaled by 1 + ε × specificity / 3 (an agent's Star 3, the Planet 2, a Constellation 1, a
     * Galaxy 0). 0, the default, turns it off: it is turned on only if the eval shows a gain.
     */
    specificityPrior: z.number().min(0).max(1).default(0),
    /**
     * How the prompt hook (Claude Code's UserPromptSubmit) recalls, locally and in Oort Cloud
     * (CON-101): `full` embeds the prompt and reranks; `fast` skips the reranker (fusion and the
     * relevance gate rank); `lexical` skips the query embedding too (no model call at all). `oort
     * recall`, MCP and SessionStart always recall in full.
     */
    promptMode: z.enum(['full', 'fast', 'lexical']).default('fast'),
  })
  .default({
    lexicalK: 50,
    denseK: 50,
    rerankK: 30,
    returnK: 10,
    budgetChars: 6000,
    minRerankScore: 0.35,
    minCoverage: 0.5,
    minDenseScore: 0.6,
    skipRerankWhenConfident: true,
    lexicalFirst: true,
    rerankBudgetMs: 400,
    queryCacheTtlSec: 600,
    staleAfterDays: 30,
    specificityPrior: 0,
    promptMode: 'fast',
  });

const project = z
  .strictObject({
    /** Overrides the id derived from the git root (spec §8); see `resolveProjectId`. */
    id: z.string().min(1).optional(),
    private: z.boolean().default(false),
  })
  .default({ private: false });

/**
 * `oort serve`, the local daemon the hooks talk to (CON-18). Read from the home config only: a
 * repository's `oort.config.json` cannot start processes on this machine.
 */
const serve = z
  .strictObject({
    /** SessionStart starts a detached daemon when none is running. */
    autostart: z.boolean().default(false),
    /** The daemon exits after this many minutes without a hook request. */
    idleMinutes: z.number().int().min(1).max(1440).default(30),
  })
  .default({ autostart: false, idleMinutes: 30 });

/**
 * Judgment memory (CON-71). Read from the home config only: a repository's `oort.config.json`
 * cannot name who counts as an expert.
 * - `experts`: the expert ids an agent may record judgments for over MCP (`record_judgment`).
 *   Empty (the default): MCP recording is refused.
 * - `operator`: who withdraws, confirms or purges judgments from this machine (`--by` overrides);
 *   default `local-user`.
 */
const judge = z
  .strictObject({
    experts: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
    operator: z.string().trim().min(1).max(128).optional(),
  })
  .default({ experts: [] });

export const OortConfig = z.strictObject({
  embed,
  rerank,
  decide,
  writer,
  activation,
  recall,
  project,
  serve,
  judge,
});
export type OortConfig = z.infer<typeof OortConfig>;

export type ConfigSource = 'project' | 'home' | 'default';

export type ResolvedConfig = OortConfig & {
  home: string;
  sources: Record<string, ConfigSource>;
  /**
   * Keys a project's `oort.config.json` set that only the home config may set (`serve`: a
   * repository must not start processes on this machine; `judge`: nor name experts). Ignored;
   * absent when there are none.
   */
  ignoredProjectKeys?: string[];
};

/** Keys read from the home config only; a project file's value is ignored (and reported). */
const HOME_ONLY_KEYS: ReadonlySet<string> = new Set(['serve', 'judge']);

const CONFIG_KEYS = Object.keys(OortConfig.shape);

function findProjectConfig(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, 'oort.config.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid config file ${file}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid config file ${file}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Validate one file against the strict schema (all keys optional); errors name the file and key. */
function readConfigFile(file: string): Record<string, unknown> {
  const raw = readJsonObject(file);
  const result = OortConfig.partial().safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config file ${file}: ${result.error.message}`);
  }
  return raw;
}

/**
 * Oort's home directory, always absolute: `OORT_HOME` resolved against the
 * process cwd (hooks run from many working directories, and a relative path
 * would split the store), else `$HOME/.oort`. An empty value counts as unset.
 */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const set = env['OORT_HOME'];
  if (set !== undefined && set !== '') return path.resolve(set);
  const home = env['HOME'];
  return path.resolve(home !== undefined && home !== '' ? home : os.homedir(), '.oort');
}

export interface ResolveConfigOptions {
  /**
   * Look for `oort.config.json` from `cwd` upward (default true). With false,
   * no project file is searched for or read: only the home config and the
   * defaults apply (the write-path drain, which serves every project).
   */
  projectConfig?: boolean;
}

/**
 * `project.id` from the nearest `oort.config.json` at or above `cwd`, or
 * undefined. The file is validated like any config file: an invalid one
 * throws, naming it. The home config is not consulted: one id there would
 * merge every project into one.
 */
export function configuredProjectId(cwd: string): string | undefined {
  const file = findProjectConfig(cwd);
  if (file === undefined) return undefined;
  return OortConfig.shape.project.parse(readConfigFile(file)['project']).id;
}

export function resolveConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  opts: ResolveConfigOptions = {},
): ResolvedConfig {
  const home = resolveHome(env);

  const projectFile = opts.projectConfig === false ? undefined : findProjectConfig(cwd);
  const homeFile = path.join(home, 'config.json');
  const projectRaw = projectFile ? readConfigFile(projectFile) : {};
  const homeRaw = fs.existsSync(homeFile) ? readConfigFile(homeFile) : {};

  const merged: Record<string, unknown> = {};
  const sources: Record<string, ConfigSource> = {};
  const ignored: string[] = [];
  for (const key of CONFIG_KEYS) {
    if (key in projectRaw && HOME_ONLY_KEYS.has(key)) ignored.push(key);
    if (key in projectRaw && !HOME_ONLY_KEYS.has(key)) {
      merged[key] = projectRaw[key];
      sources[key] = 'project';
    } else if (key in homeRaw) {
      merged[key] = homeRaw[key];
      sources[key] = 'home';
    } else {
      sources[key] = 'default';
    }
  }

  return {
    ...OortConfig.parse(merged),
    home,
    sources,
    ...(ignored.length > 0 && { ignoredProjectKeys: ignored }),
  };
}
