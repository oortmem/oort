import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION, resolveConfig, resolveHome } from '@oortmem/core';
import { binPath } from '../io.js';
import {
  SKIP_AFTER_REFUSAL_MS,
  callDaemon,
  clearSkip,
  readSkip,
  removeLeftovers,
  socketTrust,
  spawnDaemon,
  writeSkip,
} from '../serve-client.js';
import { lockPathFor, socketPathFor } from '../serve-protocol.js';
import { emit, jsonMode } from '../output.js';
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

const NEEDS_DOCTOR =
  'The daemon did not start: the store needs its schema migration (after an upgrade), and `oort serve` never migrates it. Run `oort doctor`, then `oort serve --detach`.';

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
  const socket = socketPathFor(home, io.env);
  const userHome = io.env['HOME'] || os.homedir();
  const show = (p: string): string => shown(tilde(p, userHome));
  const ui = uiFor(io);
  // Checking on or stopping the daemon by hand closes the hooks' circuit breaker: the next prompt
  // tries the daemon again. A start closes it once the daemon listens.
  // Read first: status explains a start that was refused for a pending migration.
  const priorSkip = readSkip(home);
  if (action === 'status' || action === 'stop') clearSkip(home);
  switch (action ?? 'start') {
    case 'start':
      break;
    case 'status':
      return status();
    case 'stop':
      return stop();
    default:
      throw new Refusal(`Unknown action ${echo(action ?? '')}; expected start, status or stop.`);
  }

  if (process.platform === 'win32') {
    throw new Refusal(
      'The daemon needs Unix sockets and does not run on Windows yet; the hooks run in-process.',
    );
  }
  // The home config only: a repository's oort.config.json does not run daemons on this machine.
  if (opts.detach !== true && opts.json === true) {
    throw new Refusal(
      '`oort serve` in the foreground runs until stopped and prints a log, not JSON; --json is for `oort serve --detach`, `status` and `stop`.',
      { fix: 'oort serve --detach --json' },
    );
  }
  const config = resolveConfig(io.cwd, io.env, { projectConfig: false });
  const idleMs = opts.idle !== undefined ? parseIdle(opts.idle) : config.serve.idleMinutes * 60_000;
  const logFile = path.join(home, 'logs', 'serve.log');
  const detached = (pid: unknown, alreadyRunning: boolean): number => {
    if (jsonMode(ctx)) {
      emit(ctx, { running: true, alreadyRunning, pid, socket, idleExitMs: idleMs, log: logFile });
    }
    return 0;
  };

  if (opts.detach === true) {
    const running = await callDaemon(socket, 'ping', {}, { budgetMs: 1000 });
    if (running.ok) {
      io.out(
        `${ui.ok(`oort serve is already running (pid ${shown(running.result['pid'])}, ${show(socket)}).`)}\n`,
      );
      return detached(running.result['pid'], true);
    }
    clearSkip(home); // so a refusal written below is this start's, not an older one
    const pid = spawnDaemon(
      fs.realpathSync(binPath()),
      home,
      io.env,
      opts.idle !== undefined ? ['--idle', opts.idle] : [],
    );
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await sleep(100);
      if (readSkip(home)?.reason === 'migration') {
        throw new Refusal(NEEDS_DOCTOR, { code: 'internal', fix: 'oort doctor' });
      }
      const r = await callDaemon(socket, 'ping', {}, { budgetMs: 500 });
      if (r.ok && r.result['pid'] !== pid) {
        // Another daemon answers: one that was running all along (too busy to answer the first
        // ping in time) or that won a race with ours. Ours finds the lock taken and exits.
        io.out(
          `${ui.ok(`oort serve is already running (pid ${shown(r.result['pid'])}, ${show(socket)}).`)}\n`,
        );
        return detached(r.result['pid'], true);
      }
      if (r.ok) {
        io.out(ui.header('serve', 'detached'));
        io.out(
          ui.kv([
            ['state', ui.success('running')],
            ['pid', shown(r.result['pid'])],
            ['socket', show(socket)],
            ['idle exit', minutes(idleMs)],
            ['log', show(logFile)],
          ]),
        );
        return detached(r.result['pid'], false);
      }
    }
    throw new Refusal(
      `the daemon did not start${pid === undefined ? '' : ` (pid ${pid})`}; see ${show(logFile)}.`,
      { code: 'internal' },
    );
  }

  // The daemon module (and through it the engine) loads only for a foreground start.
  const { startDaemon, ServeRefusal, MigrationRequired } = await import('../serve-daemon.js');
  const stamp = (): string => new Date().toISOString();
  io.out(ui.header('serve', show(socket), `pid ${process.pid}`, `idle exit ${minutes(idleMs)}`));
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      home,
      env: io.env,
      wire: ctx.wire,
      version: VERSION,
      idleMs,
      spawnDrain: (cwd) => io.spawnDrain(cwd),
      log: (line) => io.out(`${ui.dim(stamp())} ${line}\n`),
      warmCwd: userHome,
    });
  } catch (e) {
    // A daemon that will not start (a pending migration, a bad directory) opens the breaker, so
    // autostart does not try again on every session; "another one runs" does not.
    if (!(e instanceof ServeRefusal) || e.tripsBreaker) {
      writeSkip(
        home,
        Date.now() + SKIP_AFTER_REFUSAL_MS,
        e instanceof MigrationRequired ? 'migration' : 'refused',
      );
    }
    throw e;
  }
  clearSkip(home);
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
    // Only a live marker: any oort command migrates the store, so an expired one may be stale.
    const needsMigration = priorSkip?.reason === 'migration' && priorSkip.until > Date.now();
    if (jsonMode(ctx)) {
      // Only known fields, copied by name: nothing the socket sends can add or override one.
      const fields = [
        'version',
        'pid',
        'protocol',
        'startedAt',
        'uptimeMs',
        'idleMs',
        'idleExitMs',
        'served',
        'engines',
      ];
      const known = r.ok
        ? Object.fromEntries(
            fields
              .filter((f) => ['string', 'number'].includes(typeof r.result[f]))
              .map((f) => [f, r.result[f]]),
          )
        : {};
      emit(
        ctx,
        r.ok
          ? { ...known, running: true, socket }
          : {
              ...(holder !== undefined && { unresponsivePid: holder }),
              ...(needsMigration && { needsMigration: true }),
              running: false,
              socket,
            },
      );
      // Exit 0 only when the daemon answers, so `oort serve status || oort serve --detach` works;
      // the JSON reports the state either way.
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
          ...(needsMigration
            ? [
                ['last start', ui.warning('refused: the store needs its schema migration')] as [
                  string,
                  string,
                ],
              ]
            : []),
          ['socket', show(socket)],
          ['hooks', 'run in-process'],
        ]),
      );
      io.out(
        `${ui.dim(needsMigration ? 'run oort doctor (it migrates the store), then: oort serve --detach' : 'start it with: oort serve --detach')}\n`,
      );
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
        throw new Refusal(
          `pid ${holder} holds ${show(lockPathFor(socket))} but does not answer; check what it is with \`ps -p ${holder}\` before stopping it.`,
          { code: 'internal' },
        );
      }
      // Nobody holds the lock: a socket nothing answers on, or a pid file whose process is gone.
      const removed = removeLeftovers(socket, lockPathFor(socket), before.reason === 'refused');
      io.out(
        `${ui.ok(`oort serve is not running${removed ? '; removed what a stopped daemon left behind' : ''}.`)}\n`,
      );
      if (jsonMode(ctx)) {
        emit(ctx, { stopped: false, wasRunning: false, pid: null, removedLeftovers: removed });
      }
      return 0;
    }
    const pid = shown(before.result['pid']);
    await callDaemon(socket, 'stop', {}, { budgetMs: 1000 });
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      if (socketTrust(socket) === 'absent') {
        io.out(`${ui.ok(`Stopped oort serve (pid ${pid}).`)}\n`);
        if (jsonMode(ctx)) {
          emit(ctx, {
            stopped: true,
            wasRunning: true,
            pid: before.result['pid'],
            removedLeftovers: false,
          });
        }
        return 0;
      }
      await sleep(50);
    }
    throw new Refusal(`the daemon (pid ${pid}) did not stop within ${WAIT_MS / 1000}s.`, {
      code: 'internal',
    });
  }
}
