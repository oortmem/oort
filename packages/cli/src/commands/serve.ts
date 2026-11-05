import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION, resolveConfig, resolveHome } from '@oortmem/core';
import { binPath } from '../io.js';
import { callDaemon, spawnDaemon, socketTrust } from '../serve-client.js';
import { lockPathFor, socketPathFor } from '../serve-protocol.js';
import { uiFor } from '../ui.js';
import { Refusal, echo, shown, tilde, type Ctx } from '../util.js';

export interface ServeOptions {
  detach?: boolean;
  idle?: string;
  json?: boolean;
}

const MAX_IDLE_MS = 24 * 60 * 60 * 1000;
/** How long `--detach` and `stop` wait for the daemon to come up or go away. */
const WAIT_MS = 5000;

/** `30m`, `45s`, `500ms`, `2h`, or a bare number of minutes, as milliseconds. */
export function parseIdle(text: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  const ms = m === null ? NaN : Number(m[1]) * unit[(m[2] ?? 'm') as keyof typeof unit];
  if (!Number.isFinite(ms) || ms < 100 || ms > MAX_IDLE_MS) {
    throw new Refusal(`--idle ${echo(text)} is not a duration from 100ms to 24h (30m, 45s, 2h).`);
  }
  return ms;
}

/** A configured duration as written: 2h, 30m, 45s, 500ms. */
function minutes(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** An elapsed time, compact: 45s, 12m, 3h 5m. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)}h${m > 0 ? ` ${m}m` : ''}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `oort serve [start|status|stop] [--detach] [--idle <duration>] [--json]` (CON-18): the local
 * daemon the hooks prefer. `start` (the default) runs it in the foreground until SIGTERM, SIGINT,
 * `oort serve stop` or the idle timeout; `--detach` starts it in the background and returns.
 */
