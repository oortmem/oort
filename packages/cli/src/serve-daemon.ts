import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { filterFor, type HookEvent } from '@oortmem/claude-code';
import { formatForInjection, recall, resolveConfig, resolveProject } from '@oortmem/core';
import { StoreMigrationRequiredError } from '@oortmem/store-sqlite';
import { readCloudSettings } from './cloud.js';
import { KEEP_ALIVE_MS, closeCloudPool, warmCloud } from './cloud-http.js';
import { hookWireOptions, inputCwd, isBusy, runWiredHook } from './commands/hook.js';
import type { Env } from './io.js';
import { LOCAL_PROVIDER } from './local-models.js';
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  METHODS,
  PROTOCOL_VERSION,
  SERVED_EVENTS,
  currentUid,
  encodeFrame,
  inspectDir,
  isNewerVersion,
  lockPathFor,
  socketPathFor,
  type ErrorCode,
  type Method,
} from './serve-protocol.js';
import { Refusal, shown } from './util.js';
import { statedProjectPrivacy, type WireFn, type Wired } from './wire.js';

/**
 * `oort serve` (CON-18): one long-lived process per Oort home, so a hook pays for a socket
 * round trip instead of loading the engine, opening SQLite and reading keys on every prompt.
 *
 * - Listens on a Unix socket only (`socketPathFor`), mode 0600, in a directory owned by this user
 *   and writable by nobody else. No TCP listener, ever.
 * - One instance per home, through an exclusive pid file beside the socket.
 * - Keeps wired engines (store, embedder, reranker) warm per project configuration, re-wiring
 *   each in the background once it is a minute old, so edited config and keys are picked up.
 * - Never migrates the store: an engine is wired exactly as a hook wires one (`migrate: false`).
 * - Validates every request against a schema; unknown methods are refused. No request names a
 *   file to read or write: `cwd` only selects the project, as the hook input's own cwd does.
 */

/** A wired engine is re-wired in the background once it is this old. */
export const ENGINE_TTL_MS = 60_000;
/** At most this many engines (one per distinct project configuration) stay open. */
export const ENGINE_MAX = 8;
/** A replaced engine is closed this long after, when no request can still be using it. */
const ENGINE_CLOSE_GRACE_MS = 10_000;
/** A connection without a whole request for this long is dropped. */
const CONNECTION_IDLE_MS = 10_000;
/** And any connection after this long. */
const CONNECTION_LIFETIME_MS = 60_000;
/** Requests one connection may have waiting for an answer. */
const MAX_QUEUED_FRAMES = 8;
const MAX_CONNECTIONS = 64;
/** How often the daemon checks that its lock and socket are still its own. */
const SELF_CHECK_MS = 30_000;
/** A lock younger than this whose holder does not answer yet is a daemon still starting. */
const LOCK_STARTUP_GRACE_MS = 10_000;

const AbsPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p) && !p.includes('\0'), 'an absolute path');
const Version = z.string().min(1).max(64);

const Envelope = z.strictObject({
  v: z.number().int(),
  id: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31),
  method: z.string().max(32),
  params: z.record(z.string(), z.unknown()).default({}),
});

const PARAMS = {
  ping: z.strictObject({}),
  status: z.strictObject({}),
  stop: z.strictObject({}),
  hook: z.strictObject({
    event: z.enum(SERVED_EVENTS),
    stdin: z.string().max(MAX_FRAME_BYTES),
    cwd: AbsPath,
    version: Version,
    /** `OORT_HOOK_TIMING=1` in the hook: answer with the event's timings too (numbers only). */
    timing: z.boolean().optional(),
  }),
  recall: z.strictObject({
    text: z.string().min(1).max(10_000),
    cwd: AbsPath,
    version: Version,
  }),
} satisfies Record<Method, z.ZodType>;

class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DaemonOptions {
  /** The Oort home this daemon serves; its socket and lock follow from it. */
  home: string;
  /** The environment wiring reads (keys, OORT_CLOUD_URL): the one the daemon started with. */
  env: Env;
  wire: WireFn;
  /** This CLI's version: a request from another version is refused (the hook runs in-process). */
  version: string;
  /** Exit after this long without a hook or recall request. */
  idleMs: number;
  /** Starts a detached drain (the Stop hook's, after a due consolidation). */
  spawnDrain: (cwd: string) => void;
  /** One line per lifecycle event; never a prompt, a memory or a key. */
  log: (line: string) => void;
  /** Where the daemon warms its first engine: the user's home directory (global scope). */
  warmCwd: string;
  now?: () => number;
  /** Tests: how often an idle cloud connection is refreshed, and for how long after a prompt. */
  keepWarm?: { everyMs: number; forMs: number };
}

