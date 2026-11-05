import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  cliVersion,
  encodeFrame,
  homeFrom,
  socketPathFor,
  type ErrorCode,
  type Method,
  type ServedEvent,
} from './serve-protocol.js';

/**
 * The hook side of `oort serve` (CON-18). Loaded by the bin on every prompt before anything
 * heavy, so it imports Node built-ins and the protocol only. Every failure (no daemon, a stale
 * socket, a slow or broken daemon, another version) resolves to "not served": the hook then runs
 * in-process exactly as it would without a daemon.
 */

/** Connecting to a local socket takes well under a millisecond; past this the daemon is stuck. */
export const CONNECT_TIMEOUT_MS = 50;

/**
 * The whole exchange, connect to answer. The daemon's own recall gives up on the embedder and
 * reranker after 1.5 s (then answers lexical-only), so a healthy daemon answers inside this; a
 * hook that falls back after it still has most of Claude Code's 10 s.
 */
export const HOOK_BUDGET_MS: Record<ServedEvent, number> = {
  UserPromptSubmit: 2500,
  SessionStart: 1500,
};

export type CallFailure =
  /** No socket file: no daemon. */
  | 'absent'
  /** A socket file nobody listens on (a daemon that died): stale. */
  | 'refused'
  /** The socket or its directory is not this user's alone; never connected. */
  | 'untrusted'
  | 'connect-timeout'
  | 'timeout'
  /** The connection closed before an answer (a daemon killed mid-request). */
  | 'closed'
  /** An answer in another protocol version, or not a response at all. */
  | 'protocol'
  /** The daemon answered with an error. */
  | 'error'
  /** Any other socket error. */
  | 'io'
  /** Not tried: a recent timeout or refusal opened the circuit breaker (`serve.skip-until`). */
  | 'skipped';

export type CallResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: CallFailure; code?: ErrorCode; message?: string };

export interface CallOptions {
  connectTimeoutMs?: number;
  budgetMs?: number;
}

const uid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/**
 * Whether `socket` may be trusted with a prompt: it and its directory belong to this user, and the
 * directory is not writable by anyone else (who could otherwise swap the socket). Two lstats.
 */
export function socketTrust(socket: string): 'trusted' | 'absent' | 'untrusted' {
  // Unix sockets only; `oort serve` does not run on Windows yet.
  if (process.platform === 'win32') return 'absent';
  const me = uid();
  try {
    const dir = fs.statSync(path.dirname(socket));
    if (me !== undefined && (dir.uid !== me || (dir.mode & 0o022) !== 0)) return 'untrusted';
  } catch {
    return 'absent';
  }
  try {
    const st = fs.lstatSync(socket);
    if (!st.isSocket()) return 'untrusted';
    if (me !== undefined && st.uid !== me) return 'untrusted';
  } catch {
    return 'absent';
  }
  return 'trusted';
}

let nextId = 1;

/**
 * One request to the daemon at `socket` on a fresh connection. Never rejects: every failure is a
 * `CallFailure`. The socket is destroyed on every path, so nothing holds the process open.
 */
export function callDaemon(
  socket: string,
  method: Method,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<CallResult> {
  const trust = socketTrust(socket);
  if (trust !== 'trusted') return Promise.resolve({ ok: false, reason: trust });
  const id = nextId++;
  return new Promise((resolve) => {
    let settled = false;
    const conn = net.createConnection({ path: socket });
    const finish = (r: CallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(budgetTimer);
      conn.destroy();
      resolve(r);
    };
    const connectTimer = setTimeout(
      () => finish({ ok: false, reason: 'connect-timeout' }),
      opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    const budgetTimer = setTimeout(
      () => finish({ ok: false, reason: 'timeout' }),
      opts.budgetMs ?? 2000,
    );
    const decoder = new FrameDecoder();
    conn.on('connect', () => {
      clearTimeout(connectTimer);
      try {
        conn.write(encodeFrame({ v: PROTOCOL_VERSION, id, method, params }));
      } catch {
        finish({ ok: false, reason: 'io' }); // a request too large for a frame
      }
    });
    conn.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        return finish({ ok: false, reason: 'protocol' });
      }
      for (const f of frames) finish(asResult(f, id));
    });
    conn.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') finish({ ok: false, reason: 'absent' });
      else if (e.code === 'ECONNREFUSED') finish({ ok: false, reason: 'refused' });
      else finish({ ok: false, reason: 'io' });
    });
    conn.on('close', () => finish({ ok: false, reason: 'closed' }));
  });
}

function asResult(frame: unknown, id: number): CallResult {
  if (typeof frame !== 'object' || frame === null) return { ok: false, reason: 'protocol' };
  const f = frame as Record<string, unknown>;
  if (f['v'] !== PROTOCOL_VERSION) return { ok: false, reason: 'protocol' };
  if (f['ok'] === true && f['id'] === id) {
    const result = f['result'];
    return typeof result === 'object' && result !== null && !Array.isArray(result)
      ? { ok: true, result: result as Record<string, unknown> }
      : { ok: false, reason: 'protocol' };
  }
  if (f['ok'] === false) {
    const err = (f['error'] ?? {}) as { code?: unknown; message?: unknown };
    return {
      ok: false,
      reason: 'error',
      ...(typeof err.code === 'string' && { code: err.code as ErrorCode }),
      ...(typeof err.message === 'string' && { message: err.message }),
    };
  }
  return { ok: false, reason: 'protocol' };
}

