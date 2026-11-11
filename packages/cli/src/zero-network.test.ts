/**
 * The "local first" guarantee (CON-19): with no API keys and no Oort Pro login, the local
 * commands that need no model make no network call at all. Each command runs in-process
 * through the real `wire` (real SQLite store under a temp `OORT_HOME`, no injected adapters),
 * with every way out of the process stubbed to record the attempt and throw: `fetch`,
 * `http`/`https` requests, `http2` sessions, `net`/`tls` sockets, DNS, UDP, child processes
 * and worker threads (a spawned process or a worker could reach the network where these stubs
 * cannot see it).
 */
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { TG } from '@oortmem/core/store-conformance';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import {
  AWS_KEY,
  fakeIo,
  memory,
  syntheticKey,
  tmpdir,
  writeTranscript,
  type FakeIo,
  data,
} from '../test/helpers.js';
import { fixtureFetch, registerTinyModels } from '../test/local-models.js';

const require = createRequire(import.meta.url);

/** Every key and endpoint variable that could switch on a model or Oort Pro. */
const NETWORK_ENV = [
  'VOYAGE_API_KEY',
  'TYPESAFE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OORT_API_KEY',
  'OORT_RELAY_URL',
  'OORT_CLOUD_URL',
];

interface Guard {
  /** One label per attempt, such as `fetch https://api.voyageai.com/v1/embeddings`. */
  attempts: string[];
  restore(): void;
}

/**
 * Replaces every network and process entry point with a stub that records the call and
 * throws. Builtin ESM namespaces are re-synced, so `import { request } from 'node:http'`
 * sees the stubs as well as `require`.
 */
function installNetworkGuard(): Guard {
  const attempts: string[] = [];
  const saved: [Record<string, unknown>, string, unknown][] = [];
  const block = (obj: object, key: string, label: string): void => {
    const target = obj as Record<string, unknown>;
    saved.push([target, key, target[key]]);
    target[key] = function blocked(...args: unknown[]): never {
      const first = args[0];
      const detail =
        typeof first === 'string' || first instanceof URL
          ? ` ${String(first)}`
          : first instanceof Request
            ? ` ${first.url}`
            : '';
      attempts.push(`${label}${detail}`);
      throw new Error(`zero-network test: ${label} is not allowed`);
    };
  };
  block(globalThis, 'fetch', 'fetch');
  for (const mod of ['node:http', 'node:https'] as const) {
    const m = require(mod) as object;
    block(m, 'request', `${mod} request`);
    block(m, 'get', `${mod} get`);
  }
  const net = require('node:net') as typeof import('node:net');
  block(net, 'connect', 'net.connect');
  block(net, 'createConnection', 'net.createConnection');
  block(net.Socket.prototype, 'connect', 'net.Socket#connect');
  block(require('node:tls') as object, 'connect', 'tls.connect');
  block(require('node:http2') as object, 'connect', 'http2.connect');
  const dns = require('node:dns') as typeof import('node:dns');
  for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) block(dns, fn, `dns.${fn}`);
  for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    block(dns.promises, fn, `dns.promises.${fn}`);
  }
  block(require('node:dgram') as object, 'createSocket', 'dgram.createSocket');
  const cp = require('node:child_process') as object;
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    block(cp, fn, `child_process.${fn}`);
  }
  // A worker gets fresh builtin modules, so none of these stubs would apply inside it.
  block(require('node:worker_threads') as object, 'Worker', 'worker_threads.Worker');
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const [obj, key, value] of saved.reverse()) obj[key] = value;
      syncBuiltinESMExports();
    },
  };
}

interface Sandbox {
  home: string;
  oortHome: string;
  cwd: string;
}

function sandbox(): Sandbox {
  const root = tmpdir('oort-offline-');
  const s = { home: root, oortHome: path.join(root, '.oort'), cwd: path.join(root, 'work') };
  fs.mkdirSync(s.cwd);
  return s;
}

