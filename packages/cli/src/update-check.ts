import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewerVersion } from './serve-protocol.js';

/**
 * The update check (CON-114): at most once every 24 hours, one GET of npm's `latest` for
 * `oortmem`, cached in `<OORT_HOME>/update-check.json`. Nothing about the user is sent: no
 * version, no platform, no id, a generic user agent. The hooks only ever read the cache; a stale
 * one is refreshed by a detached process (`update-refresh.js`), never on a hook's path.
 *
 * Loaded by the hook on SessionStart, so it imports Node built-ins and the protocol module only.
 */

export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/oortmem/latest';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;
/** No version, no platform: the same for every user. */
export const CHECK_USER_AGENT = 'oort-update-check';
export const CACHE_FILE = 'update-check.json';
/** The notice for one version is shown at most this often (SessionStart). */
export const NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;
/** npm's `latest` document is a few KB; anything far bigger is not it. */
const MAX_BODY_BYTES = 1024 * 1024;

export const releaseNotesUrl = (version: string): string =>
  `https://github.com/oortmem/oort/releases/tag/v${version}`;

/** The one line every surface shows: `Oort X is available (you have Y): oort update`. */
export const noticeText = (latest: string, current: string): string =>
  `Oort ${latest} is available (you have ${current}): oort update`;

export interface UpdateCache {
  /** Epoch ms of the last check, made or merely started (a failed one counts: once a day). */
  checkedAt?: number;
  /** The newest version npm reported, from the last check that got an answer. */
  latest?: string;
  /** The SessionStart notice last shown: which version, and when (epoch ms). */
  notified?: { version: string; at: number };
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v.trim() !== '' && !['0', 'false', 'no'].includes(v.trim().toLowerCase());

/**
 * Why the check is off, or undefined when it is on: `OORT_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER`
 * (the convention other CLIs share), a CI environment (`CI`), an Oort home it will not write in
 * (`home: …`, see `homeProblem`), or `updates.check: false` in the home config
 * (`<OORT_HOME>/config.json`, read without the config module; a repository's `oort.config.json` is
 * never consulted).
 */
export function updateCheckOff(
  env: Record<string, string | undefined>,
  home: string,
): string | undefined {
  if (truthy(env['OORT_NO_UPDATE_CHECK'])) return 'OORT_NO_UPDATE_CHECK';
  if ((env['NO_UPDATE_NOTIFIER'] ?? '') !== '') return 'NO_UPDATE_NOTIFIER';
  if (truthy(env['CI'])) return 'CI';
  const problem = homeProblem(home);
  if (problem !== undefined) return `home: ${problem}`;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as {
      updates?: { check?: unknown };
    };
    if (raw.updates?.check === false) return 'updates.check';
  } catch {
    // No config, or one the config module will report: the check stays on.
  }
  return undefined;
}

const VERSION_TEXT = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;

/** A valid version string, or undefined. */
export function asVersion(v: unknown): string | undefined {
  return typeof v === 'string' && VERSION_TEXT.test(v) ? v : undefined;
}

/** The cache, or `{}` when it is missing, unreadable or not what we write. Never throws. */
export function readUpdateCache(home: string): UpdateCache {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(home, CACHE_FILE), 'utf8'));
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: UpdateCache = {};
  if (Number.isSafeInteger(r['checkedAt'])) out.checkedAt = r['checkedAt'] as number;
  const latest = asVersion(r['latest']);
  if (latest !== undefined) out.latest = latest;
  const n = r['notified'] as { version?: unknown; at?: unknown } | undefined;
  const nv = asVersion(n?.version);
  if (nv !== undefined && Number.isSafeInteger(n?.at))
    out.notified = { version: nv, at: n?.at as number };
  return out;
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Where the cache may go: the Oort home itself, or, when `~/.oort` is a symlink, the directory it
 * resolves to, but only when that is a directory of this user's that group and others cannot
 * write (someone who could would control what the notice says). `missing`: no home yet (a notice
 * never creates one). `why`: the home is refused, and why.
 */