/** The socket for this environment's Oort home. */
export function daemonSocket(env: Record<string, string | undefined>): string {
  return socketPathFor(homeFrom(env, os.homedir));
}

/**
 * The circuit breaker: `<home>/serve.skip-until` holds an epoch-ms time (and why) until which the
 * hooks do not try the daemon at all, so a hung or mismatched daemon costs one slow prompt, not
 * every prompt. Written after a timeout (5 minutes) or a protocol or version refusal (1 minute);
 * removed by a successful answer and by `oort serve` start, status and stop.
 */
export const SKIP_FILE = 'serve.skip-until';
export const SKIP_AFTER_TIMEOUT_MS = 5 * 60_000;
export const SKIP_AFTER_REFUSAL_MS = 60_000;

export type SkipReason = 'timeout' | 'refused';
export interface Skip {
  until: number;
  reason?: SkipReason;
}

const SKIP_LINE = /^(\d{1,16})(?: (timeout|refused))?\s*$/;

/** The marker's text, undefined when there is none. One read. */
function readSkipText(home: string): string | undefined {
  try {
    return fs.readFileSync(path.join(home, SKIP_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

function parseSkip(text: string | undefined): Skip | undefined {
  const m = text === undefined ? null : SKIP_LINE.exec(text);
  if (m === null) return undefined;
  const until = Number(m[1]);
  if (!Number.isSafeInteger(until)) return undefined;
  return { until, ...(m[2] !== undefined && { reason: m[2] as SkipReason }) };
}

/** The marker, or undefined when it is missing or garbled (then the daemon is tried). */
export function readSkip(home: string): Skip | undefined {
  return parseSkip(readSkipText(home));
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Opens the breaker until `until` (0600, never through a symlink). Best effort. */
export function writeSkip(home: string, until: number, reason: SkipReason): void {
  try {
    const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants;
    const fd = fs.openSync(
      path.join(home, SKIP_FILE),
      O_WRONLY | O_CREAT | O_TRUNC | NOFOLLOW,
      0o600,
    );
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, `${until} ${reason}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No marker: the next hook tries the daemon again, which is only slower.
  }
}

/** Closes the breaker. Best effort. */
export function clearSkip(home: string): void {
  try {
    fs.unlinkSync(path.join(home, SKIP_FILE));
  } catch {
    // Not there.
  }
}

export type HookAttempt =
  { served: true; stdout: string } | { served: false; reason: CallFailure; code?: ErrorCode };

/**
 * Asks the daemon to run `event` on `stdin`. `cwd` is the hook's own cwd, used only when the
 * input names none. Served means the daemon ran the same handler the hook would have. While the
 * breaker is open (`readSkip`), the daemon is not contacted at all.
 */
export async function hookViaDaemon(
  event: ServedEvent,
  stdin: string,
  cwd: string,
  env: Record<string, string | undefined>,
  opts: CallOptions & { now?: () => number } = {},
): Promise<HookAttempt> {
  const home = homeFrom(env, os.homedir);
  const now = opts.now ?? Date.now;
  const marker = readSkipText(home);
  const skip = parseSkip(marker);
  if (skip !== undefined && skip.until > now()) return { served: false, reason: 'skipped' };
  const r = await callDaemon(
    socketPathFor(home),
    'hook',
    { event, stdin, cwd, version: cliVersion() },
    { budgetMs: HOOK_BUDGET_MS[event], ...opts },
  );
  if (r.ok) {
    const stdout = r.result['stdout'];
    if (typeof stdout === 'string') {
      if (marker !== undefined) clearSkip(home); // expired or garbled: the daemon is fine again
      return { served: true, stdout };
    }
    // An answer that is not a hook result: as good as another protocol.
    writeSkip(home, now() + SKIP_AFTER_REFUSAL_MS, 'refused');
    return { served: false, reason: 'protocol' };
  }
  if (r.reason === 'timeout' || r.reason === 'connect-timeout') {
    writeSkip(home, now() + SKIP_AFTER_TIMEOUT_MS, 'timeout');
  } else if (
    r.reason === 'protocol' ||
    (r.reason === 'error' && (r.code === 'protocol' || r.code === 'version-mismatch'))
  ) {
    writeSkip(home, now() + SKIP_AFTER_REFUSAL_MS, 'refused');
  }
  return { served: false, reason: r.reason, ...(r.code !== undefined && { code: r.code }) };
}

/**
 * `serve.autostart` from the home config (`$OORT_HOME/config.json`), read without the config
 * module: true only when the file says so. A project's `oort.config.json` is never consulted.
 */
export function autostartEnabled(home: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as {
      serve?: { autostart?: unknown };
    };
    return raw.serve?.autostart === true;
  } catch {
    return false;
  }
}

/**
 * Starts `oort serve` detached from this process (`bin` is the realpath of the bin), its output
 * appended to `$OORT_HOME/logs/serve.log` (0600). Does not wait: a second daemon started at the
 * same moment finds the lock taken and exits.
 */
export function spawnDaemon(
  bin: string,
  home: string,
  env: Record<string, string | undefined>,
  extraArgs: readonly string[] = [],
): number | undefined {
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(logs, 'serve.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [bin, 'serve', ...extraArgs], {
      cwd: home,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: env as NodeJS.ProcessEnv,
    });
    child.on('error', () => {}); // a failed spawn must never crash a hook
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}
