import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TG } from '@oortmem/core/store-conformance';
import type { Memory } from '@oortmem/core';
import { downgradeSqliteStore, openSqliteStore, sqliteSchemaVersion } from '@oortmem/store-sqlite';
import { memory, tmpdir } from '../test/helpers.js';
import { callDaemon } from './serve-client.js';
import { checkSocketPath } from './serve-daemon.js';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  cliVersion,
  encodeFrame,
  lockPathFor,
  socketPathFor,
} from './serve-protocol.js';

/** The built bin: the daemon and the hooks run as real processes here, so build first. */
const BIN = path.join(import.meta.dirname, '..', 'dist', 'main.js');

interface Sandbox {
  root: string;
  home: string;
  oortHome: string;
  cwd: string;
  socket: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = tmpdir('oort-serve-');
  const home = path.join(root, 'home');
  const oortHome = path.join(home, '.oort');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return {
    root,
    home,
    oortHome,
    cwd,
    socket: socketPathFor(oortHome),
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      OORT_HOME: oortHome,
      OORT_NO_KEYCHAIN: '1',
    },
  };
}

async function seed(s: Sandbox, memories: Memory[]): Promise<void> {
  const store = await openSqliteStore({
    path: path.join(s.oortHome, 'oort.sqlite'),
    coldDir: path.join(s.oortHome, 'cold'),
    dimension: 512,
    log: () => {},
  });
  await store.upsertMany(TG, memories);
  await store.close();
}

function oort(
  s: Sandbox,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
) {
  return execa(BIN, args, {
    cwd: s.cwd,
    env: opts.env ?? s.env,
    extendEnv: false,
    reject: false,
    timeout: 20_000,
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: 'ignore' as const }),
  });
}

const children: ChildProcess[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  await Promise.all(servers.splice(0).map((srv) => new Promise((r) => srv.close(r))));
});