export function cacheDir(home: string): { dir: string } | { missing: true } | { why: string } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(home);
  } catch {
    return { missing: true };
  }
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const linked = st.isSymbolicLink();
  let dir = home;
  if (linked) {
    try {
      dir = fs.realpathSync(home);
      st = fs.statSync(dir);
    } catch {
      return { why: 'it is a symlink that leads nowhere' };
    }
  }
  const what = linked ? 'it is a symlink to' : 'it is';
  if (!st.isDirectory()) return { why: `${what} something that is not a directory` };
  if (me !== undefined && st.uid !== me) return { why: `${what} a directory of another user's` };
  if (process.platform !== 'win32' && (st.mode & 0o022) !== 0) {
    return { why: `${what} a directory that group or others can write` };
  }
  return { dir };
}

/** Why the Oort home will not hold the cache, or undefined when it will (or does not exist yet). */
export function homeProblem(home: string): string | undefined {
  const d = cacheDir(home);
  return 'why' in d ? d.why : undefined;
}

/**
 * Writes the cache atomically: a new 0600 file beside it (created exclusively, never through a
 * symlink), then a rename over the old one, so a reader sees the old cache or the new one, never
 * half of one. Only into an Oort home that exists (a notice never creates `~/.oort`) and that
 * `cacheDir` accepts. Best effort: false when it could not be written.
 */
export function writeUpdateCache(home: string, cache: UpdateCache): boolean {
  const d = cacheDir(home);
  if (!('dir' in d)) return false;
  const file = path.join(d.dir, CACHE_FILE);
  // O_EXCL makes a clash harmless; node:crypto is not loaded for a name on the hook's path.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
    const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, `${JSON.stringify(cache)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Never created.
    }
    return false;
  }
}

/** Whether the cache is due for a check: never checked, 24 h old, or dated in the future. */
export function isStale(cache: UpdateCache, now: number): boolean {
  const at = cache.checkedAt;
  return at === undefined || now - at >= CHECK_EVERY_MS || at > now + 60 * 60 * 1000;
}

/** The newer version the cache knows of, if any. */
export function availableUpdate(current: string, cache: UpdateCache): string | undefined {
  return cache.latest !== undefined && isNewerVersion(cache.latest, current)
    ? cache.latest
    : undefined;
}

/**
 * npm's `latest` version of `oortmem`: one GET, no credentials, a generic user agent, no redirects,
 * `timeoutMs` (1.5 s) for the whole exchange. Throws on any failure.
 */
export async function fetchLatest(
  fetchFn: typeof fetch,
  opts: { timeoutMs?: number; url?: string } = {},
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  try {
    const res = await fetchFn(opts.url ?? REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json', 'user-agent': CHECK_USER_AGENT },
      redirect: 'error',
      signal: abort.signal,
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error(`npm's registry answered ${res.status}`);
    }
    const text = await cappedText(res, MAX_BODY_BYTES, abort);
    const version = asVersion((JSON.parse(text) as { version?: unknown } | null)?.version);
    if (version === undefined) throw new Error("npm's answer names no version");
    return version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body as text, at most `max` bytes: refused at once when `content-length` says more, and
 * read as a stream with a byte count otherwise, the request aborted the moment it passes `max`.
 */
async function cappedText(res: Response, max: number, abort: AbortController): Promise<string> {
  const tooLarge = (): Error => new Error("npm's answer is too large");
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    abort.abort();
    void res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      abort.abort();
      void reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One check now: asks npm and records the answer. A failed check is recorded too (its time, the
 * last known version kept), so it is not retried before tomorrow. Resolves the latest version, or
 * undefined when npm could not be asked.
 */
export async function refreshUpdateCache(
  home: string,
  fetchFn: typeof fetch,
  now: () => number = Date.now,
): Promise<string | undefined> {
  let latest: string | undefined;
  try {
    latest = await fetchLatest(fetchFn);
  } catch {
    latest = undefined;
  }
  // Re-read just before writing: a notice shown meanwhile keeps its record.
  const cache = readUpdateCache(home);
  writeUpdateCache(home, { ...cache, checkedAt: now(), ...(latest !== undefined && { latest }) });
  return latest;
}

/**
 * Starts a background check when the cache is stale and the check is on. The cache is stamped
 * first, so hooks starting together (several sessions) start one between them. Never throws.
 */
export function requestRefresh(
  home: string,
  env: Record<string, string | undefined>,
  spawnRefresh: () => void,
  now: number = Date.now(),
): boolean {
  try {
    if (updateCheckOff(env, home) !== undefined) return false;
    const cache = readUpdateCache(home);
    if (!isStale(cache, now)) return false;
    if (!writeUpdateCache(home, { ...cache, checkedAt: now })) return false;
    spawnRefresh();
    return true;
  } catch {
    return false;
  }
}

/**
 * The only variables the background check gets: where things are (PATH, HOME, OORT_HOME), the
 * opt-outs, and how to reach npm through a proxy or a corporate CA. No API key, no token, nothing
 * else of the hook's environment.
 */
export const REFRESHER_ENV = [
  'PATH',
  'HOME',
  'OORT_NO_UPDATE_CHECK',
  'NO_UPDATE_NOTIFIER',
  'CI',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows needs these for Node itself to start.
  'SystemRoot',
  'TEMP',
  'TMP',
] as const;

export function refresherEnv(
  env: Record<string, string | undefined>,
  home: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of REFRESHER_ENV) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  out['OORT_HOME'] = home;
  return out;
}