/** Runs `oort <args>` in-process with the real wiring, no keys, and no keychain. */
async function oort(
  s: Sandbox,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; io: FakeIo }> {
  const io = fakeIo({
    cwd: s.cwd,
    env: { HOME: s.home, OORT_HOME: s.oortHome, OORT_NO_KEYCHAIN: '1', ...extraEnv },
  });
  const code = await runCli(args, io, undefined, createKeychain({ platform: 'none' }));
  return { code, io };
}

const AUTH = memory({
  text: 'The auth service listens on port 5582.',
  embedding: new Int8Array(512).fill(3),
});
const DEPLOY = memory({
  text: 'Deploys go out from the release branch every Tuesday.',
  stub: 'deploy day',
  entities: ['release-branch'],
  embedding: new Int8Array(512).fill(-3),
});

async function seed(s: Sandbox): Promise<void> {
  const store = await openSqliteStore({
    path: path.join(s.oortHome, 'oort.sqlite'),
    coldDir: path.join(s.oortHome, 'cold'),
    dimension: 512,
    log: () => {},
  });
  await store.upsertMany(TG, [AUTH, DEPLOY]);
  await store.close();
}

describe('zero network without keys or Oort Pro', () => {
  let guard: Guard;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // The commands read `io.env`, but strip the real process env too, so a key on the
    // machine running the tests cannot turn a keyless run into a keyed one.
    for (const k of NETWORK_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    guard = installNetworkGuard();
  });

  afterEach(() => {
    guard.restore();
    for (const k of NETWORK_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('offline.guard-records-every-way-out', async () => {
    const net = await import('node:net');
    const http = await import('node:http');
    const http2 = await import('node:http2');
    const { Worker } = await import('node:worker_threads');
    expect(() => fetch('https://example.invalid/')).toThrow();
    expect(() => http.get('http://example.invalid/')).toThrow();
    expect(() => net.connect(443, 'example.invalid')).toThrow();
    expect(() => new net.Socket().connect(443, 'example.invalid')).toThrow();
    expect(() => http2.connect('https://example.invalid/')).toThrow();
    expect(() => new Worker('process.exit()', { eval: true })).toThrow();
    expect(guard.attempts).toEqual([
      'fetch https://example.invalid/',
      'node:http get http://example.invalid/',
      'net.connect',
      'net.Socket#connect',
      'http2.connect https://example.invalid/',
      'worker_threads.Worker process.exit()',
    ]);
  });

  it('offline.local-commands-make-no-network-call', async () => {
    const s = sandbox();
    await seed(s);
    const id = AUTH.id;
    const projects = path.join(s.home, 'claude-projects');
    writeTranscript(projects, s.cwd);

    // Recall falls back to lexical search, says which key would add semantic recall, and
    // still finds the memory.
    const recall = await oort(s, ['recall', 'which port does the auth service listen on']);
    expect(recall.code).toBe(0);
    expect(recall.io.stdout).toContain('port 5582');
    expect(recall.io.stderr).toContain('`oort models pull` (free local embed and rerank, no keys)');
    // OORT_NO_KEYCHAIN=1: the variable is named, and `oort keys set` (which would refuse) is not.
    expect(recall.io.stderr).toContain('VOYAGE_API_KEY');
    expect(recall.io.stderr).toContain(
      'set VOYAGE_API_KEY in the environment your agent starts with',
    );
    expect(recall.io.stderr).not.toContain('oort keys set');
    expect(recall.io.stderr).not.toContain('export VOYAGE_API_KEY');

    const runs: [string[], (io: FakeIo) => void][] = [
      [['recall', 'deploy day', '--json'], (io) => expect(io.stdout).toContain('Tuesday')],
      [['explain', 'auth service port'], (io) => expect(io.stdout).toContain('5582')],
      [['inspect'], (io) => expect(io.stdout).toContain(id.slice(0, 8))],
      [['inspect', id, '--json'], (io) => expect(io.stdout).toContain('port 5582')],
      [['stats', '--json'], (io) => expect(io.stdout).toContain('"')],
      [['revalidate'], () => {}],
      [['pin', id], () => {}],
      [['unpin', id], () => {}],
      [['export'], (io) => expect(io.stdout).toContain(id)],
      [['keys', 'list'], (io) => expect(io.stdout).toContain('voyage')],
      [['cloud', 'status'], (io) => expect(io.stdout).toContain('local')],
      [['consolidate'], () => {}],
      [['forget', id, '--yes'], () => {}],
      [['observe', '--dry-run', '--user', 'u', '--assistant', 'a'], () => {}],
      [
        [
          'import',
          'claude-code',
          '--estimate-only',
          '--include-unresolved',
          '--projects-dir',
          projects,
        ],
        (io) => expect(io.stdout).toMatch(/observations\s+[1-9]/),
      ],
      [['init'], () => expect(fs.existsSync(path.join(s.oortHome, 'config.json'))).toBe(true)],
    ];
    for (const [args, check] of runs) {
      const r = await oort(s, args);
      expect(r.code, `oort ${args.join(' ')}: ${r.io.stderr}`).toBe(0);
      check(r.io);
    }
    const out = path.join(s.home, 'export.jsonl');
    expect((await oort(s, ['export', '--out', out])).code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).not.toContain(id); // forgotten above
    expect(fs.readFileSync(out, 'utf8')).toContain('Tuesday');

    // Doctor reports the missing keys and problems; it only probes the relay when a role uses it.
    const doctor = await oort(s, ['doctor', '--json']);
    const report = data(doctor.io.stdout) as { checks: { group: string; status: string }[] };
    expect(report.checks.find((c) => c.group === 'relay')?.status).toBe('info');

    expect(guard.attempts).toEqual([]);
  });

  it('offline.hook-recall-makes-no-network-call', async () => {
    const s = sandbox();
    await seed(s);
    const io = fakeIo({
      cwd: s.cwd,
      env: { HOME: s.home, OORT_HOME: s.oortHome, OORT_NO_KEYCHAIN: '1' },
      stdin: JSON.stringify({
        session_id: 's-offline',
        cwd: s.cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'which port does the auth service listen on?',
      }),
    });
    expect(
      await runCli(
        ['hook', 'UserPromptSubmit'],
        io,
        undefined,
        createKeychain({ platform: 'none' }),
      ),
    ).toBe(0);
    expect(io.hookStdout ?? '').toContain('port 5582');
    expect(guard.attempts).toEqual([]);
  });

  it('offline.observe-without-keys-refuses-before-any-call', async () => {
    const s = sandbox();
    await seed(s);
    const r = await oort(s, ['observe', '--user', 'which port?', '--assistant', 'port 5582']);
    expect(r.code).toBe(2);
    // OORT_NO_KEYCHAIN=1: each variable is named; `oort keys set` would refuse, so it is not offered.
    for (const v of ['VOYAGE_API_KEY', 'TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(r.io.stderr).toContain(v);
    }
    expect(r.io.stderr).not.toContain('oort keys set');
    expect(r.io.stderr).toContain('oort models pull');
    expect(r.io.stderr).not.toMatch(/export [A-Z_]+_API_KEY/);
    expect(r.io.stdout).toBe('');
    expect(guard.attempts).toEqual([]);
  });

  it('offline.local-models-chosen-but-not-pulled-download-nothing', async () => {
    // Choosing local models in config is not consent to download: without `oort models pull`,
    // recall and the hook stay lexical and nothing reaches the network.
    const s = sandbox();
    await seed(s);
    fs.writeFileSync(
      path.join(s.oortHome, 'config.json'),
      JSON.stringify({
        embed: { provider: 'local', model: 'bge-small-en-v1.5' },
        rerank: { provider: 'local', model: 'ms-marco-minilm-l6-v2' },
      }),
    );
    const r = await oort(s, ['recall', 'which port does the auth service listen on']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('port 5582');
    expect(r.io.stderr).toContain('oort models pull');
    // Models chosen but not pulled is a warning (exit 0), never a download.
    expect((await oort(s, ['doctor', '--json'])).code).toBe(0);
    expect(fs.existsSync(path.join(s.oortHome, 'models'))).toBe(false);
    expect(guard.attempts).toEqual([]);
  });

  it('offline.pulled-local-models-recall-without-network', async () => {
    // After the one opt-in download, embeddings and rerank run on the CPU: recall, the prompt
    // hook and doctor (which loads both models) make no network call.
    const unregister = registerTinyModels();
    try {
      const s = sandbox();
      await seed(s);
      const pull = fakeIo({
        cwd: s.cwd,
        env: { HOME: s.home, OORT_HOME: s.oortHome, OORT_NO_KEYCHAIN: '1' },
      });
      const calls: string[] = [];
      expect(
        await runCli(
          ['models', 'pull', 'tiny-embed', 'tiny-rerank'],
          pull,
          undefined,
          createKeychain({ platform: 'none' }),
          {
            fetch: fixtureFetch(calls),
          },
        ),
      ).toBe(0);
      expect(calls.length).toBeGreaterThan(0); // through the injected fetch, never the global one
      expect((await oort(s, ['reembed'])).code).toBe(0);
      const r = await oort(s, ['recall', 'which port does the auth service listen on']);
      expect(r.code).toBe(0);
      expect(r.io.stderr).not.toContain('lexical-only');
      const hook = fakeIo({
        cwd: s.cwd,
        env: { HOME: s.home, OORT_HOME: s.oortHome, OORT_NO_KEYCHAIN: '1' },
        stdin: JSON.stringify({
          session_id: 's-offline-local',
          cwd: s.cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'which port does the auth service listen on?',
        }),
      });
      expect(
        await runCli(
          ['hook', 'UserPromptSubmit'],
          hook,
          undefined,
          createKeychain({ platform: 'none' }),
        ),
      ).toBe(0);
      const doctor = await oort(s, ['doctor', '--json']);
      expect(doctor.io.stdout).toContain('local model tiny-embed');
      expect(guard.attempts).toEqual([]);
    } finally {
      unregister();
    }
  });

  it('offline.stop-hook-queues-without-network', async () => {
    // The Stop hook reads the session transcript, queues its turns and asks for a drain. It
    // calls no model, so with no keys it does all of that and nothing reaches the network.
    const s = sandbox();
    await seed(s);
    const transcript = writeTranscript(path.join(s.home, 'claude-projects'), s.cwd);
    const stop = await hook(s, 'Stop', stopInput(s, transcript));
    expect(stop.code).toBe(0);
    expect(stop.io.hookStdout).toBe(''); // any Stop output would make Claude keep going
    const queued = queueSnapshot(s);
    expect(Object.keys(queued).length).toBeGreaterThan(0);
    expect(Object.values(queued).join('')).not.toContain(AWS_KEY); // scrubbed before queueing
    expect(stop.io.spawnCwds).toEqual([s.oortHome]); // the drain is asked for, in OORT_HOME
    expect(hookLog(s).find((e) => e.event === 'Stop')?.outcome).toBe('queued');
    expect(guard.attempts).toEqual([]);
  });

  it('offline.drain-without-keys-leaves-the-queue-untouched', async () => {
    // Without embed, decide and write adapters the drain leaves the queue as it is
    // (`drain-skipped:missing-adapters`), so the turns are saved once keys or local models
    // exist; the local consolidation it then runs needs no model either.
    const s = sandbox();
    await seed(s);
    const transcript = writeTranscript(path.join(s.home, 'claude-projects'), s.cwd);
    expect((await hook(s, 'Stop', stopInput(s, transcript))).code).toBe(0);
    const before = queueSnapshot(s);
    const lines = Object.values(before).join('').split('\n').filter(Boolean).length;
    expect(lines).toBeGreaterThan(0);

    const drain = await hook(s, 'drain');
    expect(drain.code).toBe(0);
    expect(drain.io.hookStdout).toBe('');
    expect(queueSnapshot(s)).toEqual(before);
    expect(fs.existsSync(path.join(s.oortHome, 'queue', 'dead'))).toBe(false);
    const log = hookLog(s);
    const drained = log.find((e) => e.event === 'drain');
    expect(drained?.outcome).toBe('drain-skipped:missing-adapters');
    expect(drained?.counts).toEqual({ remaining: lines });
    expect(log.find((e) => e.event === 'consolidate')?.outcome).toBe('ok');
    expect(guard.attempts).toEqual([]);
  });

  it('offline.a-key-does-reach-the-guard (control)', async () => {
    // The same recall with a (synthetic) Voyage key goes through the real adapter, and the
    // guard sees it: the keyless runs above pass because nothing tried, not because the
    // stubs missed the adapters' way out.
    const s = sandbox();
    await seed(s);
    const r = await oort(s, ['recall', 'which port does the auth service listen on'], {
      VOYAGE_API_KEY: syntheticKey('voyage'),
    });
    expect(r.code).toBe(0);
    expect(guard.attempts.length).toBeGreaterThan(0);
    expect(guard.attempts.every((a) => a.startsWith('fetch '))).toBe(true);
  });

  it('offline.drain-with-keys-does-reach-the-guard (control)', async () => {
    // The same queue drained with (synthetic) keys goes through the real adapters and the
    // guard sees it: the keyless drain above passes because nothing tried. The decide SDK
    // retries each refused call with backoff before the drain's breaker trips, hence the timeout.
    const s = sandbox();
    await seed(s);
    const transcript = writeTranscript(path.join(s.home, 'claude-projects'), s.cwd);
    expect((await hook(s, 'Stop', stopInput(s, transcript))).code).toBe(0);
    expect(guard.attempts).toEqual([]);
    const drain = await hook(s, 'drain', undefined, {
      VOYAGE_API_KEY: syntheticKey('voyage'),
      TYPESAFE_API_KEY: syntheticKey('typesafe'),
      ANTHROPIC_API_KEY: syntheticKey('anthropic'),
    });
    expect(drain.code).toBe(0);
    expect(guard.attempts.length).toBeGreaterThan(0);
    expect(guard.attempts.every((a) => a.startsWith('fetch '))).toBe(true);
  }, 30_000);
});

/** Claude Code's Stop hook input for the session `writeTranscript` wrote. */
function stopInput(s: Sandbox, transcript: string): string {
  return JSON.stringify({
    session_id: path.basename(transcript, '.jsonl'),
    transcript_path: transcript,
    cwd: s.cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

/** Runs `oort hook <event>` in-process with the real wiring, no keys, and no keychain. */
async function hook(
  s: Sandbox,
  event: string,
  stdin?: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; io: FakeIo }> {
  const io = fakeIo({
    cwd: s.cwd,
    env: { HOME: s.home, OORT_HOME: s.oortHome, OORT_NO_KEYCHAIN: '1', ...extraEnv },
    ...(stdin !== undefined && { stdin }),
  });
  const code = await runCli(['hook', event], io, undefined, createKeychain({ platform: 'none' }));
  return { code, io };
}

/** Every queue file under `$OORT_HOME/queue` (not `dead/`), by name. */
function queueSnapshot(s: Sandbox): Record<string, string> {
  const dir = path.join(s.oortHome, 'queue');
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.jsonl')) out[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return out;
}

/** The hook log's entries, oldest first. */
function hookLog(s: Sandbox): { event: string; outcome: string; counts: unknown }[] {
  const file = path.join(s.oortHome, 'logs', 'hooks.log');
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; outcome: string; counts: unknown });
}
