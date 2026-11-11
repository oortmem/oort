import { spawn } from 'node:child_process';
import { resolveHome } from '@oortmem/core';
import { clientFor } from './cloud.js';
import { findCloudMemory, readCloudSettings } from '../cloud.js';
import { keyLookup } from '../credentials.js';
import type { Env, Io } from '../io.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, echo, warn, type Ctx } from '../util.js';
import { DEFAULT_SITE_URL, siteUrl } from './login.js';

/**
 * `oort open [target]` (CON-107): the right oortcloud.dev page in the default browser. There is
 * no local viewer (CON-107 decided against a local UI): the visual layer is the dashboard, which
 * shows Oort Cloud memories. With `--json`, without a terminal or a display (SSH, CI,
 * `BROWSER=none`, no `DISPLAY` on Linux) or with `--no-browser` it prints the address instead,
 * and it never fails for want of a browser. The URL never goes through a shell.
 */

/** Each target and its page. `memory` takes an id. */
export const OPEN_PAGES = {
  dashboard: '/dashboard',
  'star-map': '/dashboard/star-map',
  memory: '/dashboard/memories',
  account: '/account',
  docs: '/docs',
  quickstart: '/docs/quickstart',
} as const;
export type OpenTarget = keyof typeof OPEN_PAGES;
export const OPEN_TARGETS = Object.keys(OPEN_PAGES) as OpenTarget[];

/** Starts the browser on `url`; false when it could not. Tests pass a fake. */
export type Opener = (url: string) => Promise<boolean>;

export interface OpenDeps {
  opener?: Opener;
  /** The platform the display check and the default opener follow (default `process.platform`). */
  platform?: NodeJS.Platform;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** A full memory id, as the dashboard's memory page takes it. */
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What `oort open memory` takes: a full id or a prefix of one. */
const ID_PREFIX = /^[0-9a-f][0-9a-f-]{0,35}$/i;
/** A path the CLI builds: segments of letters, digits and dashes. */
const SAFE_PATH = /^(\/[A-Za-z0-9-]+)*\/?$/;

/**
 * Whether `url` is one `oort open` may hand to a browser: https on oortcloud.dev, or a loopback
 * site for local development (`OORT_SITE_URL=http://localhost:3000`), with a plain path and no
 * credentials, query or fragment.
 */
export function openableUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const site =
    (u.protocol === 'https:' &&
      u.hostname === new URL(DEFAULT_SITE_URL).hostname &&
      u.port === '') ||
    ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname));
  return (
    site &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    SAFE_PATH.test(u.pathname) &&
    u.href === url
  );
}

/** The page for `target` on the site (`OORT_SITE_URL` or oortcloud.dev); refused when it is not openable. */
export function pageUrl(env: Env, target: OpenTarget, id?: string): string {
  const site = siteUrl(env);
  if (id !== undefined && !FULL_ID.test(id)) throw new Error(`not a full memory id: ${id}`);
  const url = `${site}${OPEN_PAGES[target]}${id === undefined ? '' : `/${id.toLowerCase()}`}`;
  if (!openableUrl(url)) {
    throw new Refusal(
      'oort open opens oortcloud.dev only (or a localhost OORT_SITE_URL for local development); unset OORT_SITE_URL.',
    );
  }
  return url;
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

/** Why no browser should start here, or undefined when one can. */
export function noBrowserReason(io: Io, platform: NodeJS.Platform): string | undefined {
  const env = io.env;
  if (io.stdoutIsTTY !== true) return 'stdout is not a terminal';
  if (env['BROWSER'] === 'none') return 'BROWSER=none';
  if (truthy(env['CI'])) return 'CI is set';
  if (truthy(env['SSH_CONNECTION']) || truthy(env['SSH_TTY']) || truthy(env['SSH_CLIENT'])) {
    return 'this is an SSH session';
  }
  if (
    platform !== 'darwin' &&
    platform !== 'win32' &&
    !truthy(env['DISPLAY']) &&
    !truthy(env['WAYLAND_DISPLAY'])
  ) {
    return 'no display (DISPLAY and WAYLAND_DISPLAY are unset)';
  }
  return undefined;
}

/** The program and arguments that open `url`: `$BROWSER` when set, else the platform's opener. */
export function openerCommand(
  url: string,
  platform: NodeJS.Platform,
  env: Env,
): [string, string[]] {
  const browser = env['BROWSER'];
  if (browser !== undefined && browser !== '' && browser !== 'none') return [browser, [url]];
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/** How long an opener may take to say it failed; one still running after this has started. */
const OPENER_WAIT_MS = 3000;

/**
 * The default opener: the command `openerCommand` names, started without a shell (the URL is one
 * argument). False when it cannot start or exits non-zero within a few seconds.
 */
export function systemOpener(
  platform: NodeJS.Platform,
  env: Env,
  spawnFn: typeof spawn = spawn,
): Opener {
  return (url) =>
    new Promise((resolve) => {
      const [file, args] = openerCommand(url, platform, env);
      let child: ReturnType<typeof spawn> | undefined;
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        child?.unref();
        done(true);
      }, OPENER_WAIT_MS);
      try {
        child = spawnFn(file, args, { stdio: 'ignore', detached: true, shell: false });
      } catch {
        done(false);
        return;
      }
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
    });
}