/** The background check's script, beside this module in the built package. */
export function refreshScript(): string {
  return fileURLToPath(new URL('./update-refresh.js', import.meta.url));
}

/**
 * Starts `update-refresh.js` detached, its output discarded, for `home`. It never holds this
 * process open and a failed spawn is ignored: the next check is tomorrow.
 */
export function spawnRefresh(
  home: string,
  env: Record<string, string | undefined>,
  spawnFn: typeof spawn = spawn,
): void {
  try {
    const child = spawnFn(process.execPath, [refreshScript()], {
      cwd: home,
      detached: true,
      stdio: 'ignore',
      env: refresherEnv(env, home),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Nothing to do: the notice waits for the next check.
  }
}

/**
 * The SessionStart hook's stdout with the update notice for the person added, as the top-level
 * `systemMessage`. Claude Code: "Warning message shown to the user". Codex runs the same hook (the
 * plugin's hooks.json): its SessionStart output schema allows `systemMessage` (it rejects unknown
 * fields), surfaces it "as a warning in the UI or event stream", and keeps it out of the model's
 * context (codex-rs/hooks/src/events/session_start.rs makes it a Warning entry, apart from
 * `additional_contexts_for_model`). Never `additionalContext` (the model's
 * context). Shown once per new version per day; never on `compact`. The memory context (the
 * `hookSpecificOutput` the hook printed) is kept exactly. Reads the cache only, and asks for a
 * background check when it is stale. Never throws: anything unexpected returns `stdout` as is.
 */
export function sessionStartNotice(
  stdout: string,
  stdin: string | undefined,
  opts: {
    home: string;
    env: Record<string, string | undefined>;
    current: string;
    spawnRefresh: () => void;
    now?: number;
  },
): string {
  try {
    const now = opts.now ?? Date.now();
    if (updateCheckOff(opts.env, opts.home) !== undefined) return stdout;
    requestRefresh(opts.home, opts.env, opts.spawnRefresh, now);
    if (sessionSource(stdin) === 'compact') return stdout;
    const cache = readUpdateCache(opts.home);
    const latest = availableUpdate(opts.current, cache);
    if (latest === undefined) return stdout;
    const n = cache.notified;
    if (n?.version === latest && now - n.at < NOTICE_EVERY_MS && n.at <= now) return stdout;
    const merged = withSystemMessage(stdout, noticeText(latest, opts.current));
    if (merged === undefined) return stdout;
    writeUpdateCache(opts.home, {
      ...readUpdateCache(opts.home),
      notified: { version: latest, at: now },
    });
    return merged;
  } catch {
    return stdout;
  }
}

function sessionSource(stdin: string | undefined): string | undefined {
  try {
    const raw = JSON.parse(stdin ?? '') as { source?: unknown } | null;
    return typeof raw?.source === 'string' ? raw.source : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `stdout` (empty, or the hook's JSON object) with a top-level `systemMessage`; undefined when it
 * is not a JSON object or already has one.
 */
export function withSystemMessage(stdout: string, message: string): string | undefined {
  if (stdout === '') return JSON.stringify({ systemMessage: message });
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  if (Object.hasOwn(raw, 'systemMessage')) return undefined;
  return JSON.stringify({ systemMessage: message, ...(raw as Record<string, unknown>) });
}
