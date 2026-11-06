import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { keyLookup, routeSummaries } from '../credentials.js';
import type { Env } from '../io.js';
import { emit, jsonMode } from '../output.js';
import { ACCOUNT_URL, REVOKE_HINT } from '../relay.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, noteWarning, type Ctx } from '../util.js';

/**
 * `oort login`: the browser sign-in that `apps/site` serves, RFC 8628 style.
 * 1. A secret S (32 random bytes) stays in this process. `POST /api/cli/session` sends only
 *    h = base64url(SHA-256(S)), with this computer's OS and host name, and gets back a short
 *    user code.
 * 2. The user opens `/account/cli` (no secret in the URL), types the code, checks the request's
 *    time, country, OS and host, and approves.
 * 3. `POST /api/cli/session/poll` with S in the body answers 202 until approved, then 200
 *    `{ status, key, prefix }` once, and 410 `used` or `expired` (10 minutes after the session
 *    started) after that; 404 for a session the site does not know, 409 `key_limit` when the
 *    account already has its maximum of live keys.
 * The key goes to Keychain item `oort.oort` (macOS) or `credentials.json` (Linux, Windows) and is
 * never printed.
 */

export const DEFAULT_SITE_URL = 'https://oortcloud.dev';
/** The site's session lifetime (CLI_SESSION_TTL_MS in apps/site). */
export const SESSION_TTL_MS = 10 * 60_000;
const KEY_SHAPE = /^oort_sk_[A-Za-z0-9_-]{16,256}$/;
/** The site's user code as shown: 8 letters of BCDFGHJKLMNPQRSTVWXZ, XXXX-XXXX. */
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

