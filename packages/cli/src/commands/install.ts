import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_EVENTS, installHooks, uninstallHooks } from '@oortmem/claude-code';
import { VERSION } from '@oortmem/core';
import { HOSTS, isHost } from '../connectors.js';
import { binPath } from '../io.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, echo, noteWarning, shown, tilde, type Ctx } from '../util.js';

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
 * Why a copy of oort is no place to point agents at, or undefined when it is one: a package
 * runner's cache (npx, pnpm dlx), a temp directory, fnm's per-shell link, or a Node version
 * manager (switching Node versions breaks it). `entry` is the path as typed, `real` its realpath.
 */
export function unstableCopy(
  entry: string | undefined,
  real: string | undefined,
  tmp: string = realTmp(),
): string | undefined {
  const paths = [entry, real].filter((p): p is string => p !== undefined);
  const segments = (p: string): string[] => p.replaceAll('\\', '/').split('/');
  if (paths.some((p) => segments(p).includes('_npx') || segments(p).includes('dlx'))) {
    return 'a package cache';
  }
  if (paths.some((p) => p.includes('fnm_multishells'))) return "fnm's link for this shell";
  if (paths.some((p) => versionManagerOf(p) !== undefined)) return 'a Node version manager';
  if (paths.some((p) => p === tmp || p.startsWith(tmp + path.sep))) return 'a temporary directory';
  return undefined;
}

function realTmp(): string {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
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
  const { agentBinary, managedCopy } = await import('./managed.js');
  const file = settingsFile(opts.project === true, ctx);
  const events = HOOK_EVENTS.join(', ');
  const home = ctx.io.env['HOME'] ?? '';
  const show = (p: string): string => tilde(p, home);
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header(`${action} claude-code`, 'hooks'));
  let changed: boolean;
  let cmd: string;
  let from: 'managed' | 'running' | undefined;
  let version = VERSION;
  let installed = false;
  if (action === 'install') {
    // The managed copy (~/.oort/cli) when it checks out, else this copy when it is stable; from a
    // temporary copy the managed one is installed first (CON-114).
    const bin = await agentBinary(ctx, {
      action: `install claude-code${opts.project === true ? ' --project' : ''}`,
      say: (line) => ctx.io.out(ui.info(line)),
    });
    cmd = bin.path;
    from = bin.from;
    version = bin.version;
    installed = bin.installed === true;
    ({ changed } = installHooks(file, cmd));
    ctx.io.out(
      changed
        ? `Installed Oort hooks (${events}) in ${show(file)}:\n${HOOK_EVENTS.map((e) => `  ${show(cmd)} hook ${e}`).join('\n')}\n`
        : `Oort hooks are already installed in ${show(file)}; nothing changed.\n`,
    );
    ctx.io.out(
      `${ui.info(`Hook binary: ${show(cmd)} (oort ${version}${from === 'managed' ? ', the managed copy: oort update keeps it current' : ''})`)}\n`,
    );
    if (bin.olderManaged !== undefined) {
      ctx.io.out(
        `${ui.info(`The managed copy (${show(bin.olderManaged.prefix)}) is oort ${shown(bin.olderManaged.version)}, older than this one, so the hooks run this copy; \`oort update\` brings both to the latest.`)}\n`,
      );
    }
    const onPath = whichOort(ctx.io.env);
    if (from === 'running' && onPath !== undefined && onPath !== cmd) {
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
  } else {
    // Removing needs no bin: uninstallHooks also takes out entries from older install paths.
    cmd = managedCopy(ctx.io.env)?.main ?? runningOr('oort', ctx);
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
      version,
      ...(from !== undefined && { binary: from, installedManaged: installed }),
    });
  }
  return 0;
}

/** This bin's realpath (`hookCommandPath`), or `fallback` when it is not running as its bin. */
function runningOr(fallback: string, ctx: Ctx): string {
  try {
    return hookCommandPath(ctx.io.entry);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return fallback;
  }
}