/** Whether this machine's memories are on the dashboard: Oort Cloud mode, or an Oort key. */
async function dashboardUser(ctx: Ctx): Promise<boolean> {
  if (readCloudSettings(resolveHome(ctx.io.env)).store === 'cloud') return true;
  return (await keyLookup(ctx.io.env, ctx.keychain.read)('oort')) !== undefined;
}

/** The full id of memory `ref` in Oort Cloud; refused in local mode, which has no memory page. */
async function cloudMemoryId(ctx: Ctx, ref: string): Promise<string> {
  if (!ID_PREFIX.test(ref)) {
    throw new Refusal(`${echo(ref)} is not a memory id; \`oort inspect\` lists them.`);
  }
  if (readCloudSettings(resolveHome(ctx.io.env)).store !== 'cloud') {
    throw new Refusal(
      'This machine keeps its memories in the local store, and the dashboard shows Oort Cloud memories only; `oort inspect <id>` shows it here.',
      { code: 'cloud-only', fix: `oort inspect ${ref}` },
    );
  }
  if (FULL_ID.test(ref)) return ref;
  const id = (await findCloudMemory(await clientFor(ctx), ref)).id;
  if (!FULL_ID.test(id))
    throw new Refusal('Oort Cloud answered with an unexpected memory id.', { code: 'internal' });
  return id;
}

/** `oort open [target] [id] [--no-browser] [--json]` */
export async function openCommand(
  target: OpenTarget | undefined,
  id: string | undefined,
  opts: { browser?: boolean },
  ctx: Ctx,
  deps: OpenDeps = ctx.open ?? {},
): Promise<number> {
  if (target === 'memory' && id === undefined) {
    throw new Refusal('oort open memory needs the memory id: oort open memory <id>.', {
      fix: 'oort inspect',
    });
  }
  if (target !== 'memory' && id !== undefined) {
    throw new Refusal(
      `oort open ${target ?? ''} takes no id; only \`oort open memory <id>\` does.`,
    );
  }
  let chosen: OpenTarget = target ?? 'dashboard';
  if (target === undefined && !(await dashboardUser(ctx))) {
    // Nothing local to open (no local viewer), and no Oort Cloud account here.
    chosen = 'quickstart';
    warn(
      ctx,
      'no-dashboard',
      'Not signed in to Oort Pro, and Oort has no local viewer (`oort inspect` lists your memories), so this opens the quickstart; `oort open dashboard` opens the dashboard anyway.',
    );
  }
  const url = pageUrl(
    ctx.io.env,
    chosen,
    chosen === 'memory' ? await cloudMemoryId(ctx, id!) : undefined,
  );
  if (jsonMode(ctx)) {
    // A script gets the address; it opens it itself if it wants to.
    emit(ctx, { target: chosen, url, opened: false });
    return 0;
  }
  const ui = uiFor(ctx.io);
  const platform = deps.platform ?? process.platform;
  const why = opts.browser === false ? undefined : noBrowserReason(ctx.io, platform);
  if (opts.browser !== false && why === undefined) {
    const opened = await (deps.opener ?? systemOpener(platform, ctx.io.env))(url);
    if (opened) {
      ctx.io.out(`${ui.ok(`Opened ${url}`)}\n`);
      return 0;
    }
    ctx.io.out(`${url}\n`);
    ctx.io.err(`${ui.dim('The browser did not start; open the address above.')}\n`);
    return 0;
  }
  // The address alone on stdout, so `oort open docs | pbcopy` works.
  ctx.io.out(`${url}\n`);
  if (why !== undefined) ctx.io.err(`${ui.dim(`Not opening a browser (${why}).`)}\n`);
  return 0;
}