beforeAll(() => {
  if (!fs.existsSync(BIN)) throw new Error(`${BIN} is missing: run \`pnpm build\` first`);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits until `ok()` holds, polling; fails the test after `ms`. */
async function until(ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(50);
  }
  throw new Error('timed out waiting');
}

/** `oort serve` in the foreground, as a child; resolves once it answers a ping. */
async function startServe(
  s: Sandbox,
  args: string[] = [],
): Promise<{ child: ChildProcess; output: () => string; exited: Promise<number | null> }> {
  const child = spawn(BIN, ['serve', ...args], {
    cwd: s.cwd,
    env: s.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  await until(async () => (await callDaemon(s.socket, 'ping', {}, { budgetMs: 300 })).ok);
  return { child, output: () => output, exited };
}

const PROMPT = 'which port does the auth service listen on?';
const promptInput = (s: Sandbox): string =>
  JSON.stringify({
    session_id: 's-serve',
    cwd: s.cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt: PROMPT,
  });

function hookLog(s: Sandbox): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The newest UserPromptSubmit log line, and whether the daemon wrote it. */
function lastPrompt(s: Sandbox): { outcome: unknown; daemon: boolean } {
  const e = hookLog(s)
    .filter((l) => l['event'] === 'UserPromptSubmit')
    .at(-1);
  return {
    outcome: e?.['outcome'],
    daemon: (e?.['counts'] as Record<string, number> | undefined)?.['daemon'] === 1,
  };
}

/** A sandbox with one memory, and the context the in-process hook injects for PROMPT. */
async function seededWithBaseline(): Promise<{ s: Sandbox; baseline: string }> {
  const s = sandbox();
  await seed(s, [memory({ embedding: new Int8Array(512).fill(3) })]);
  const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('port 5582');
  expect(lastPrompt(s).daemon).toBe(false);
  return { s, baseline: r.stdout };
}

/** A fake daemon in this process: `onFrame` decides what (if anything) goes back. */
async function fakeDaemon(
  s: Sandbox,
  onFrame: (frame: { id: number }, conn: net.Socket) => void,
): Promise<void> {
  fs.mkdirSync(path.dirname(s.socket), { recursive: true, mode: 0o700 });
  const server = net.createServer((conn) => {
    const decoder = new FrameDecoder();
    conn.on('error', () => {});
    conn.on('data', (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) onFrame(f as { id: number }, conn);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(s.socket, r));
}

/** A raw request on the socket, to see exactly what the daemon answers. */
async function raw(socket: string, frame: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    const decoder = new FrameDecoder();
    conn.on('connect', () => conn.write(encodeFrame(frame)));
    conn.on('data', (c: Buffer) => {
      const [f] = decoder.push(c);
      if (f !== undefined) {
        conn.destroy();
        resolve(f as Record<string, unknown>);
      }
    });
    conn.on('error', reject);
  });
}

describe('oort serve', () => {
  it('serve.hooks-use-the-daemon-and-inject-what-the-in-process-hook-does', async () => {
    const { s, baseline } = await seededWithBaseline();
    const session = JSON.stringify({ session_id: 's-serve', cwd: s.cwd, source: 'startup' });
    const sessionBaseline = (await oort(s, ['hook', 'SessionStart'], { input: session })).stdout;

    const serve = await startServe(s);
    const r = await oort(s, ['hook', 'UserPromptSubmit'], {
      input: promptInput(s),
      env: { ...s.env, OORT_HOOK_TIMING: '1' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(baseline);
    expect(r.stderr).toMatch(/^oort-hook UserPromptSubmit via=daemon [\d.]+ms$/m);
    expect(lastPrompt(s)).toEqual({ outcome: 'injected', daemon: true });

    const start = await oort(s, ['hook', 'SessionStart'], { input: session });
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toBe(sessionBaseline);

    // Stop is not served: it reads the transcript in-process, as before.
    const stop = await oort(s, ['hook', 'Stop'], {
      input: JSON.stringify({
        session_id: 's-serve',
        cwd: s.cwd,
        transcript_path: path.join(s.root, 'none.jsonl'),
        stop_hook_active: false,
      }),
    });
    expect(stop.exitCode).toBe(0);
    const stopLine = hookLog(s)
      .filter((l) => l['event'] === 'Stop')
      .at(-1);
    expect(stopLine).toBeDefined();
    expect(
      (stopLine?.['counts'] as Record<string, number> | undefined)?.['daemon'],
    ).toBeUndefined();

    const status = await oort(s, ['serve', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    const st = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(st).toMatchObject({ running: true, version: cliVersion(), served: 2 });

    const doctor = await oort(s, ['doctor', '--json']);
    const daemon = (
      JSON.parse(doctor.stdout) as { checks: { group: string; status: string; detail: string }[] }
    ).checks.find((c) => c.group === 'serve');
    expect(daemon?.status).toBe('ok');
    expect(daemon?.detail).toContain(`pid ${serve.child.pid}`);

    const stopped = await oort(s, ['serve', 'stop']);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain(`Stopped oort serve (pid ${serve.child.pid})`);
    expect(await serve.exited).toBe(0);
    expect(fs.existsSync(s.socket)).toBe(false);
    expect(fs.existsSync(lockPathFor(s.socket))).toBe(false);
  });

  it('serve.socket-is-0600-in-a-private-directory-and-never-tcp', async () => {
    const s = sandbox();
    const serve = await startServe(s);
    expect(fs.lstatSync(s.socket).isSocket()).toBe(true);
    expect(fs.lstatSync(s.socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(s.socket)).mode & 0o077).toBe(0);
    expect(fs.statSync(lockPathFor(s.socket)).mode & 0o777).toBe(0o600);
    // lsof lists the daemon's sockets: a Unix one, and no TCP or UDP listener.
    const lsof = await execa('lsof', ['-a', '-p', String(serve.child.pid), '-i'], {
      reject: false,
    });
    expect(lsof.stdout).not.toMatch(/TCP|UDP/);
    serve.child.kill('SIGTERM');
    expect(await serve.exited).toBe(0);
    expect(fs.existsSync(s.socket)).toBe(false);
  });

  it('serve.refuses-a-group-writable-directory-a-foreign-file-and-another-users-socket', async () => {
    const s = sandbox();
    fs.mkdirSync(s.oortHome, { mode: 0o700 });
    fs.chmodSync(s.oortHome, 0o770);
    const writable = await oort(s, ['serve']);
    expect(writable.exitCode).toBe(2);
    expect(writable.stderr).toContain('writable by group or others');
    expect(fs.existsSync(s.socket)).toBe(false);

    fs.chmodSync(s.oortHome, 0o700);
    fs.writeFileSync(s.socket, 'not a socket');
    const file = await oort(s, ['serve']);
    expect(file.exitCode).toBe(2);
    expect(file.stderr).toContain('is not a socket');
    expect(fs.readFileSync(s.socket, 'utf8')).toBe('not a socket');
    fs.rmSync(s.socket);

    // Ownership cannot be faked without root: the check itself, with another uid.
    const other = (process.getuid?.() ?? 0) + 1;
    fs.writeFileSync(path.join(s.root, 'x.sock'), '');
    expect(() => checkSocketPath(path.join(s.root, 'x.sock'), other)).toThrow(
      /belongs to another user/,
    );
  });

  it('serve.single-instance-and-a-stale-lock-and-socket-are-replaced', async () => {
    const s = sandbox();
    const first = await startServe(s);
    const second = await oort(s, ['serve']);
    expect(second.exitCode).toBe(2);
    expect(second.stderr).toContain(`already running (pid ${first.child.pid})`);
    const detached = await oort(s, ['serve', '--detach']);
    expect(detached.stdout).toContain('already running');
    first.child.kill('SIGKILL');
    await first.exited;
    // A daemon killed outright leaves its socket and pid file behind.
    expect(fs.existsSync(s.socket)).toBe(true);
    expect(fs.existsSync(lockPathFor(s.socket))).toBe(true);
    const doctor = await oort(s, ['doctor', '--json']);
    expect(doctor.stdout).toContain('a stopped daemon left');

    const next = await startServe(s);
    expect(next.child.pid).not.toBe(first.child.pid);
    expect(fs.readFileSync(lockPathFor(s.socket), 'utf8').trim()).toBe(String(next.child.pid));
    next.child.kill('SIGINT');
    expect(await next.exited).toBe(0);
  });

  it('serve.exits-when-idle', async () => {
    const s = sandbox();
    const serve = await startServe(s, ['--idle', '600ms']);
    expect(await serve.exited).toBe(0);
    expect(serve.output()).toContain('stopped (idle)');
    expect(fs.existsSync(s.socket)).toBe(false);
    expect(fs.existsSync(lockPathFor(s.socket))).toBe(false);
  });

  it('serve.never-migrates-and-refuses-a-store-that-needs-it', async () => {
    const s = sandbox();
    await seed(s, [memory({ embedding: new Int8Array(512).fill(3) })]);
    const db = path.join(s.oortHome, 'oort.sqlite');
    downgradeSqliteStore({ path: db });
    const r = await oort(s, ['serve']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('never migrates');
    expect(sqliteSchemaVersion(db)).toBe(1);
    expect(fs.existsSync(s.socket)).toBe(false);
    expect(fs.existsSync(lockPathFor(s.socket))).toBe(false);
  });

  it('serve.validates-every-request-and-refuses-unknown-methods', async () => {
    const s = sandbox();
    const serve = await startServe(s);
    const unknown = await raw(s.socket, { v: 1, id: 1, method: 'eval', params: {} });
    expect(unknown).toMatchObject({ ok: false, id: 1, error: { code: 'unknown-method' } });
    const extra = await raw(s.socket, {
      v: 1,
      id: 2,
      method: 'hook',
      params: {
        event: 'UserPromptSubmit',
        stdin: '{}',
        cwd: s.cwd,
        version: cliVersion(),
        path: '/etc/passwd',
      },
    });
    expect(extra).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    const relative = await raw(s.socket, {
      v: 1,
      id: 3,
      method: 'hook',
      params: { event: 'UserPromptSubmit', stdin: '{}', cwd: 'work', version: cliVersion() },
    });
    expect(relative).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    const stop = await raw(s.socket, {
      v: 1,
      id: 4,
      method: 'hook',
      params: { event: 'Stop', stdin: '{}', cwd: s.cwd, version: cliVersion() },
    });
    expect(stop).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    const protocol = await raw(s.socket, { v: 2, id: 5, method: 'ping', params: {} });
    expect(protocol).toMatchObject({ v: PROTOCOL_VERSION, ok: false, error: { code: 'protocol' } });
    const version = await raw(s.socket, {
      v: 1,
      id: 6,
      method: 'hook',
      params: { event: 'UserPromptSubmit', stdin: '{}', cwd: s.cwd, version: '0.0.1' },
    });
    expect(version).toMatchObject({ ok: false, error: { code: 'version-mismatch' } });
    const notJson = await new Promise<Record<string, unknown>>((resolve) => {
      const conn = net.createConnection(s.socket);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(3);
      conn.on('connect', () => conn.write(Buffer.concat([head, Buffer.from('{x}')])));
      const d = new FrameDecoder();
      conn.on('data', (c: Buffer) => resolve(d.push(c)[0] as Record<string, unknown>));
    });
    expect(notJson).toMatchObject({ ok: false, error: { code: 'bad-frame' } });
    // Still serving after all of that.
    expect((await callDaemon(s.socket, 'ping', {})).ok).toBe(true);
    const recall = await callDaemon(s.socket, 'recall', {
      text: PROMPT,
      cwd: s.cwd,
      version: cliVersion(),
    });
    expect(recall).toMatchObject({ ok: true, result: { text: '', ids: [] } });
    serve.child.kill('SIGTERM');
    await serve.exited;
  });

  it('serve.autostart-from-session-start-when-configured', async () => {
    const s = sandbox();
    fs.mkdirSync(s.oortHome, { mode: 0o700 });
    const session = JSON.stringify({ session_id: 's-auto', cwd: s.cwd, source: 'startup' });
    // Off by default: nothing starts.
    expect((await oort(s, ['hook', 'SessionStart'], { input: session })).exitCode).toBe(0);
    await sleep(300);
    expect(fs.existsSync(s.socket)).toBe(false);

    fs.writeFileSync(path.join(s.oortHome, 'config.json'), '{"serve":{"autostart":true}}\n');
    const r = await oort(s, ['hook', 'SessionStart'], { input: session });
    expect(r.exitCode).toBe(0);
    await until(async () => (await callDaemon(s.socket, 'ping', {}, { budgetMs: 300 })).ok);
    expect(fs.statSync(path.join(s.oortHome, 'logs', 'serve.log')).mode & 0o777).toBe(0o600);
    expect((await oort(s, ['serve', 'stop'])).exitCode).toBe(0);
  });
});

describe('a hook falls back to in-process whatever the daemon does', () => {
  it('serve.fallback-daemon-down-stale-socket', async () => {
    const { s, baseline } = await seededWithBaseline();
    // A daemon killed outright: its socket file stays, nobody listens.
    const script = path.join(s.root, 'listen.mjs');
    fs.writeFileSync(
      script,
      "import net from 'node:net'; net.createServer().listen(process.argv[2], () => process.stdout.write('ready'));",
    );
    fs.mkdirSync(path.dirname(s.socket), { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [script, s.socket], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(child);
    await new Promise((r) => child.stdout?.once('data', r));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(fs.lstatSync(s.socket).isSocket()).toBe(true);

    const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(baseline);
    expect(r.durationMs).toBeLessThan(2000);
    expect(lastPrompt(s)).toEqual({ outcome: 'injected', daemon: false });
  });

  it('serve.fallback-daemon-hung', async () => {
    const { s, baseline } = await seededWithBaseline();
    await fakeDaemon(s, () => {}); // accepts, reads, never answers
    const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(baseline);
    // The 2.5 s budget, then the in-process hook, well inside Claude Code's 10 s.
    expect(r.durationMs).toBeGreaterThanOrEqual(2400);
    expect(r.durationMs).toBeLessThan(6000);
    expect(lastPrompt(s)).toEqual({ outcome: 'injected', daemon: false });
  });

  it('serve.fallback-daemon-returns-an-error', async () => {
    const { s, baseline } = await seededWithBaseline();
    await fakeDaemon(s, (f, conn) =>
      conn.write(
        encodeFrame({ v: 1, id: f.id, ok: false, error: { code: 'internal', message: 'boom' } }),
      ),
    );
    const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(baseline);
    expect(lastPrompt(s).daemon).toBe(false);
  });

  it('serve.fallback-daemon-answers-garbage-or-another-protocol', async () => {
    const { s, baseline } = await seededWithBaseline();
    await fakeDaemon(s, (f, conn) =>
      conn.write(encodeFrame({ v: 2, id: f.id, ok: true, result: { stdout: 'not from v1' } })),
    );
    const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(baseline);

    for (const srv of servers.splice(0)) await new Promise((res) => srv.close(res));
    await fakeDaemon(s, (_f, conn) => conn.end(Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2])));
    const g = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(g.exitCode).toBe(0);
    expect(g.stdout).toBe(baseline);
  });

  it('serve.fallback-daemon-killed-mid-request', async () => {
    const { s, baseline } = await seededWithBaseline();
    // A daemon process that dies (SIGKILL) the moment a request arrives.
    const script = path.join(s.root, 'die.mjs');
    fs.writeFileSync(
      script,
      [
        "import net from 'node:net';",
        "net.createServer((c) => c.on('data', () => process.kill(process.pid, 'SIGKILL')))",
        "  .listen(process.argv[2], () => process.stdout.write('ready'));",
      ].join('\n'),
    );
    fs.mkdirSync(path.dirname(s.socket), { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [script, s.socket], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(child);
    await new Promise((r) => child.stdout?.once('data', r));
    const died = new Promise<NodeJS.Signals | null>((r) => child.once('exit', (_c, sig) => r(sig)));

    const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(await died).toBe('SIGKILL');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(baseline);
    expect(r.durationMs).toBeLessThan(2000);
    expect(lastPrompt(s)).toEqual({ outcome: 'injected', daemon: false });
  });

  it('serve.fallback-real-daemon-of-another-version', async () => {
    const { s, baseline } = await seededWithBaseline();
    // The real daemon refuses a hook from another oort: the hook runs in-process.
    const serve = await startServe(s);
    const r = await callDaemon(s.socket, 'hook', {
      event: 'UserPromptSubmit',
      stdin: promptInput(s),
      cwd: s.cwd,
      version: '0.0.1',
    });
    expect(r).toMatchObject({ ok: false, reason: 'error', code: 'version-mismatch' });
    const hook = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
    expect(hook.stdout).toBe(baseline);
    serve.child.kill('SIGTERM');
    await serve.exited;
  });

  it('serve.fallback-when-the-daemon-socket-is-not-this-users-alone', async () => {
    const { s, baseline } = await seededWithBaseline();
    let asked = 0;
    await fakeDaemon(s, (f, conn) => {
      asked++;
      conn.write(encodeFrame({ v: 1, id: f.id, ok: true, result: { stdout: 'planted' } }));
    });
    // A directory others can write: someone could have swapped the socket. Never connected.
    fs.chmodSync(path.dirname(s.socket), 0o777);
    try {
      const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: promptInput(s) });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(baseline);
      expect(asked).toBe(0);
    } finally {
      fs.chmodSync(path.dirname(s.socket), 0o700);
    }
  });
});
