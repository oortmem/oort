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
  })
  .default({ lexicalK: 50, denseK: 50, rerankK: 30, returnK: 10, budgetChars: 6000 });

const project = z
  .strictObject({
    /** Overrides the id derived from the git root (spec §8); see `resolveProjectId`. */
    id: z.string().min(1).optional(),
    private: z.boolean().default(false),
  })
  .default({ private: false });

export const OortConfig = z.strictObject({
  embed,
  rerank,
  decide,
  writer,
  activation,
  recall,
  project,
});
export type OortConfig = z.infer<typeof OortConfig>;

export type ConfigSource = 'project' | 'home' | 'default';

export type ResolvedConfig = OortConfig & {
  home: string;
  sources: Record<string, ConfigSource>;
};

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
  for (const key of CONFIG_KEYS) {
    if (key in projectRaw) {
      merged[key] = projectRaw[key];
      sources[key] = 'project';
    } else if (key in homeRaw) {
      merged[key] = homeRaw[key];
      sources[key] = 'home';
    } else {
      sources[key] = 'default';
    }
  }

  return { ...OortConfig.parse(merged), home, sources };
}
