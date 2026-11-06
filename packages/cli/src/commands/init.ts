import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  OortConfig,
  ensurePrivateDir,
  findGitRoot,
  resolveConfig,
  resolveHome,
} from '@oortmem/core';
import { LOCAL_PROVIDER } from '../local-models.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, SAVING_NEEDS, remedySentence, tilde, type Ctx } from '../util.js';

/** Each key and what needs it. */
const KEYS = [
  {
    provider: 'voyage',
    envVar: 'VOYAGE_API_KEY',
    needs: 'embed and rerank (dense recall; saving)',
    roles: ['embed', 'rerank'],
  },
  { provider: 'typesafe', envVar: 'TYPESAFE_API_KEY', needs: 'decide (saving)', roles: ['decide'] },
  { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', needs: 'write (saving)', roles: ['write'] },
] as const;

/** True when the config serves embed and rerank with local models, so no Voyage key is needed. */
function localEmbedAndRerank(cwd: string, env: Record<string, string | undefined>): boolean {
  try {
    const config = resolveConfig(cwd, env);
    return config.embed.provider === LOCAL_PROVIDER && config.rerank.provider === LOCAL_PROVIDER;
  } catch {
    return false; // an invalid config: doctor reports it
  }
}

/** Creates `file` with `data` and `mode`; returns false, leaving it untouched, when it exists. */
function createExclusive(file: string, data: string, mode: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * `oort init [--project]`: writes `$OORT_HOME/config.json` with the defaults
 * when absent (never overwrites), and with `--project` an `oort.config.json`
 * at the git root. Reports which keys are missing and how to set each.
 */
export async function initCommand(opts: { project?: boolean }, ctx: Ctx): Promise<number> {
  const { io } = ctx;
  const home = resolveHome(io.env);
  ensurePrivateDir(home);
  const file = path.join(home, 'config.json');
  const ui = uiFor(io);
  const show = (p: string): string => tilde(p, io.env['HOME'] ?? '');
  io.out(ui.header('init', show(home)));
  const defaults = `${JSON.stringify(OortConfig.parse({}), null, 2)}\n`;
  const created = createExclusive(file, defaults, 0o600);
  io.out(created ? `Created ${show(file)}\n` : `Kept existing ${show(file)}\n`);
  let project: { path: string; created: boolean } | null = null;

  if (opts.project === true) {
    const root = findGitRoot(io.cwd);
    if (root === undefined)
      throw new Refusal('--project needs a git repository; none found above the cwd.');
    const projectFile = path.join(root, 'oort.config.json');
    const body = `${JSON.stringify({ project: { private: false } }, null, 2)}\n`;
    // 0644: the project file is meant to be committed and holds no secrets.
    project = { path: projectFile, created: createExclusive(projectFile, body, 0o644) };
    io.out(
      project.created ? `Created ${show(projectFile)}\n` : `Kept existing ${show(projectFile)}\n`,
    );
  }

  // Same order as `wire`: the environment, then the Keychain. Presence only; values are dropped.
  const local = localEmbedAndRerank(io.cwd, io.env);
  const missing: (typeof KEYS)[number][] = [];
  for (const k of KEYS) {
    if (k.provider === 'voyage' && local) continue;
    if (io.env[k.envVar]) continue;
    if ((await ctx.keychain.read(k.provider)) === undefined) missing.push(k);
  }
  const oort =
    Boolean(io.env['OORT_API_KEY']) ||
    (missing.length > 0 && (await ctx.keychain.read('oort')) !== undefined);
  if (missing.length === 0) {
    io.out('All keys are set.\n');
  } else if (oort) {
    io.out(
      `Oort Pro key found: ${missing.map((k) => k.provider).join(', ')} go through the Oort Pro relay; your own keys win where set.\n`,
    );
  } else {
    io.out('Missing keys (recall works lexical-only without them):\n');
    io.out(
      ui.kv(
        missing.map((k) => [k.envVar, `for ${k.needs}`]),
        { indent: 2 },
      ),
    );
    const roles = missing.flatMap((k) => k.roles);
    io.out(`${remedySentence({ roles, keyStore: ctx.keychain.supported })}.\n`);
    // With Voyage missing too, the list leads with local models: say what they do not cover.
    const saving = missing.some((k) => k.provider !== 'voyage');
    if (saving && missing.some((k) => k.provider === 'voyage')) io.out(`${SAVING_NEEDS}\n`);
    if (missing.some((k) => k.provider === 'anthropic')) {
      io.out(
        'Do not set ANTHROPIC_API_KEY globally if you also use Claude Code on a subscription: it would bill the API instead.\n',
      );
    }
  }
  if (jsonMode(ctx)) {
    emit(ctx, {
      home,
      config: { path: file, created },
      project,
      missingKeys: missing.map((k) => ({ provider: k.provider, envVar: k.envVar, needs: k.needs })),
      oortKey: oort,
    });
  }
  return 0;
}
