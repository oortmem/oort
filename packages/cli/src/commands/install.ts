import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_EVENTS, installHooks, uninstallHooks } from '@oortmem/claude-code';
import { VERSION } from '@oortmem/core';
import { HOSTS, isHost } from '../connectors.js';
import { binPath, runToStderr } from '../io.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, echo, noteWarning, tilde, type Ctx } from '../util.js';

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
  if (entry === undefined)
    throw new Refusal(`The CLI is not running as its bin. ${HOW_TO_INSTALL}`);
  let real: string;
  let bin: string;
  try {
    real = fs.realpathSync(entry);
    bin = fs.realpathSync(expected);
  } catch {
    throw new Refusal(`The CLI is not running as its bin. ${HOW_TO_INSTALL}`);
  }
  if (real !== bin)
    throw new Refusal(`The CLI is not running as its bin (${real}). ${HOW_TO_INSTALL}`);
  if (ephemeral(real)) {
    throw new Refusal(
      `The CLI is running from a temporary package cache (${real}). ${HOW_TO_INSTALL}`,
    );
  }
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new Refusal(`${real} is not executable. ${HOW_TO_INSTALL}`);
  }
  return real;
}

/** Path pieces of Node version managers: a hook that points into one breaks on a version switch. */
const VERSION_MANAGER = ['.nvm/', 'fnm_multishells', 'node-versions/', '.volta/', '.asdf/'];

/** The version manager `file` lives under (as its marker), if any. */
export function versionManagerOf(file: string): string | undefined {
  const p = file.replaceAll('\\', '/');
  return VERSION_MANAGER.find((m) => p.includes(m));
}

/**
 * The binary path in a hook command `<path> hook <Event>`: the path may be quoted or follow
 * `node `. Undefined when the command is not that shape.
 */
export function hookBinaryOf(command: string): string | undefined {
  const m = /^(.*) hook [A-Za-z]+$/.exec(command.trim());
  if (m?.[1] === undefined) return undefined;
  let bin = m[1].trim();
  if (bin.startsWith('node ')) bin = bin.slice(5).trim();
  if (bin.startsWith("'") && bin.endsWith("'") && bin.length >= 2) {
    bin = bin.slice(1, -1).replaceAll(`'\\''`, "'");
  } else if (bin.startsWith('"') && bin.endsWith('"') && bin.length >= 2) {
    bin = bin.slice(1, -1);
  }
  return bin === '' ? undefined : bin;
}

/** The first `oort` on PATH (a lookup in code, no shell), as a realpath; undefined if none. */
export function whichOort(env: Record<string, string | undefined>): string | undefined {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `oort${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (!fs.statSync(candidate).isFile()) continue;
        return fs.realpathSync(candidate);
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** The Claude Code settings file the hooks go in: user scope, or `<cwd>/.claude` with `project`. */
export function settingsFile(project: boolean, ctx: Ctx): string {
  if (project) return path.join(ctx.io.cwd, '.claude', 'settings.json');
  return path.join(ctx.io.env['HOME'] || os.homedir(), '.claude', 'settings.json');
}

/**
 * `oort install <harness> [--project]` / `oort uninstall <harness> [--project]`. Claude Code gets
 * its hooks; every other harness (Codex, Cursor, …) gets the MCP server entry, exactly as
 * `oort connect <harness>` writes it (CON-18).
 */
export async function installCommand(
  action: 'install' | 'uninstall',
  harness: string,
  opts: { project?: boolean },
  ctx: Ctx,
): Promise<number> {
  if (harness !== 'claude-code') {
    if (!isHost(harness)) {
      throw new Refusal(`Unknown harness ${echo(harness)}; expected one of ${HOSTS.join(', ')}.`);
    }
    if (opts.project === true) {
      throw new Refusal(
        `--project is for the Claude Code hooks; ${harness} is configured per user.`,
      );
    }
    const { connectCommand } = await import('./connect.js');
    return connectCommand(action === 'install' ? 'connect' : 'disconnect', [harness], {}, ctx);
  }
  const cmd = hookCommandPath(ctx.io.entry);
  const file = settingsFile(opts.project === true, ctx);
  const events = HOOK_EVENTS.join(', ');
  const home = ctx.io.env['HOME'] ?? '';
  const show = (p: string): string => tilde(p, home);
  ctx.io.out(uiFor(ctx.io).header(`${action} claude-code`, 'hooks'));
  let changed: boolean;
  if (action === 'install') {
    ({ changed } = installHooks(file, cmd));
    ctx.io.out(
      changed
        ? `Installed Oort hooks (${events}) in ${show(file)}:\n${HOOK_EVENTS.map((e) => `  ${show(cmd)} hook ${e}`).join('\n')}\n`
        : `Oort hooks are already installed in ${show(file)}; nothing changed.\n`,
    );
    const ui = uiFor(ctx.io);
    ctx.io.out(`${ui.info(`Hook binary: ${show(cmd)} (oort ${VERSION})`)}\n`);
    const onPath = whichOort(ctx.io.env);
    if (onPath !== undefined && onPath !== cmd) {
      noteWarning(
        ctx,
        'another-oort-on-path',
        `Another oort comes first on your PATH: ${onPath}. The hooks run ${cmd}, not that one.`,
      );
      ctx.io.out(
        `${ui.warn(`Another oort comes first on your PATH: ${show(onPath)}. The hooks run ${show(cmd)}, not that one.`)}\n` +
          `  To use that one instead, run \`oort install claude-code\` from it.\n`,
      );
    }
    if (versionManagerOf(cmd) !== undefined) {
      noteWarning(
        ctx,
        'version-manager-path',
        'The hook binary is under a Node version manager; switching Node versions will break the hooks.',
      );
      ctx.io.out(
        `${ui.info('This path is under a Node version manager; switching Node versions will break the hooks.')}\n` +
          '  Install oortmem somewhere stable (`npm i -g oortmem` with a system Node), then re-run this.\n',
      );
    }
  } else {
    ({ changed } = uninstallHooks(file, cmd));
    ctx.io.out(
      changed
        ? `Removed Oort hooks (${events}) from ${show(file)}.\n`
        : `No Oort hooks found in ${show(file)}; nothing changed.\n`,
    );
  }
  if (jsonMode(ctx)) {
    emit(ctx, {
      harness: 'claude-code',
      action,
      file,
      changed,
      command: cmd,
      events: [...HOOK_EVENTS],
      version: VERSION,
    });
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
export function npmGlobalInstall(
  env: Record<string, string | undefined>,
  run: typeof runToStderr = runToStderr,
): GlobalInstall {
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
      // npm's "added N packages" goes to stderr: stdout is `setup --json`'s envelope.
      return run('npm', ['i', '-g', 'oortmem'], { env: childEnv }).catch(() => 1);
    },
  };
}
