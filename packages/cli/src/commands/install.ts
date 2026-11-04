import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_EVENTS, installHooks, uninstallHooks } from '@oortmem/claude-code';
import { binPath } from '../io.js';
import { uiFor } from '../ui.js';
import { Refusal, echo, type Ctx } from '../util.js';

// pnpm 11 removed `pnpm link --global`; `pnpm add -g .` links the package directory instead.
export const HOW_TO_INSTALL =
  'Install the CLI globally first, with `npm i -g oortmem` (from the oort repo: ' +
  '`pnpm build && cd packages/cli && pnpm add -g .`), then run this again as `oort`.';

/** True when `p` lies in a directory a package runner uses for throwaway installs. */
export function ephemeral(p: string): boolean {
  const segments = p.split(path.sep);
  if (segments.includes('_npx') || segments.includes('dlx')) return true;
  const tmp = fs.realpathSync(os.tmpdir());
  return p === tmp || p.startsWith(tmp + path.sep);
}

/**
 * The command written into settings.json: the realpath of this package's
 * executable `dist/main.js`, and only when the CLI was started as that file.
 * Anything else (`node src/...`, `node -e`, a package runner's cache) would
 * write a hook that breaks once the process is gone, so it is refused.
 */
export function hookCommandPath(entry: string | undefined, expected = binPath()): string {
  if (entry === undefined) throw new Refusal(`oort is not running as its bin. ${HOW_TO_INSTALL}`);
  let real: string;
  let bin: string;
  try {
    real = fs.realpathSync(entry);
    bin = fs.realpathSync(expected);
  } catch {
    throw new Refusal(`oort is not running as its bin. ${HOW_TO_INSTALL}`);
  }
  if (real !== bin)
    throw new Refusal(`oort is not running as its bin (${real}). ${HOW_TO_INSTALL}`);
  if (ephemeral(real)) {
    throw new Refusal(
      `oort is running from a temporary package cache (${real}). ${HOW_TO_INSTALL}`,
    );
  }
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new Refusal(`${real} is not executable. ${HOW_TO_INSTALL}`);
  }
  return real;
}

/** The Claude Code settings file the hooks go in: user scope, or `<cwd>/.claude` with `project`. */
export function settingsFile(project: boolean, ctx: Ctx): string {
  if (project) return path.join(ctx.io.cwd, '.claude', 'settings.json');
  return path.join(ctx.io.env['HOME'] || os.homedir(), '.claude', 'settings.json');
}

/** `oort install claude-code [--project]` / `oort uninstall claude-code [--project]` */
export async function installCommand(
  action: 'install' | 'uninstall',
  harness: string,
  opts: { project?: boolean },
  ctx: Ctx,
): Promise<number> {
  if (harness !== 'claude-code') {
    throw new Refusal(`unknown harness ${echo(harness)}; Phase 1 supports claude-code.`);
  }
  const cmd = hookCommandPath(ctx.io.entry);
  const file = settingsFile(opts.project === true, ctx);
  const events = HOOK_EVENTS.join(', ');
  ctx.io.out(uiFor(ctx.io).header(`${action} claude-code`, 'hooks'));
  if (action === 'install') {
    const { changed } = installHooks(file, cmd);
    ctx.io.out(
      changed
        ? `Installed Oort hooks (${events}) in ${file}:\n${HOOK_EVENTS.map((e) => `  ${cmd} hook ${e}`).join('\n')}\n`
        : `Oort hooks are already installed in ${file}; nothing changed.\n`,
    );
  } else {
    const { changed } = uninstallHooks(file, cmd);
    ctx.io.out(
      changed
        ? `Removed Oort hooks (${events}) from ${file}.\n`
        : `No Oort hooks found in ${file}; nothing changed.\n`,
    );
  }
  return 0;
}

/** This process runs from a package runner's cache (`npx oortmem`, `pnpm dlx`). */
export function fromPackageCache(): boolean {
  try {
    return ephemeral(fs.realpathSync(binPath()));
  } catch {
    return false;
  }
}

/** The global `oortmem` install `oort setup` offers when it runs under npx. */
export interface GlobalInstall {
  /** The realpath of the globally installed bin, when there is a usable one. */
  bin(): string | undefined;
  /** Runs `npm i -g oortmem` with the terminal attached; resolves its exit code. */
  install(): Promise<number>;
}

/** `npm i -g oortmem`, and `<npm prefix -g>/bin/oort` as the stable path (not on Windows yet). */
export function npmGlobalInstall(env: Record<string, string | undefined>): GlobalInstall {
  const childEnv = env as NodeJS.ProcessEnv;
  return {
    bin() {
      if (process.platform === 'win32') return undefined;
      const r = spawnSync('npm', ['prefix', '-g'], {
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      });
      if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
      const link = path.join(r.stdout.trim(), 'bin', 'oort');
      try {
        const real = hookCommandPath(link, link);
        return /[\\/]oortmem[\\/]dist[\\/]main\.js$/.test(real) ? real : undefined;
      } catch {
        return undefined;
      }
    },
    install() {
      return new Promise((resolve) => {
        spawn('npm', ['i', '-g', 'oortmem'], { stdio: 'inherit', env: childEnv })
          .once('error', () => resolve(1))
          .once('close', (code) => resolve(code ?? 1));
      });
    },
  };
}