/**
 * In cloud mode, the daemon keeps its Oort Cloud connection open while prompts are coming
 * (CON-101): opening one costs about 200 ms (DNS, TCP, TLS), as much as a third of a recall. The
 * pool closes a connection after KEEP_ALIVE_MS idle; until WARM_FOR_MS after the last prompt, an
 * idle connection is refreshed shortly before that with `GET /health` (no key, nothing read,
 * nothing metered). After that the daemon lets it close: the next prompt opens a new one.
 */
export const WARM_FOR_MS = 15 * 60_000;
const WARM_EVERY_MS = KEEP_ALIVE_MS - 20_000;

export class KeepWarm {
  private timer: NodeJS.Timeout | undefined;
  private until = 0;
  private url: string | undefined;
  private stopped = false;

  constructor(
    private readonly now: () => number,
    private readonly every = WARM_EVERY_MS,
    private readonly forMs = WARM_FOR_MS,
  ) {}

  /** A cloud engine is ready: open its connection now, then keep it open for a while. */
  start(w: Wired): void {
    if (!this.track(w)) return;
    void warmCloud(this.url as string).finally(() => this.schedule());
  }

  /** A prompt just used the connection: keep it open until WARM_FOR_MS from now. */
  touch(w: Wired): void {
    if (this.track(w)) this.schedule();
  }

  private track(w: Wired): boolean {
    if (this.stopped || w.mode !== 'cloud' || w.cloud === undefined) return false;
    this.url = w.cloud.url;
    this.until = this.now() + this.forMs;
    return true;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped || this.now() >= this.until) return;
    this.timer = setTimeout(() => {
      if (this.stopped || this.url === undefined) return;
      void warmCloud(this.url).finally(() => this.schedule());
    }, this.every);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

export interface Daemon {
  readonly socket: string;
  readonly pid: number;
  /** Resolves with the reason once the daemon has stopped and cleaned up. */
  readonly closed: Promise<string>;
  stop(reason: string): Promise<string>;
}

/**
 * Why `oort serve` cannot start; the message is printed as is. `tripsBreaker` false for "another
 * daemon has it" (the hooks should use that one), true for everything that will not fix itself.
 */
export class ServeRefusal extends Refusal {
  constructor(
    message: string,
    readonly tripsBreaker = true,
  ) {
    super(message);
  }
}

/** The store needs its schema migration, which only `oort doctor` (or any oort command) runs. */
export class MigrationRequired extends ServeRefusal {
  constructor() {
    super(
      'The store needs its schema migration first, and `oort serve` never migrates it: run `oort doctor` (or any oort command), then start it again, and restart any Oort MCP server started before the upgrade.',
    );
  }
}

const uid = currentUid;

/**
 * The socket directory may hold a socket: a real directory (never followed through a symlink) of
 * this user's that nobody else can write. Created 0700 when missing (its parent first, when that
 * is missing too); group or others' read access is removed, but only from a directory this lstat
 * just verified.
 */
export function checkSocketDir(dir: string, me = uid()): void {
  let state = inspectDir(dir, me);
  if (state === 'absent') {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    state = inspectDir(dir, me);
  }
  switch (state) {
    case 'ok':
      return;
    case 'readable-by-others':
      fs.chmodSync(dir, 0o700);
      return;
    case 'symlink':
      throw new ServeRefusal(
        `${shown(dir)} is a symlink; refusing to listen there. Point OORT_HOME at the real directory.`,
      );
    case 'foreign':
      throw new ServeRefusal(`${shown(dir)} belongs to another user; refusing to listen there.`);
    case 'writable-by-others':
      throw new ServeRefusal(
        `${shown(dir)} is writable by group or others; refusing to listen there. Run \`chmod 700 ${shown(dir)}\`.`,
      );
    default:
      throw new ServeRefusal(`${shown(dir)} is not a directory.`);
  }
}

/**
 * What sits at the socket path: nothing, or a socket of this user's (stale once the lock is ours).
 * Anything else is refused and left alone.
 */
export function checkSocketPath(socket: string, me = uid()): 'none' | 'stale' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(socket);
  } catch {
    return 'none';
  }
  if (me !== undefined && st.uid !== me) {
    throw new ServeRefusal(`${shown(socket)} belongs to another user; refusing to replace it.`);
  }
  if (!st.isSocket()) {
    throw new ServeRefusal(`${shown(socket)} exists and is not a socket; remove it first.`);
  }
  return 'stale';
}