export interface LoginDeps {
  fetch?: typeof fetch;
  /** Opens `url` in the browser; resolves false when no opener could start. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Waits `ms`, or less when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Aborts the wait (Ctrl-C). Default: SIGINT while polling. */
  signal?: AbortSignal;
  /** The 32 secret bytes S. */
  secret?: () => Uint8Array;
  /** What the approve page shows about this computer. */
  system?: () => { os: string; host: string };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `OORT_SITE_URL` (https, or http to localhost, for local dev) or oortcloud.dev. */
export function siteUrl(env: Env): string {
  const raw = env['OORT_SITE_URL'];
  if (raw === undefined || raw === '') return DEFAULT_SITE_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Refusal('OORT_SITE_URL is not a URL; unset it to sign in at oortcloud.dev.');
  }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  if (!ok || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw new Refusal(
      'OORT_SITE_URL must be an https URL (or http to localhost) with no credentials or query.',
    );
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** S: 32 random bytes, kept in this process only. */
export const newSecret = (): Uint8Array => randomBytes(32);

/** h = base64url(SHA-256(S)), the only thing about S the site sees before the poll. */
export const challengeOf = (secret: Uint8Array): string =>
  createHash('sha256').update(secret).digest('base64url');

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/** This computer, as the approve page shows it: OS and host name, nothing else. */
export function thisSystem(): { os: string; host: string } {
  return { os: OS_NAMES[process.platform] ?? process.platform, host: os.hostname().slice(0, 64) };
}

/** The platform's opener, without a shell; false when it cannot start. */
export function platformOpener(platform = process.platform): (url: string) => Promise<boolean> {
  return (url) =>
    new Promise((resolve) => {
      const [file, args]: [string, string[]] =
        platform === 'darwin'
          ? ['open', [url]]
          : platform === 'win32'
            ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : ['xdg-open', [url]];
      try {
        const child = spawn(file, args, { stdio: 'ignore', detached: true });
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** Why no key store can hold the key here, or undefined when one can. */
export function keychainBlocker(ctx: Ctx): string | undefined {
  const fallback = `create a key at ${ACCOUNT_URL} and set OORT_API_KEY in the environment your agent starts with instead`;
  if (ctx.io.env['OORT_NO_KEYCHAIN'] === '1') {
    return `OORT_NO_KEYCHAIN=1 is set, so oort login has nowhere to keep the key; unset it, or ${fallback}.`;
  }
  if (!ctx.keychain.supported) {
    return `oort login keeps the key in the macOS Keychain or, on Linux and Windows, in credentials.json; this system has neither; ${fallback}.`;
  }
  return undefined;
}

export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'expired' | 'used' | 'failed'; message: string };

/**
 * The sign-in itself, writing its lines through `say` (stdout for the
 * command, the wizard's log for `oort setup`). It never prompts: on a
 * terminal it opens the browser, otherwise it prints the URL, and either way
 * it polls until approved, expired or cancelled.
 */
export async function runLogin(
  ctx: Ctx,
  say: (text: string) => void,
  ui: Ui,
  opts: { browser?: boolean; mark?: boolean } = {},
  deps: LoginDeps = ctx.login ?? {},
): Promise<LoginOutcome> {
  const blocker = keychainBlocker(ctx);
  if (blocker !== undefined) throw new Refusal(blocker);
  const site = siteUrl(ctx.io.env);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const secretBytes = (deps.secret ?? newSecret)();
  const secret = Buffer.from(secretBytes).toString('base64url');
  const approve = `${site}/account/cli`;
  const poll = `${site}/api/cli/session/poll`;
  const failed = (message: string): LoginOutcome => ({ ok: false, reason: 'failed', message });

  let started: Response;
  try {
    started = await doFetch(`${site}/api/cli/session`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge: challengeOf(secretBytes),
        ...(deps.system ?? thisSystem)(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return failed(`Could not reach ${site}. Check your network, then run \`oort login\` again.`);
  }
  const startBody = (await started.json().catch(() => ({}))) as { user_code?: unknown };
  const code = startBody.user_code;
  if (started.status === 429) {
    return failed(
      'The site has had too many sign-in requests from this network. Wait a minute, then run `oort login` again.',
    );
  }
  if (started.status !== 201 || typeof code !== 'string' || !USER_CODE.test(code)) {
    return failed(
      started.status >= 500
        ? `The site answered HTTP ${started.status}. Run \`oort login\` again later.`
        : 'The site rejected this sign-in request. Update oortmem, then run `oort login` again.',
    );
  }

  const terminal = ctx.io.stdinIsTTY && ctx.io.stdoutIsTTY === true;
  const opened =
    terminal && opts.browser !== false
      ? await (deps.openBrowser ?? platformOpener())(approve)
      : false;
  say(
    opened
      ? `Opened ${approve} in your browser. Sign in there and enter the code below.`
      : `Open this page in a browser, sign in and enter the code below:\n  ${approve}`,
  );
  say(
    ui.kv([
      [
        'code',
        `${ui.bold(ui.accent(code))}  ${ui.dim('type it on the page; approve only if you started this login yourself')}`,
      ],
    ]),
  );
  say(ui.dim('Waiting for approval (Ctrl-C cancels; the request expires in 10 minutes) …'));

  // Ctrl-C ends the wait; nothing has been stored yet, so there is nothing to undo.
  const own = new AbortController();
  const signal = deps.signal ?? own.signal;
  const onSigint = (): void => own.abort();
  if (deps.signal === undefined) process.once('SIGINT', onSigint);
  const cancelled = (): LoginOutcome => ({
    ok: false,
    reason: 'cancelled',
    message: 'Sign-in cancelled; nothing was stored.',
  });
  try {
    const deadline = now() + SESSION_TTL_MS + 30_000;
    let delay = FIRST_DELAY_MS;
    let transient = 0;
    for (;;) {
      if (signal.aborted) return cancelled();
      let res: Response | undefined;
      try {
        // S goes in the body, never in a URL.
        res = await doFetch(poll, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ secret }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
      } catch {
        if (signal.aborted) return cancelled();
        res = undefined; // offline for a moment: keep polling until the deadline
      }
      if (res !== undefined) {
        const body = (await res.json().catch(() => ({}))) as {
          status?: unknown;
          key?: unknown;
        };
        if (res.status === 200) {
          const key = body.key;
          if (typeof key !== 'string' || !KEY_SHAPE.test(key)) {
            return {
              ok: false,
              reason: 'failed',
              message: `The site sent no usable key. Check ${ACCOUNT_URL}: a key named "CLI on <date>" may need revoking.`,
            };
          }
          return await keep(ctx, key, say, ui, opts.mark === true);
        }
        if (res.status === 410) {
          return body.status === 'used'
            ? {
                ok: false,
                reason: 'used',
                message: 'This sign-in request was already used. Run `oort login` again.',
              }
            : {
                ok: false,
                reason: 'expired',
                message: 'This sign-in request expired. Run `oort login` again.',
              };
        }
        if (res.status === 409) {
          return failed(
            `This account already has the most live keys it can have, so no key was made. Revoke a key at ${ACCOUNT_URL}, then run \`oort login\` again.`,
          );
        }
        if (res.status === 404) {
          return failed('The site does not know this sign-in request. Run `oort login` again.');
        }
        if (res.status === 400) {
          return failed(
            'The site rejected this sign-in request. Update oortmem, then run `oort login` again.',
          );
        }
        if (res.status !== 202 && res.status !== 429 && res.status < 500) {
          return {
            ok: false,
            reason: 'failed',
            message: `The site answered HTTP ${res.status}. Run \`oort login\` again later.`,
          };
        }
        transient = res.status === 202 ? 0 : transient + 1;
      } else {
        transient++;
      }
      if (now() >= deadline) {
        return {
          ok: false,
          reason: 'expired',
          message: 'This sign-in request expired. Run `oort login` again.',
        };
      }
      // Every couple of seconds; slower while the site or network is struggling.
      delay = transient > 0 ? Math.min(MAX_DELAY_MS, delay * 1.5) : FIRST_DELAY_MS;
      await sleep(delay, signal);
    }
  } finally {
    if (deps.signal === undefined) process.off('SIGINT', onSigint);
  }
}

/** Stores the key and reads it back, so a Keychain that silently refused is caught. */
async function keep(
  ctx: Ctx,
  key: string,
  say: (t: string) => void,
  ui: Ui,
  mark: boolean,
): Promise<LoginOutcome> {
  const code = await ctx.keychain.store('oort', key);
  const back = code === 0 ? await ctx.keychain.read('oort') : undefined;
  if (back !== key) {
    return {
      ok: false,
      reason: 'failed',
      message: `${ctx.keychain.kind === 'file' ? 'Oort could not store the key in credentials.json (see the line above)' : 'The Keychain did not store the key'}, so nothing was saved. The key the site made for this sign-in ("CLI on <date>") is unused: ${REVOKE_HINT}.`,
    };
  }
  // A finished sign-in is one of the few moments with the mark (colour terminals only).
  const art = mark
    ? ui.mark([
        '',
        '',
        `${ui.bold(ui.gradient('oort'))} ${ui.bold('Pro')}`,
        ui.dim('signed in on this machine'),
      ])
    : '';
  if (art !== '') say(`\n${art}`);
  say(
    ui.ok(
      ctx.keychain.kind === 'file'
        ? `Signed in to Oort Pro. The key is in ${ctx.keychain.where('oort')} (mode 600).`
        : 'Signed in to Oort Pro. The key is in the Keychain as oort.oort.',
    ),
  );
  const routes = await routeSummaries(keyLookup(ctx.io.env, ctx.keychain.read));
  const relayed = Object.values(routes).filter((r) => r.via === 'oort');
  const own = Object.values(routes).filter((r) => r.via === 'vendor');
  say(
    ui.kv(
      [
        ['relay', relayed.length > 0 ? relayed.map((r) => r.role).join(', ') : 'none'],
        ...(own.length > 0
          ? [
              [
                'own keys',
                `${own.map((r) => r.role).join(', ')} (a vendor key always wins)`,
              ] as const,
            ]
          : []),
        ['undo', `oort logout (it does not revoke the key; ${REVOKE_HINT})`],
      ],
      { indent: 2 },
    ),
  );
  if (ctx.io.env['OORT_API_KEY']) {
    say(
      ui.warn(
        `OORT_API_KEY is set in this environment and wins over ${ctx.keychain.kind === 'file' ? 'the stored key' : 'the Keychain item'}.`,
      ),
    );
  }
  return { ok: true };
}

/** `oort login [--no-browser]` */
export async function loginCommand(opts: { browser?: boolean }, ctx: Ctx): Promise<number> {
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('login', 'Oort Pro'));
  const r = await runLogin(ctx, (t) => ctx.io.out(`${t.trimEnd()}\n`), ui, { ...opts, mark: true });
  if (r.ok) {
    if (jsonMode(ctx)) emit(ctx, { signedIn: true, store: ctx.keychain.kind });
    return 0;
  }
  // Expired, used or cancelled: a refusal; the site failing or unreachable: `network`. Exit 1, as
  // a sign-in that did not complete always has.
  throw new Refusal(r.message, {
    code: r.reason === 'failed' ? 'network' : 'refused',
    exitCode: 1,
  });
}

/** `oort logout`: removes the stored Oort key (Keychain item `oort.oort`, or its credentials.json entry). It never revokes the key server-side. */
export async function logoutCommand(ctx: Ctx): Promise<number> {
  const blocker = keychainBlocker(ctx);
  if (blocker !== undefined) {
    throw new Refusal(
      ctx.io.env['OORT_NO_KEYCHAIN'] === '1'
        ? 'OORT_NO_KEYCHAIN=1 is set; unset it to remove the stored key.'
        : 'this system has no stored key to remove (the Keychain is macOS, credentials.json is Linux and Windows); unset OORT_API_KEY to stop using Oort Pro.',
    );
  }
  const ui = uiFor(ctx.io);
  const had = (await ctx.keychain.read('oort')) !== undefined;
  const code = had ? await ctx.keychain.remove('oort') : 0;
  if (code !== 0) {
    throw new Refusal(`${ctx.keychain.label} did not remove the Oort key.`, { code: 'internal' });
  }
  ctx.io.out(
    had
      ? `${ui.ok(ctx.keychain.kind === 'file' ? `Removed the Oort key from ${ctx.keychain.where('oort')}.` : 'Removed the Oort key from the Keychain (oort.oort).')} It still works until you ${REVOKE_HINT}.\n`
      : ctx.keychain.kind === 'file'
        ? `No Oort key in ${ctx.keychain.where('oort')}; nothing changed.\n`
        : 'No Oort key in the Keychain (oort.oort); nothing changed.\n',
  );
  const envKey = Boolean(ctx.io.env['OORT_API_KEY']);
  if (envKey) {
    const msg = 'OORT_API_KEY is still set in this environment; unset it to stop using Oort Pro.';
    ctx.io.out(ui.warn(msg) + '\n');
    noteWarning(ctx, 'env-key-set', msg);
  }
  if (jsonMode(ctx)) emit(ctx, { removed: had, store: ctx.keychain.kind });
  return 0;
}
