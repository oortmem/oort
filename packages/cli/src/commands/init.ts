import * as fs from 'node:fs';
import * as path from 'node:path';
import { OortConfig, ensurePrivateDir, findGitRoot, resolveHome } from '@oortmem/core';
import { uiFor } from '../ui.js';
import { Refusal, type Ctx } from '../util.js';

/** Each key and what needs it. */
const KEYS = [
  {
    provider: 'voyage',
    envVar: 'VOYAGE_API_KEY',
    needs: 'embed and rerank (dense recall; observe, import)',
  },
  { provider: 'typesafe', envVar: 'TYPESAFE_API_KEY', needs: 'decide (observe, import)' },
  { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', needs: 'write (observe, import)' },
] as const;

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
  io.out(uiFor(io).header('init', home));
  const defaults = `${JSON.stringify(OortConfig.parse({}), null, 2)}\n`;
  io.out(createExclusive(file, defaults, 0o600) ? `Created ${file}\n` : `Kept existing ${file}\n`);

  if (opts.project === true) {
    const root = findGitRoot(io.cwd);
    if (root === undefined)
      throw new Refusal('--project needs a git repository; none found above the cwd.');
    const projectFile = path.join(root, 'oort.config.json');
    const body = `${JSON.stringify({ project: { private: false } }, null, 2)}\n`;
    io.out(
      // 0644: the project file is meant to be committed and holds no secrets.
      createExclusive(projectFile, body, 0o644)
        ? `Created ${projectFile}\n`
        : `Kept existing ${projectFile}\n`,
    );
  }

  // Same order as `wire`: the environment, then the Keychain. Presence only; values are dropped.
  const missing: (typeof KEYS)[number][] = [];
  for (const k of KEYS) {
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
    for (const k of missing) {
      io.out(
        `  ${k.envVar}, for ${k.needs}. Set it with: oort keys set ${k.provider} (or export ${k.envVar}=...)\n`,
      );
    }
    io.out(
      'Do not export ANTHROPIC_API_KEY globally if you also use Claude Code on a subscription: it would bill the API instead.\n',
    );
    io.out('Or skip vendor keys with Oort Pro: run `oort login`.\n');
  }
  return 0;
}