export async function serveCommand(
  action: string | undefined,
  opts: ServeOptions,
  ctx: Ctx,
): Promise<number> {
  const { io } = ctx;
  const home = resolveHome(io.env);
  const socket = socketPathFor(home);
  const userHome = io.env['HOME'] || os.homedir();
  const show = (p: string): string => shown(tilde(p, userHome));
  const ui = uiFor(io);
  switch (action ?? 'start') {
    case 'start':
      break;
    case 'status':
      return status();
    case 'stop':
      return stop();
    default:
      throw new Refusal(`unknown action ${echo(action ?? '')}; expected start, status or stop.`);
  }

  if (process.platform === 'win32') {
    throw new Refusal(
      'oort serve needs Unix sockets and does not run on Windows yet; the hooks run in-process.',
    );
  }
  // The home config only: a repository's oort.config.json does not run daemons on this machine.
  const config = resolveConfig(io.cwd, io.env, { projectConfig: false });
  const idleMs = opts.idle !== undefined ? parseIdle(opts.idle) : config.serve.idleMinutes * 60_000;

  if (opts.detach === true) {
    const running = await callDaemon(socket, 'ping', {}, { budgetMs: 1000 });
    if (running.ok) {
      io.out(
        `${ui.ok(`oort serve is already running (pid ${shown(running.result['pid'])}, ${show(socket)}).`)}\n`,
      );
      return 0;
    }
    const pid = spawnDaemon(
      fs.realpathSync(binPath()),
      home,
      io.env,
      opts.idle !== undefined ? ['--idle', opts.idle] : [],
    );
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await sleep(100);
      const r = await callDaemon(socket, 'ping', {}, { budgetMs: 500 });
      if (r.ok) {
        io.out(ui.header('serve', 'detached'));
        io.out(
          ui.kv([
            ['state', ui.success('running')],
            ['pid', shown(r.result['pid'])],
            ['socket', show(socket)],
            ['idle exit', minutes(idleMs)],
            ['log', show(path.join(home, 'logs', 'serve.log'))],
          ]),
        );
        return 0;
      }
    }
    io.err(
      `oort: oort serve did not start${pid === undefined ? '' : ` (pid ${pid})`}; see ${show(path.join(home, 'logs', 'serve.log'))}.\n`,
    );
    return 1;
  }

  // The daemon module (and through it the engine) loads only for a foreground start.
  const { startDaemon } = await import('../serve-daemon.js');
  const stamp = (): string => new Date().toISOString();
  io.out(ui.header('serve', show(socket), `pid ${process.pid}`, `idle exit ${minutes(idleMs)}`));
  const daemon = await startDaemon({
    home,
    env: io.env,
    wire: ctx.wire,
    version: VERSION,
    idleMs,
    spawnDrain: (cwd) => io.spawnDrain(cwd),
    log: (line) => io.out(`${ui.dim(stamp())} ${line}\n`),
    warmCwd: userHome,
  });
  const onSignal = (signal: NodeJS.Signals): void => void daemon.stop(signal);
  const onCrash = (e: unknown): void => {
    io.err(`oort serve: unexpected ${e instanceof Error ? e.name : 'error'}; stopping.\n`);
    process.exitCode = 1;
    void daemon.stop('crash');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('uncaughtException', onCrash);
  try {
    await daemon.closed;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('uncaughtException', onCrash);
  }
  return process.exitCode === 1 ? 1 : 0;

  async function status(): Promise<number> {
    const r = await callDaemon(socket, 'status', {}, { budgetMs: 1000 });
    const holder = lockHolderPid();
    if (opts.json === true) {
      io.out(
        `${JSON.stringify(
          r.ok
            ? { running: true, socket, ...r.result }
            : { running: false, socket, ...(holder !== undefined && { unresponsivePid: holder }) },
          null,
          2,
        )}\n`,
      );
      return r.ok ? 0 : 1;
    }
    io.out(ui.header('serve', 'status'));
    if (!r.ok) {
      io.out(
        ui.kv([
          [
            'state',
            holder !== undefined
              ? ui.warning(`not answering (pid ${holder} holds the lock)`)
              : ui.dim('not running'),
          ],
          ['socket', show(socket)],
          ['hooks', 'run in-process'],
        ]),
      );
      io.out(`${ui.dim('start it with: oort serve --detach')}\n`);
      return 1;
    }
    const v = r.result;
    const version = shown(v['version']);
    io.out(
      ui.kv([
        ['state', ui.success('running')],
        ['pid', shown(v['pid'])],
        [
          'version',
          version === VERSION ? version : ui.warning(`${version} (this is oort ${VERSION})`),
        ],
        ['socket', show(socket)],
        ['uptime', elapsed(Number(v['uptimeMs']))],
        ['served', shown(v['served'])],
        [
          'idle exit',
          `after ${minutes(Number(v['idleExitMs']))} without a request (idle ${elapsed(Number(v['idleMs']))})`,
        ],
      ]),
    );
    return 0;
  }

  function lockHolderPid(): number | undefined {
    try {
      const pid = Number(fs.readFileSync(lockPathFor(socket), 'utf8').trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
      process.kill(pid, 0);
      return pid;
    } catch {
      return undefined;
    }
  }

  async function stop(): Promise<number> {
    const before = await callDaemon(socket, 'ping', {}, { budgetMs: 1000 });
    if (!before.ok) {
      const holder = lockHolderPid();
      if (holder !== undefined) {
        io.err(
          `oort: pid ${holder} holds ${show(lockPathFor(socket))} but does not answer; stop it with \`kill ${holder}\`.\n`,
        );
        return 1;
      }
      // Nobody holds the lock: a socket or pid file left behind is stale; remove ours.
      let removed = false;
      if (before.reason === 'refused' && socketTrust(socket) === 'trusted') {
        fs.rmSync(socket, { force: true });
        removed = true;
      }
      const lock = lockPathFor(socket);
      if (fs.existsSync(lock) && fs.lstatSync(lock).isFile()) {
        fs.rmSync(lock, { force: true });
        removed = true;
      }
      io.out(
        `${ui.ok(`oort serve is not running${removed ? '; removed what a stopped daemon left behind' : ''}.`)}\n`,
      );
      return 0;
    }
    const pid = shown(before.result['pid']);
    await callDaemon(socket, 'stop', {}, { budgetMs: 1000 });
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      if (socketTrust(socket) === 'absent') {
        io.out(`${ui.ok(`Stopped oort serve (pid ${pid}).`)}\n`);
        return 0;
      }
      await sleep(50);
    }
    io.err(`oort: oort serve (pid ${pid}) did not stop within ${WAIT_MS / 1000}s.\n`);
    return 1;
  }
}