function readPid(lock: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The daemon holding `lock`, when there is one: its pid file names a live process. */
export function lockHolder(lock: string): number | undefined {
  const pid = readPid(lock);
  return pid !== undefined && alive(pid) ? pid : undefined;
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Takes the single-instance lock: creates `lock` exclusively (0600, never through a symlink) with
 * this pid. A lock whose process is gone, or that is old and whose socket does not answer (a
 * reused pid), is stale and replaced. `answers` probes the socket.
 */
export async function acquireLock(
  lock: string,
  answers: () => Promise<boolean>,
  now = Date.now,
): Promise<void> {
  const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const st = fs.lstatSync(lock);
    if (!st.isFile()) throw new ServeRefusal(`${shown(lock)} is not a regular file; remove it.`);
    const holder = lockHolder(lock);
    if (holder !== undefined) {
      if (await answers()) {
        throw new ServeRefusal(`The daemon is already running (pid ${holder}).`, false);
      }
      if (now() - st.mtimeMs < LOCK_STARTUP_GRACE_MS) {
        throw new ServeRefusal(`The daemon is starting (pid ${holder}).`, false);
      }
    }
    // Stale: the holder is gone (or a reused pid that does not answer). Replace it once, and only
    // the very file judged stale: another starter may have replaced it since.
    try {
      const again = fs.lstatSync(lock);
      if (again.ino === st.ino && again.mtimeMs === st.mtimeMs) fs.unlinkSync(lock);
    } catch {
      // Removed by another starter; the exclusive create below decides.
    }
  }
  throw new ServeRefusal('The daemon is starting in another process.', false);
}

/** Removes `file` when it still holds what we put there (our pid, or our socket's inode). */
function unlinkIfOurs(file: string, ours: (st: fs.Stats) => boolean): void {
  try {
    if (ours(fs.lstatSync(file))) fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

interface Entry {
  w: Wired;
  at: number;
  refreshing?: Promise<void>;
}

/**
 * Wired engines keyed by everything wiring reads for a cwd: the resolved config, the project and
 * its stated privacy, and the store mode. Two cwds in one repository share an engine.
 */
class Engines {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private closed = false;

  constructor(
    private readonly opts: Pick<DaemonOptions, 'env' | 'wire'>,
    private readonly now: () => number,
  ) {}

  private keyFor(cwd: string): string {
    const config = resolveConfig(cwd, this.opts.env);
    const { sources: _s, ...settings } = config;
    const project = resolveProject(cwd, config.home);
    return JSON.stringify([
      settings,
      project.projectId ?? null,
      project.untrustedId !== undefined,
      statedProjectPrivacy(cwd, config) ?? null,
      readCloudSettings(config.home).store,
      // Stored keys and the cloud identity: logging out, `oort keys set|rm` or `oort cloud use`
      // changes one of these, and the next request wires afresh (not within ENGINE_TTL_MS).
      ...this.credentialStamps(config.home),
    ]);
  }

  /** Size and mtime of each file keys or the cloud identity come from (cheap stats). */
  private credentialStamps(home: string): string[] {
    const userHome = this.opts.env['HOME'] || os.homedir();
    return [
      path.join(home, 'credentials.json'),
      path.join(home, 'cloud.json'),
      path.join(userHome, 'Library', 'Keychains', 'login.keychain-db'),
    ].map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.size}:${st.mtimeMs}`;
      } catch {
        return '-';
      }
    });
  }

  private wireFor(cwd: string): Promise<Wired> {
    // Both served events wire as UserPromptSubmit does (embed and rerank): SessionStart ignores them.
    // A long-lived process: Oort Cloud requests reuse the connection (CON-101).
    return this.opts.wire(cwd, {
      ...hookWireOptions('UserPromptSubmit', this.opts.env),
      cloudKeepAlive: true,
    });
  }

  /** The engine for `cwd`, and how long wiring took (0 when it was warm). */
  async get(cwd: string): Promise<{ w: Wired; wireMs: number }> {
    if (this.closed) throw new RequestError('shutting-down', 'the daemon is stopping');
    const key = this.keyFor(cwd);
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit); // most recently used last
      if (this.now() - hit.at > ENGINE_TTL_MS && hit.refreshing === undefined) {
        hit.refreshing = this.refresh(key, hit, cwd);
      }
      return { w: hit.w, wireMs: 0 };
    }
    let p = this.pending.get(key);
    const t0 = performance.now();
    if (p === undefined) {
      p = this.wireFor(cwd).then((w) => {
        const entry: Entry = { w, at: this.now() };
        if (this.closed) {
          void w.close();
          throw new RequestError('shutting-down', 'the daemon is stopping');
        }
        this.entries.set(key, entry);
        this.evict();
        return entry;
      });
      this.pending.set(key, p);
      void p.catch(() => {}).finally(() => this.pending.delete(key));
    }
    const entry = await p;
    return { w: entry.w, wireMs: performance.now() - t0 };
  }

  /** Re-wires in the background; on failure (say, the store now needs a migration) drops it. */
  private async refresh(key: string, entry: Entry, cwd: string): Promise<void> {
    const old = entry.w;
    try {
      const w = await this.wireFor(cwd);
      if (this.closed || this.entries.get(key) !== entry) {
        void w.close();
        return;
      }
      entry.w = w;
      entry.at = this.now();
    } catch {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    } finally {
      entry.refreshing = undefined;
    }
    this.closeLater(old);
  }

  private evict(): void {
    while (this.entries.size > ENGINE_MAX) {
      const [oldest] = this.entries.keys();
      if (oldest === undefined) return;
      const e = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (e !== undefined) this.closeLater(e.w);
    }
  }

  private closeLater(w: Wired): void {
    setTimeout(() => void w.close().catch(() => {}), ENGINE_CLOSE_GRACE_MS).unref();
  }

  get size(): number {
    return this.entries.size;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(all.map((e) => e.w.close()));
  }
}

/**
 * Starts the daemon: checks the socket's directory, takes the lock, wires and warms the first
 * engine (refusing, with nothing left behind, when the store needs a migration or the config is
 * invalid), then listens. Throws `ServeRefusal` for every reason it will not start.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const now = opts.now ?? Date.now;
  const socket = socketPathFor(opts.home, opts.env);
  const lock = lockPathFor(socket);
  checkSocketDir(path.dirname(socket));
  const probe = async (): Promise<boolean> => {
    const { callDaemon } = await import('./serve-client.js');
    const r = await callDaemon(socket, 'ping', {}, { budgetMs: 500, connectTimeoutMs: 200 });
    return r.ok;
  };
  await acquireLock(lock, probe, now);
  const ownsLock = (st: fs.Stats): boolean => st.isFile() && readPid(lock) === process.pid;

  const engines = new Engines(opts, now);
  const warm = new KeepWarm(now, opts.keepWarm?.everyMs, opts.keepWarm?.forMs);
  let firstEngine: Wired;
  try {
    const first = await engines.get(opts.warmCwd);
    firstEngine = first.w;
    // Local models load lazily; one query embedding now keeps the first prompt fast. A vendor
    // embedder is never called here (that would bill an embedding nobody asked for).
    if (first.w.config.embed.provider === LOCAL_PROVIDER && first.w.embed !== undefined) {
      await first.w.embed.embed(['oort serve'], 'query').catch(() => {});
    }
  } catch (e) {
    await engines.closeAll();
    unlinkIfOurs(lock, ownsLock);
    if (e instanceof StoreMigrationRequiredError) throw new MigrationRequired();
    if (isBusy(e)) throw new ServeRefusal('the store is locked by another process; try again.');
    throw new ServeRefusal(
      `cannot open the store: ${shown(e instanceof Error ? e.message : String(e))}`,
    );
  }

  const startedAt = now();
  let lastActive = startedAt;
  let served = 0;
  let stopping: Promise<string> | undefined;
  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((r) => (resolveClosed = r));
  const connections = new Set<net.Socket>();
  let socketIno: number | undefined;

  let idleTimer: NodeJS.Timeout | undefined;
  const touch = (): void => {
    lastActive = now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop('idle'), opts.idleMs);
  };

  const server = net.createServer({ allowHalfOpen: false });
  server.maxConnections = MAX_CONNECTIONS;

  const handle = async (frame: unknown): Promise<Record<string, unknown>> => {
    const env = Envelope.safeParse(frame);
    if (!env.success) throw new RequestError('bad-request', 'not a request');
    if (env.data.v !== PROTOCOL_VERSION) {
      throw new RequestError('protocol', `protocol ${PROTOCOL_VERSION} only`);
    }
    const method = env.data.method;
    if (!(METHODS as readonly string[]).includes(method)) {
      throw new RequestError('unknown-method', 'unknown method');
    }
    const parsed = PARAMS[method as Method].safeParse(env.data.params);
    if (!parsed.success) throw new RequestError('bad-request', `invalid params for ${method}`);
    if (stopping !== undefined) throw new RequestError('shutting-down', 'the daemon is stopping');
    switch (method as Method) {
      case 'ping':
        return { version: opts.version, pid: process.pid, protocol: PROTOCOL_VERSION };
      case 'status':
        return {
          version: opts.version,
          pid: process.pid,
          protocol: PROTOCOL_VERSION,
          startedAt: new Date(startedAt).toISOString(),
          uptimeMs: now() - startedAt,
          idleMs: now() - lastActive,
          idleExitMs: opts.idleMs,
          served,
          engines: engines.size,
        };
      case 'stop':
        setImmediate(() => void stop('requested'));
        return { stopping: true };
      case 'hook': {
        const p = parsed.data as z.infer<(typeof PARAMS)['hook']>;
        if (p.version !== opts.version) {
          // A hook from a newer oort (after an update): answer, then exit, so the hook can start
          // a daemon of its own version. Only newer: an older hook (another settings file, a
          // stale copy) never stops a newer daemon, so two versions cannot take turns. Only the
          // hook method: the hooks' copy is the one whose daemon this is.
          if (isNewerVersion(p.version, opts.version)) {
            opts.log(`a hook from oort ${shown(p.version)} asked; exiting so it can start its own`);
            setImmediate(() => void stop(`replaced by oort ${shown(p.version)}`));
            throw new RequestError(
              'restarting',
              `this daemon is oort ${opts.version}; it exits for oort ${shown(p.version)}`,
            );
          }
          throw new RequestError('version-mismatch', `this daemon is oort ${opts.version}`);
        }
        touch();
        const fromInput = inputCwd(p.stdin);
        const cwd = fromInput !== undefined && path.isAbsolute(fromInput) ? fromInput : p.cwd;
        const { w, wireMs } = await engineFor(cwd);
        const out = await runWiredHook(p.event as HookEvent, p.stdin, w, {
          wireMs,
          daemon: true,
          err: () => {},
          spawnDrain: (home) => opts.spawnDrain(home),
        });
        served++;
        warm.touch(w);
        return {
          stdout: out.stdout,
          ...(p.timing === true && out.timings !== undefined && { timings: out.timings }),
        };
      }
      case 'recall': {
        const p = parsed.data as z.infer<(typeof PARAMS)['recall']>;
        if (p.version !== opts.version) {
          throw new RequestError('version-mismatch', `this daemon is oort ${opts.version}`);
        }
        touch();
        const { w } = await engineFor(p.cwd);
        if (w.mode === 'cloud') throw new RequestError('bad-request', 'recall is local only');
        const budget = Math.min(w.config.recall.budgetChars, 10_000);
        const at = new Date(now());
        const r = await recall(
          { text: p.text, scope: filterFor(w.scope), budgetChars: budget, home: w.agent.home },
          {
            store: w.store,
            config: w.config,
            now: at,
            ...(w.embed !== undefined && { embed: w.embed }),
            ...(w.rerank !== undefined &&
              w.config.rerank.provider !== LOCAL_PROVIDER && { rerank: w.rerank }),
          },
        );
        served++;
        return {
          text: formatForInjection(r, budget, at),
          ids: r.memories.map((m) => m.id),
          degraded: r.degraded ?? [],
        };
      }
    }
  };

  const engineFor = async (cwd: string): Promise<{ w: Wired; wireMs: number }> => {
    try {
      return await engines.get(cwd);
    } catch (e) {
      if (e instanceof RequestError) throw e;
      if (e instanceof StoreMigrationRequiredError) {
        throw new RequestError('migration-required', 'the store needs its schema migration');
      }
      if (isBusy(e)) throw new RequestError('busy', 'the store is locked');
      throw new RequestError('internal', e instanceof Error ? e.name : 'error');
    }
  };

  server.on('connection', (conn) => {
    connections.add(conn);
    // An absolute lifetime, and an idle limit that only a whole request resets: a client that
    // trickles bytes, or holds the connection open, is dropped all the same.
    const lifetime = setTimeout(() => conn.destroy(), CONNECTION_LIFETIME_MS);
    let idle = setTimeout(() => conn.destroy(), CONNECTION_IDLE_MS);
    const rearm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => conn.destroy(), CONNECTION_IDLE_MS);
    };
    conn.on('close', () => {
      clearTimeout(lifetime);
      clearTimeout(idle);
      connections.delete(conn);
    });
    conn.on('error', () => conn.destroy());
    const decoder = new FrameDecoder();
    let queue = Promise.resolve();
    let queued = 0;
    conn.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        conn.end(reply(null, { code: 'bad-frame', message: 'bad frame' }));
        return;
      }
      if (decoder.buffered > MAX_FRAME_BYTES + 4) {
        conn.destroy();
        return;
      }
      for (const frame of frames) {
        if (queued >= MAX_QUEUED_FRAMES) {
          conn.end(reply(null, { code: 'busy', message: 'too many requests on one connection' }));
          return;
        }
        queued++;
        rearm();
        const id =
          typeof frame === 'object' &&
          frame !== null &&
          Number.isSafeInteger((frame as { id?: unknown }).id)
            ? (frame as { id: number }).id
            : null;
        queue = queue.then(async () => {
          let out: Buffer;
          try {
            out = reply(id, undefined, await handle(frame));
          } catch (e) {
            out =
              e instanceof RequestError
                ? reply(id, { code: e.code, message: e.message })
                : reply(id, { code: 'internal', message: 'internal error' });
          }
          queued--;
          if (!conn.destroyed) {
            conn.write(out);
            rearm();
          }
        });
      }
    });
  });

  // Listen with umask 177 so the socket is born 0600, then make sure of it.
  const previous = process.umask(0o177);
  try {
    // The lock is ours, so a socket left at the path is stale, unless something answers on it
    // (a daemon whose lock was removed by hand): then it is refused, not replaced.
    if (checkSocketPath(socket) === 'stale') {
      const st = fs.lstatSync(socket);
      const live = await probe();
      if (live) throw new ServeRefusal(`a daemon already answers on ${shown(socket)}.`, false);
      const again = fs.lstatSync(socket);
      if (again.ino !== st.ino) throw new ServeRefusal(`${shown(socket)} changed; try again.`);
      fs.unlinkSync(socket);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: socket, readableAll: false, writableAll: false }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    process.umask(previous);
    await engines.closeAll();
    unlinkIfOurs(lock, ownsLock);
    if (e instanceof ServeRefusal) throw e;
    throw new ServeRefusal(
      `cannot listen on ${shown(socket)} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
  process.umask(previous);
  fs.chmodSync(socket, 0o600);
  socketIno = fs.lstatSync(socket).ino;
  const ownsSocket = (st: fs.Stats): boolean => st.isSocket() && st.ino === socketIno;

  // Another starter that wrongly judged our lock stale replaced it (or the socket): it wins.
  const selfCheck = setInterval(() => {
    let mine = false;
    try {
      mine = ownsLock(fs.lstatSync(lock)) && ownsSocket(fs.lstatSync(socket));
    } catch {
      mine = false;
    }
    if (!mine) void stop('superseded');
  }, SELF_CHECK_MS);
  selfCheck.unref();

  const stop = (reason: string): Promise<string> => {
    if (stopping !== undefined) return stopping;
    stopping = (async () => {
      clearTimeout(idleTimer);
      clearInterval(selfCheck);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Requests in flight get a moment to answer; then their connections are dropped.
        setTimeout(() => {
          for (const c of connections) c.destroy();
        }, 250).unref();
      });
      warm.stop();
      await engines.closeAll();
      await closeCloudPool();
      unlinkIfOurs(socket, ownsSocket);
      unlinkIfOurs(lock, ownsLock);
      opts.log(`stopped (${reason})`);
      resolveClosed(reason);
      return reason;
    })();
    return stopping;
  };

  touch();
  // Listening: open the Oort Cloud connection now, so the first prompt finds it warm.
  warm.start(firstEngine);
  opts.log(`listening on ${shown(socket)}, pid ${process.pid}, oort ${shown(opts.version)}`);
  return { socket, pid: process.pid, closed, stop };
}

function reply(
  id: number | null,
  error?: { code: ErrorCode; message: string },
  result?: Record<string, unknown>,
): Buffer {
  return encodeFrame(
    error !== undefined
      ? { v: PROTOCOL_VERSION, id, ok: false, error }
      : { v: PROTOCOL_VERSION, id, ok: true, result: result ?? {} },
  );
}
