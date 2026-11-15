import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  cliVersion,
  currentUid,
  encodeFrame,
  inspectDir,
  homeFrom,
  lockPathFor,
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

/**
 * Whether `socket` may be trusted with a prompt: its directory is a real directory (not a symlink)
 * of this user's that nobody else can write (who could otherwise swap the socket), and the socket
 * is this user's. Two lstats. This guards against other users, not against code running as you:
 * that code could answer on the socket, which is why `validHookStdout` checks every answer.
 */
export function socketTrust(socket: string): 'trusted' | 'absent' | 'untrusted' {
  // Unix sockets only; `oort serve` does not run on Windows yet.
  if (process.platform === 'win32') return 'absent';
  const me = currentUid();
  const dir = inspectDir(path.dirname(socket), me);
  if (dir === 'absent') return 'absent';
  if (dir !== 'ok' && dir !== 'readable-by-others') return 'untrusted';
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
    // On a loaded machine a timer can come due while this process waits for a core, in the same
    // turn of the event loop as a connect or an answer that has already arrived; timers run
    // first. Deciding one `setImmediate` later reads what is already waiting first, so only a
    // daemon that has really not answered times out.
    const connectTimer = setTimeout(
      () => setImmediate(() => conn.connecting && finish({ ok: false, reason: 'connect-timeout' })),
      opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    const budgetTimer = setTimeout(
      () => setImmediate(() => finish({ ok: false, reason: 'timeout' })),
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
  return socketPathFor(homeFrom(env, os.homedir), env);
}

/**
 * The most context any hook injects: the recall budget (`recall.budgetChars`) is capped at this
 * (Claude Code moves a longer `additionalContext` to a file), so it bounds every configuration
 * without reading one.
 */
export const HOOK_CONTEXT_MAX_CHARS = 10_000;
const BLOCK_OPEN = '<oort-memory>\n';
const BLOCK_CLOSE = '\n</oort-memory>';
/** The block tags as `escapeBlockTags` in core neutralises them inside memory text. */
const BLOCK_TAG = /<(?=\s*\/?\s*oort-)/i;

/**
 * The daemon's answer as the hook may print it, or undefined when it is not exactly what the
 * in-process hook emits for `event`: nothing, or `{"hookSpecificOutput":{"hookEventName":
 * <event>,"additionalContext":"<oort-memory>\n…\n</oort-memory>"}}` with no other key, within
 * HOOK_CONTEXT_MAX_CHARS. Code running as this user could answer on the socket; this keeps it
 * from injecting anything shaped differently. Re-serialised, so the bytes printed are ours.
 */
export function validHookStdout(event: ServedEvent, stdout: string): string | undefined {
  if (stdout === '') return '';
  if (stdout.length > HOOK_CONTEXT_MAX_CHARS * 2) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const exactly = (v: unknown, keys: string[]): v is Record<string, unknown> =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k));
  if (!exactly(raw, ['hookSpecificOutput'])) return undefined;
  const out = raw['hookSpecificOutput'];
  if (!exactly(out, ['hookEventName', 'additionalContext'])) return undefined;
  const text = out['additionalContext'];
  if (out['hookEventName'] !== event || typeof text !== 'string') return undefined;
  if (text.length > HOOK_CONTEXT_MAX_CHARS) return undefined;
  if (!text.startsWith(BLOCK_OPEN) || !text.endsWith(BLOCK_CLOSE)) return undefined;
  const inner = text.slice(BLOCK_OPEN.length, text.length - BLOCK_CLOSE.length);
  if (inner.length === 0 || BLOCK_TAG.test(inner)) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
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

/**
 * `migration`: the daemon would not start because the store needs its schema migration
 * (`oort doctor`). `start`: a daemon the hooks started did not start or did not stay up; the wait
 * grows with each failure in a row (`backoffMs`).
 */
export type SkipReason = 'timeout' | 'refused' | 'migration' | 'start';
export interface Skip {
  until: number;
  reason?: SkipReason;
}

const SKIP_LINE = /^(\d{1,16})(?: (timeout|refused|migration|start))?\s*$/;

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
  | { served: true; stdout: string; timings?: Record<string, number> }
  | {
      served: false;
      reason: CallFailure;
      code?: ErrorCode;
      /** A second `restarting` within RESTART_WINDOW_MS: the breaker is now open; start nothing. */
      tripped?: true;
    };

/**
 * A daemon answers `restarting` once per update. Twice within this long (an older daemon started
 * again and again, by hand or by something else), and the hooks open the circuit breaker for the
 * usual minute instead of starting yet another daemon.
 */
export const RESTART_WINDOW_MS = 60_000;
/** When a hook last heard `restarting` (epoch ms), beside the breaker's marker. */
export const RESTART_FILE = 'serve.restarting';

function readRestartAt(home: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(path.join(home, RESTART_FILE), 'utf8').trim());
    return Number.isSafeInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Records `at` (0600, never through a symlink). Best effort. */
function writeRestartAt(home: string, at: number): void {
  try {
    const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants;
    const fd = fs.openSync(
      path.join(home, RESTART_FILE),
      O_WRONLY | O_CREAT | O_TRUNC | NOFOLLOW,
      0o600,
    );
    try {
      fs.writeSync(fd, `${at}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No record: at worst one more restart before the breaker opens.
  }
}

/** The daemon's timings for `OORT_HOOK_TIMING=1`: at most 64 finite numbers, else none. */
export function validTimings(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > 64) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_]{1,48}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) {
      return undefined;
    }
    out[k] = v;
  }
  return out;
}

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
  opts: CallOptions & { now?: () => number; timing?: boolean } = {},
): Promise<HookAttempt> {
  const home = homeFrom(env, os.homedir);
  const now = opts.now ?? Date.now;
  const marker = readSkipText(home);
  const skip = parseSkip(marker);
  if (skip !== undefined && skip.until > now()) {
    // A failed start waits out its backoff, unless the home config changed since: that may be
    // the fix, so the next prompt tries at once.
    if (skip.reason !== 'start' || readAutostartState(home).configMtime === configMtime(home)) {
      return { served: false, reason: 'skipped' };
    }
    clearSkip(home);
    writeAutostartState(home, { failures: 0 });
  }
  const { timing, now: _now, ...callOpts } = opts;
  const r = await callDaemon(
    socketPathFor(home, env),
    'hook',
    { event, stdin, cwd, version: cliVersion(), ...(timing === true && { timing: true }) },
    { budgetMs: HOOK_BUDGET_MS[event], ...callOpts },
  );
  if (r.ok) {
    const raw = r.result['stdout'];
    const stdout = typeof raw === 'string' ? validHookStdout(event, raw) : undefined;
    if (stdout !== undefined) {
      if (marker !== undefined) clearSkip(home); // expired or garbled: the daemon is fine again
      noteServed(home, now());
      const timings = timing === true ? validTimings(r.result['timings']) : undefined;
      return { served: true, stdout, ...(timings !== undefined && { timings }) };
    }
    // An answer that is not exactly a hook result: as good as another protocol.
    writeSkip(home, now() + SKIP_AFTER_REFUSAL_MS, 'refused');
    return { served: false, reason: 'protocol' };
  }
  // `restarting`: the daemon was an older oort and is exiting for this one. No breaker: the hook
  // starts this version's daemon (main.ts), which the next prompt should use at once. A second one
  // within a minute means something keeps starting an older daemon: open the breaker instead.
  if (r.reason === 'error' && r.code === 'restarting') {
    const at = now();
    const last = readRestartAt(home);
    if (last !== undefined && at - last >= 0 && at - last < RESTART_WINDOW_MS) {
      writeSkip(home, at + SKIP_AFTER_REFUSAL_MS, 'refused');
      return { served: false, reason: r.reason, code: r.code, tripped: true };
    }
    writeRestartAt(home, at);
    return { served: false, reason: r.reason, code: r.code };
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
 * Why autostart is off, or undefined when it is on (the default):
 * - `windows`: the daemon needs Unix sockets, so on Windows autostart does nothing;
 * - `OORT_NO_AUTOSTART`: set (and not `0` or `false`) in the hook's environment;
 * - `serve.autostart`: `false` in the home config (`$OORT_HOME/config.json`);
 * - `config`: a home config that does not parse, which the daemon could not read either;
 * - `serve.invalid`: `serve` is not an object, `serve.autostart` is not a boolean, or
 *   `serve.idleMinutes` is not a whole number from 1 to 1440. The daemon's config check would
 *   refuse it, so a start would fail every time; only `true` or no key means on.
 * Read without the config module; a project's `oort.config.json` is never consulted.
 */
export type AutostartOff =
  'windows' | 'OORT_NO_AUTOSTART' | 'serve.autostart' | 'config' | 'serve.invalid';

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v.trim() !== '' && !['0', 'false', 'no'].includes(v.trim().toLowerCase());

export function autostartOff(
  home: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): AutostartOff | undefined {
  if (platform === 'win32') return 'windows';
  if (truthy(env['OORT_NO_AUTOSTART'])) return 'OORT_NO_AUTOSTART';
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  } catch {
    return undefined; // no home config: the defaults, on
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'config';
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'serve.invalid';
  if (!Object.hasOwn(raw, 'serve')) return undefined;
  const serve = (raw as { serve?: unknown }).serve;
  if (typeof serve !== 'object' || serve === null || Array.isArray(serve)) return 'serve.invalid';
  const { autostart, idleMinutes } = serve as { autostart?: unknown; idleMinutes?: unknown };
  if (
    idleMinutes !== undefined &&
    !(
      Number.isInteger(idleMinutes) &&
      (idleMinutes as number) >= 1 &&
      (idleMinutes as number) <= 1440
    )
  ) {
    return 'serve.invalid';
  }
  if (autostart === undefined || autostart === true) return undefined;
  return autostart === false ? 'serve.autostart' : 'serve.invalid';
}

/**
 * A daemon that holds the lock but does not listen yet stays "starting" this long: it is opening
 * the store and warming its first engine (loading a local model can take seconds). Past this, a
 * hook starts another, and that one's lock check decides (a reused pid, a daemon that hangs).
 */
export const STARTING_GRACE_MS = 60_000;

/**
 * Whether a daemon is starting for this lock: its pid file is a regular file, younger than
 * STARTING_GRACE_MS, naming a live process. A hook then starts none (it would only find the lock
 * taken and exit). One lstat, one read, one signal-0.
 */
export function daemonStarting(lock: string, now = Date.now()): boolean {
  try {
    const st = fs.lstatSync(lock);
    if (!st.isFile() || now - st.mtimeMs > STARTING_GRACE_MS) return false;
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, another user's
  }
}

/**
 * What a hook does after `hookViaDaemon` did not get an answer: the function that starts a
 * daemon, or undefined to start none. Called with the attempt's result; the caller runs the
 * function only after the hook's own answer is written, so a prompt never waits on a start.
 * - `restarting` (not tripped): the daemon was an older oort and is exiting for this one; start
 *   this version's in its place whatever autostart says, since one was running.
 * - No daemon (`absent`) or a dead one's socket (`refused`): start one when autostart is on and
 *   none is starting already.
 * Anything else (a timeout, an open breaker, a refusal) starts nothing.
 */
export function autostartPlan(
  r: HookAttempt,
  home: string,
  env: Record<string, string | undefined>,
  now = Date.now(),
): 'restart' | 'start' | undefined {
  if (r.served) return undefined;
  if (r.code === 'restarting') return r.tripped === true ? undefined : 'restart';
  if (r.reason !== 'absent' && r.reason !== 'refused') return undefined;
  if (autostartOff(home, env) !== undefined) return undefined;
  if (daemonStarting(lockPathFor(socketPathFor(home, env)), now)) return undefined;
  // The last start (`spawnDaemon` records it): under 30 s ago, that daemon is still coming up or
  // has just died; start no other. Under a minute ago with nothing answering, it died young (a
  // crash after listening, or before it could open the breaker itself): a failure, which opens
  // the breaker for the next step of the backoff.
  const spawnedAt = readAutostartState(home).spawnedAt;
  const age = spawnedAt === undefined ? Infinity : now - spawnedAt;
  if (age >= 0 && age < RECENT_SPAWN_MS) return undefined;
  if (age >= 0 && age < YOUNG_DEATH_MS) {
    recordStartFailure(home, 'start', now);
    return undefined;
  }
  return 'start';
}

/**
 * What autostart remembers between hooks, in `<home>/serve.autostart` (0600, never through a
 * symlink): when a hook last started a daemon, how many starts in a row failed, and the home
 * config's mtime when the last one failed (an edit starts the count again).
 * One line: `<spawnedAt|-> <failures> <configMtime|->`.
 */
export const AUTOSTART_FILE = 'serve.autostart';
/** A start younger than this is not repeated: that daemon is still coming up, or just died. */
export const RECENT_SPAWN_MS = 30_000;
/** A daemon gone within this long of its start died young: a failed start. */
export const YOUNG_DEATH_MS = 60_000;
/** The breaker after the 1st, 2nd and 3rd (and every later) failed start in a row. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

export interface AutostartState {
  spawnedAt?: number;
  failures: number;
  configMtime?: number;
}

/** How long the breaker stays open after `failures` failed starts in a row. */
export function backoffMs(failures: number): number {
  return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1] as number;
}

/** The home config's mtime in ms, or -1 when there is none. */
export function configMtime(home: string): number {
  try {
    return Math.trunc(fs.statSync(path.join(home, 'config.json')).mtimeMs);
  } catch {
    return -1;
  }
}

const STATE_LINE = /^(\d{1,16}|-) (\d{1,4}) (-?\d{1,16}|-)\s*$/;

/** The state, or none (no failures) when the file is missing or garbled. */
export function readAutostartState(home: string): AutostartState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, AUTOSTART_FILE), 'utf8');
  } catch {
    return { failures: 0 };
  }
  const m = STATE_LINE.exec(text);
  if (m === null) return { failures: 0 };
  const num = (t: string | undefined): number | undefined =>
    t === undefined || t === '-' ? undefined : Number(t);
  const spawnedAt = num(m[1]);
  const configMtime = num(m[3]);
  return {
    failures: Number(m[2]),
    ...(spawnedAt !== undefined && { spawnedAt }),
    ...(configMtime !== undefined && { configMtime }),
  };
}

/** Writes the state (0600, never through a symlink). Best effort. */
export function writeAutostartState(home: string, st: AutostartState): void {
  const show = (n: number | undefined): string => (n === undefined ? '-' : String(Math.trunc(n)));
  try {
    const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants;
    const fd = fs.openSync(
      path.join(home, AUTOSTART_FILE),
      O_WRONLY | O_CREAT | O_TRUNC | NOFOLLOW,
      0o600,
    );
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(
        fd,
        `${show(st.spawnedAt)} ${Math.min(st.failures, 9999)} ${show(st.configMtime)}\n`,
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No record: autostart only retries sooner.
  }
}

/** Forgets the starts and failures (a start, stop or status by hand). Best effort. */
export function resetAutostart(home: string): void {
  try {
    fs.unlinkSync(path.join(home, AUTOSTART_FILE));
  } catch {
    // Not there.
  }
}

/**
 * A daemon did not start or did not stay up: one more failure in a row (the first again when the
 * home config changed since the last), and the breaker opens for `backoffMs` of them. Returns
 * until when. `migration` keeps its own reason, which `oort doctor` clears once it migrates.
 */
export function recordStartFailure(
  home: string,
  reason: 'start' | 'migration',
  now = Date.now(),
): number {
  const st = readAutostartState(home);
  const mtime = configMtime(home);
  const failures = st.configMtime === mtime ? st.failures + 1 : 1;
  writeAutostartState(home, {
    ...(st.spawnedAt !== undefined && { spawnedAt: st.spawnedAt }),
    failures,
    configMtime: mtime,
  });
  const until = now + backoffMs(failures);
  writeSkip(home, until, reason);
  return until;
}

/**
 * A daemon answered a hook. Once it has been up for a minute, it is healthy: the failure count
 * goes back to 0. One read of a small file; a write only when there were failures.
 */
export function noteServed(home: string, now = Date.now()): void {
  const st = readAutostartState(home);
  if (st.failures === 0) return;
  if (st.spawnedAt !== undefined && now - st.spawnedAt < YOUNG_DEATH_MS) return;
  writeAutostartState(home, {
    ...(st.spawnedAt !== undefined && { spawnedAt: st.spawnedAt }),
    failures: 0,
  });
}

/**
 * `dir` as a private directory of this user's: created 0700 when missing, refused when it is a
 * symlink, not a directory or someone else's; group or others' access is removed only after that
 * lstat. (`ensurePrivateDir` in core does this for commands; the hook client does not load core.)
 */
export function privateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const state = inspectDir(dir);
  if (state === 'readable-by-others') fs.chmodSync(dir, 0o700);
  else if (state !== 'ok') throw new Error(`${dir}: ${state}`);
}

/** serve.log past this is moved to serve.log.1 (replacing an older one) before a start writes. */
export const LOG_MAX_BYTES = 1024 * 1024;

/**
 * Opens `file` for appending, 0600, never through a symlink; a wider mode is tightened. A regular
 * file of this user's over LOG_MAX_BYTES is first renamed to `<file>.1` (a rename moves the link,
 * never what a symlink points at), so the log keeps at most about twice that. The caller closes
 * the descriptor.
 */
export function openPrivateLog(file: string): number {
  try {
    const st = fs.lstatSync(file);
    const me = currentUid();
    if (st.isFile() && (me === undefined || st.uid === me) && st.size > LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // Not there yet, or another start rotated it a moment ago.
  }
  const { O_WRONLY, O_CREAT, O_APPEND } = fs.constants;
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_APPEND | NOFOLLOW, 0o600);
  try {
    if (process.platform !== 'win32' && (fs.fstatSync(fd).mode & 0o077) !== 0) {
      fs.fchmodSync(fd, 0o600);
    }
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * Starts `oort serve` detached from this process (`bin` is the realpath of the bin), its output
 * appended to `$OORT_HOME/logs/serve.log` (0600). `home` is absolute and goes to the child as its
 * `OORT_HOME`, so a relative `OORT_HOME` cannot make it serve another home. Does not wait: a
 * second daemon started at the same moment finds the lock taken and exits. A spawn that fails
 * opens the circuit breaker, so the next sessions do not try again at once; one that fails at
 * once (no pid) also throws. A start is recorded in AUTOSTART_FILE.
 */
export function spawnDaemon(
  bin: string,
  home: string,
  env: Record<string, string | undefined>,
  extraArgs: readonly string[] = [],
): number | undefined {
  privateDir(home);
  const logs = path.join(home, 'logs');
  privateDir(logs);
  const fd = openPrivateLog(path.join(logs, 'serve.log'));
  try {
    const child = spawn(process.execPath, [bin, 'serve', ...extraArgs], {
      cwd: home,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, OORT_HOME: home } as NodeJS.ProcessEnv,
    });
    // A failed spawn must never crash a hook; it only opens the breaker (the backoff's next step).
    child.on('error', () => recordStartFailure(home, 'start'));
    child.unref();
    // No pid: the spawn failed (its 'error' comes later, after a hook has exited). Say so now.
    if (child.pid === undefined) throw new Error('could not start oort serve');
    // When: so the next hooks neither start another while this one comes up, nor miss that it
    // died young (`autostartPlan`).
    const st = readAutostartState(home);
    writeAutostartState(home, {
      spawnedAt: Date.now(),
      failures: st.failures,
      ...(st.configMtime !== undefined && { configMtime: st.configMtime }),
    });
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Removes what a stopped daemon left behind, but only what is plainly ours: a socket of this user's
 * that nothing answers on (`refused`), and a pid file of this user's whose process is gone.
 */
export function removeLeftovers(socket: string, lock: string, socketRefused: boolean): boolean {
  const me = currentUid();
  let removed = false;
  const remove = (file: string, ok: (st: fs.Stats) => boolean): void => {
    try {
      const st = fs.lstatSync(file);
      if ((me === undefined || st.uid === me) && ok(st)) {
        // The same file we judged, not one swapped in since.
        const again = fs.lstatSync(file);
        if (again.ino === st.ino && again.mtimeMs === st.mtimeMs) {
          fs.unlinkSync(file);
          removed = true;
        }
      }
    } catch {
      // Gone already.
    }
  };
  if (socketRefused) remove(socket, (st) => st.isSocket());
  remove(lock, (st) => {
    if (!st.isFile()) return false;
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  });
  return removed;
}
