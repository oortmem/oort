/**
 * The `oort.v1` JSON contract (CON-107 step 2, docs/cli.md "JSON output"): every command but
 * `hook`, `mcp` and a foreground `serve` takes `--json`, prints exactly one envelope on stdout, and
 * on failure an error envelope whose `code` and `exitCode` match. One success and one error per
 * command, then a walk of commander's tree so a new command cannot skip `--json` or this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MissingCredentialError, type DecisionController, type Embedder } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/helpers/fake-cloud.js';
import { fakeSite, type FakeSite } from '../test/fake-site.js';
import { fixtureFetch, registerTinyModels } from '../test/local-models.js';
import {
  fakeDecide,
  fakeIo,
  harness,
  memory,
  memoryKeychain,
  npmTrap,
  tmpdir,
  writeTranscript,
} from '../test/helpers.js';
import { writeCloudSettings } from './cloud.js';
import { createKeychain, type Keychain } from './keychain.js';
import { commandPath, hasJsonOption } from './output.js';
import { program, runCli } from './program.js';
import { wire as realWire, type WireFn } from './wire.js';

vi.setConfig({ testTimeout: 120_000 });

/** Commands that never print JSON: the hook protocol, the MCP stdio server. */
const EXEMPT = new Set(['hook', 'mcp']);

/**
 * Every command this file has a success and an error case for, by its envelope name (`serve`
 * reports `serve status` and `serve stop`; `serve start` is exempt in the foreground). A static
 * list, so the tree walk below does not depend on test order: `ok` and `bad` refuse a command that
 * is not listed, and the walk refuses a command of the tree that is not listed.
 */
const CONTRACT = [
  'setup',
  'init',
  'install',
  'uninstall',
  'connect',
  'disconnect',
  'serve status',
  'serve stop',
  'recall',
  'explain',
  'revalidate',
  'observe',
  'remember',
  'inspect',
  'stats',
  'consolidate',
  'forget',
  'judge record',
  'judge apply',
  'judge list',
  'judge withdraw',
  'judge confirm',
  'judge purge',
  'judge import',
  'judge eval',
  'judge pack export',
  'judge pack import',
  'share',
  'galaxy list',
  'galaxy members',
  'galaxy create',
  'constellation list',
  'constellation create',
  'constellation invite',
  'constellation join',
  'constellation invites',
  'constellation revoke',
  'constellation members',
  'constellation remove',
  'constellation role',
  'constellation leave',
  'constellation transfer',
  'constellation delete',
  'constellation adopt',
  'constellation policy',
  'constellation contested',
  'constellation resolve',
  'constellation attach',
  'constellation detach',
  'pin',
  'unpin',
  'project link',
  'project unlink',
  'project privacy',
  'cloud use',
  'cloud status',
  'cloud import',
  'cloud export',
  'whoami',
  'doctor',
  'update',
  'login',
  'logout',
  'open',
  'keys set',
  'keys list',
  'keys create',
  'keys rm',
  'models list',
  'models pull',
  'models verify',
  'models rm',
  'reembed',
  'reindex',
  'import',
  'export',
];

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** A success envelope for `command`, exit `exit`; returns its data. */
function ok(r: Result, command: string, exit = 0): any {
  expect(r.code, `${command}: ${r.stderr}`).toBe(exit);
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${command}: stdout is not one JSON document:\n${r.stdout}\n${r.stderr}`);
  }
  expect(env['schema']).toBe('oort.v1');
  expect(env['ok']).toBe(true);
  expect(env['command']).toBe(command);
  expect(typeof env['data']).toBe('object');
  expect(env['data']).not.toBeNull();
  expect(Array.isArray(env['data'])).toBe(false);
  expect(Array.isArray(env['warnings'])).toBe(true);
  for (const w of env['warnings'] as { code: unknown; message: unknown }[]) {
    expect(typeof w.code).toBe('string');
    expect(typeof w.message).toBe('string');
  }
  expect(CONTRACT, `${command} is not in CONTRACT`).toContain(command);
  return env['data'];
}

/** A failure envelope for `command` with error `code`; its exitCode is the process's. */
function bad(r: Result, command: string, code: string, exit = 2) {
  expect(r.code, `${command}: ${r.stderr}`).toBe(exit);
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${command}: stdout is not one JSON document:\n${r.stdout}\n${r.stderr}`);
  }
  expect(env['schema']).toBe('oort.v1');
  expect(env['ok']).toBe(false);
  expect(env['command']).toBe(command);
  const error = env['error'] as {
    code: string;
    message: string;
    fix: unknown;
    exitCode: number;
    retryable?: boolean;
    retryAfter?: number;
  };
  expect(error.code).toBe(code);
  expect(error.exitCode).toBe(r.code);
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.fix === null || typeof error.fix === 'string').toBe(true);
  // The one-line message stays on stderr for people (commander prints its own `error: …` line).
  expect(r.stderr).toContain(error.message.split('\n')[0]!.slice(0, 50));
  expect(CONTRACT, `${command} is not in CONTRACT`).toContain(command);
  return error;
}

// ---------------------------------------------------------------------------------------------
// Environments.

/** The local in-memory harness, as a Result. */
function local(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  const run = async (
    args: string[],
    io: Parameters<typeof h.run>[1] = {},
    keychain?: Keychain,
    deps?: Parameters<typeof h.run>[3],
  ): Promise<Result> => {
    const r = await h.run(args, io, keychain, deps);
    return { code: r.code, stdout: r.io.stdout, stderr: r.io.stderr };
  };
  return { h, run };
}

const oortKey = (): string => ['oort', 'sk', `contract${Date.now()}`.padEnd(43, 'C')].join('_');
const C = 'c_aaaaaaaaaaaaaaaa';
const MEM = '22222222-3333-4444-8555-666666666666';

/** A fake Oort Cloud account behind the real wire; `cloud` mode unless `local`. */
function cloudEnv(mode: 'cloud' | 'local' = 'cloud') {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = oortKey();
  const cloud: FakeCloud = fakeCloud(key);
  if (mode === 'cloud') writeCloudSettings(home, { store: 'cloud' });
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  const run = async (
    args: string[],
    opts: { env?: Record<string, string>; noKey?: boolean } = {},
  ): Promise<Result> => {
    const io = fakeIo({
      cwd,
      env: {
        HOME: root,
        OORT_HOME: home,
        OORT_NO_KEYCHAIN: '1',
        ...(opts.noKey !== true && { OORT_API_KEY: key }),
        ...opts.env,
      },
    });
    const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
      fetch: cloud.fetch,
      login: { openBrowser: async () => true },
    });
    return { code, stdout: io.stdout, stderr: io.stderr };
  };
  return { root, home, cwd, cloud, run };
}

function team(e: ReturnType<typeof cloudEnv>) {
  e.cloud.hive.enabled = true;
  e.cloud.hive.memberLimit = 10;
  e.cloud.hive.constellations.set(C, { id: C, name: 'oort-core', role: 'maintainer', owner: true });
  e.cloud.hive.members.set(C, [
    {
      member: 'mb_you000000001',
      role: 'maintainer',
      owner: true,
      you: true,
      email: null,
      joinedAt: '2026-11-05T00:00:00.000Z',
    },
    {
      member: 'mb_maya00000002',
      role: 'member',
      owner: false,
      you: false,
      email: 'ma…@example.com',
      joinedAt: '2026-11-06T00:00:00.000Z',
    },
  ]);
  e.cloud.memories.set(MEM, fakeMemory({ id: MEM, text: 'We deploy with wrangler.' }));
}

/** The built bin in a throwaway HOME: install and connect need it to be the real bin. */
const BIN = path.join(import.meta.dirname, '..', 'dist', 'main.js');
function binEnv() {
  const root = tmpdir('oort-contract-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  // The real npm is never run from a test: a stand-in comes first on PATH (CON-114).
  const trap = npmTrap(root);
  const env = {
    PATH: `${trap.dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    HOME: home,
    OORT_HOME: path.join(home, '.oort'),
    OORT_NO_KEYCHAIN: '1',
  };
  const run = async (
    args: string[],
    opts: { input?: string; env?: Record<string, string> } = {},
  ): Promise<Result> => {
    const r = await execa(BIN, args, {
      cwd,
      env: { ...env, ...opts.env },
      extendEnv: false,
      reject: false,
      timeout: 60_000,
      ...(opts.input !== undefined ? { input: opts.input } : { stdin: 'ignore' as const }),
      stripFinalNewline: false,
    });
    return { code: r.exitCode ?? 1, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  return { root, home, cwd, oortHome: env.OORT_HOME, run };
}

/** Local models from the tiny fixtures, downloaded through an injected fetch. */
function modelsEnv() {
  const home = tmpdir('oort-contract-models-');
  const oortHome = path.join(home, '.oort');
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd);
  const run = async (args: string[]): Promise<Result> => {
    const io = fakeIo({
      cwd,
      env: {
        HOME: home,
        OORT_HOME: oortHome,
        OORT_NO_KEYCHAIN: '1',
        OORT_MODELS_URL: 'https://models.example',
      },
    });
    const code = await runCli(args, io, undefined, createKeychain({ platform: 'none' }), {
      fetch: fixtureFetch([]),
    });
    return { code, stdout: io.stdout, stderr: io.stderr };
  };
  return { home, oortHome, run };
}

const BAD_AGENT = ['--agent', 'Not An Agent!'];

// ---------------------------------------------------------------------------------------------

describe('oort.v1: memories (local store)', () => {
  it('recall, explain', async () => {
    const { h, run } = local();
    await h.store.upsert(
      (await import('@oortmem/core/store-conformance')).TG,
      memory({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    );
    const r = ok(await run(['recall', 'auth service port', '--json']), 'recall');
    expect(r.memories[0].id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(r.memories[0]).not.toHaveProperty('embedding');
    bad(await run(['recall', 'x', '--as-of', 'not a date', '--json']), 'recall', 'usage');
    const e = ok(await run(['explain', 'auth service port', '--json']), 'explain');
    expect(e.memories[0].rank).toBe(1);
    bad(await run(['explain', 'x', '--known-at', 'nope', '--json']), 'explain', 'usage');
  });

  it('recall without keys: the stderr hint is a warning code too', async () => {
    const { run } = local({ adapters: false });
    const r = await run(['recall', 'anything', '--json']);
    ok(r, 'recall');
    const env = JSON.parse(r.stdout) as { warnings: { code: string; message: string }[] };
    expect(env.warnings.map((w) => w.code)).toContain('lexical-only');
    expect(env.warnings.find((w) => w.code === 'lexical-only')?.message).toContain(
      'oort models pull',
    );
    expect(r.stderr).toContain('oort: lexical-only recall.');
  });

  it('inspect: list, one, not-found, ambiguous-id', async () => {
    const { h, run } = local();
    const { TG } = await import('@oortmem/core/store-conformance');
    await h.store.upsertMany(TG, [
      memory({ id: 'abcd0000-0000-4000-8000-000000000001' }),
      memory({ id: 'abcd0000-0000-4000-8000-000000000002', text: 'Another fact.' }),
    ]);
    const list = ok(await run(['inspect', '--json']), 'inspect');
    expect(list.memories).toHaveLength(2);
    const one = ok(
      await run(['inspect', 'abcd0000-0000-4000-8000-000000000001', '--json']),
      'inspect',
    );
    expect(one.memory.id).toBe('abcd0000-0000-4000-8000-000000000001');
    bad(await run(['inspect', 'ffff', '--json']), 'inspect', 'not-found');
    bad(await run(['inspect', 'abcd', '--json']), 'inspect', 'ambiguous-id');
  });

  it('revalidate, stats, whoami, observe', async () => {
    const { run } = local();
    expect(ok(await run(['revalidate', '--json']), 'revalidate').memories).toEqual([]);
    bad(await run([...BAD_AGENT, 'revalidate', '--json']), 'revalidate', 'usage');
    expect(ok(await run(['stats', '--json']), 'stats')).toHaveProperty('tiers');
    bad(await run([...BAD_AGENT, 'stats', '--json']), 'stats', 'usage');
    expect(ok(await run(['whoami', '--json']), 'whoami').mode).toBe('local');
    bad(await run([...BAD_AGENT, 'whoami', '--json']), 'whoami', 'usage');
    const o = ok(
      await run(['observe', '--user', 'which port?', '--assistant', 'port 5582', '--json']),
      'observe',
    );
    expect(o.outcome).toBe('added');
    expect(typeof o.memoryId).toBe('string');
    bad(await run(['observe', '--user', 'x', '--json']), 'observe', 'usage');
    const m = ok(await run(['remember', 'The staging port is 5582.', '--json']), 'remember');
    expect(m.results).toEqual([{ fact: 0, outcome: 'added', id: expect.any(String) }]);
    expect(ok(await run(['remember', 'x', '--dry-run', '--json']), 'remember').dryRun).toBe(true);
    bad(await run(['remember', '', '--json']), 'remember', 'usage');
  });

  it('observe without keys: needs-key, with the free local fix', async () => {
    const { run } = local({ adapters: false });
    const e = bad(
      await run(['observe', '--user', 'a', '--assistant', 'b', '--json']),
      'observe',
      'needs-key',
    );
    expect(e.fix).toBe('oort models pull');
  });

  it('consolidate, forget, pin, unpin', async () => {
    const { h, run } = local();
    const { TG } = await import('@oortmem/core/store-conformance');
    const m = memory();
    await h.store.upsert(TG, m);
    const c = ok(await run(['consolidate', '--json']), 'consolidate');
    expect(c.counts).toMatchObject({ promoted: expect.any(Number), skipped: expect.any(Number) });
    expect(Array.isArray(c.evicted)).toBe(true);
    const p = ok(await run(['pin', m.id, '--json']), 'pin');
    expect(p).toEqual({ id: m.id, pinned: true, changed: true });
    bad(await run(['pin', 'ffff', '--json']), 'pin', 'not-found');
    expect(ok(await run(['unpin', m.id, '--json']), 'unpin')).toEqual({
      id: m.id,
      pinned: false,
      changed: true,
    });
    bad(await run(['unpin', 'ffff', '--json']), 'unpin', 'not-found');
    const refused = bad(await run(['forget', m.id, '--json']), 'forget', 'needs-confirmation');
    expect(refused.fix).toBe(`oort forget ${m.id} --json --yes`);
    expect(ok(await run(['forget', m.id, '--yes', '--json']), 'forget')).toMatchObject({
      id: m.id,
      forgotten: true,
    });
    // In cloud mode Oort Cloud consolidates: a refusal.
    const e = cloudEnv();
    bad(await e.run(['consolidate', '--json']), 'consolidate', 'refused');
  });

  it('export keeps JSON Lines on stdout; --out gives the envelope', async () => {
    const { h, run } = local();
    const { TG } = await import('@oortmem/core/store-conformance');
    await h.store.upsert(TG, memory());
    const lines = await run(['export', '--json']);
    expect(lines.code).toBe(0);
    expect(lines.stdout.split('\n')[0]).toMatch(/^\{"oort":"export"/);
    const out = path.join(h.root, 'export.jsonl');
    expect(ok(await run(['export', '--out', out, '--json']), 'export')).toEqual({
      file: out,
      memories: 1,
      format: 2,
    });
    bad(await run(['export', '--format', '3', '--json']), 'export', 'usage');
  });

  it('import claude-code', async () => {
    const { h, run } = local();
    const projects = path.join(h.root, 'projects');
    writeTranscript(projects, h.cwd);
    // It asks before using the writer: --json never asks, so it refuses without --yes.
    bad(
      await run([
        'import',
        'claude-code',
        '--projects-dir',
        projects,
        '--include-unresolved',
        '--json',
      ]),
      'import',
      'needs-confirmation',
    );
    const r = ok(
      await run([
        'import',
        'claude-code',
        '--projects-dir',
        projects,
        '--include-unresolved',
        '--yes',
        '--json',
      ]),
      'import',
    );
    expect(r.outcome).toBe('imported');
    expect(r.estimate.sessions).toBe(1);
    expect(typeof r.imported.observations).toBe('number');
    const e = bad(await run(['import', 'codex', '--json']), 'import', 'usage');
    expect(e.fix).toBe('oort import claude-code');
  });

  it('init, project link, project unlink', async () => {
    const { h, run } = local();
    const i = ok(await run(['init', '--json']), 'init');
    expect(i.config).toEqual({ path: path.join(h.home, 'config.json'), created: true });
    bad(await run(['init', '--project', '--json']), 'init', 'usage');
    bad(await run(['project', 'link', '--id', 'p1', '--json']), 'project link', 'usage');
    bad(await run(['project', 'unlink', '--json']), 'project unlink', 'usage');
    fs.mkdirSync(path.join(h.cwd, '.git'));
    expect(
      ok(await run(['project', 'link', '--id', 'p1', '--json']), 'project link'),
    ).toMatchObject({
      linked: true,
    });
    expect(ok(await run(['project', 'unlink', '--json']), 'project unlink')).toMatchObject({
      unlinked: true,
    });
  });

  it('serve status and stop are named so; a foreground serve never prints an envelope', async () => {
    const { run } = local();
    // Not running exits 1 (`oort serve status || oort serve --detach`); the envelope says so,
    // with that exit code.
    const st = await run(['serve', 'status', '--json']);
    expect(ok(st, 'serve status', 1)).toMatchObject({ running: false });
    expect(JSON.parse(st.stdout).exitCode).toBe(1);
    bad(await run(['serve', 'status', '--bogus', '--json']), 'serve status', 'usage');
    const stop = await run(['serve', 'stop', '--json']);
    expect(ok(stop, 'serve stop')).toMatchObject({ stopped: false });
    expect(JSON.parse(stop.stdout)).not.toHaveProperty('exitCode');
    bad(await run(['serve', 'stop', '--bogus', '--json']), 'serve stop', 'usage');
    // In the foreground it refuses --json on stderr only: never an envelope.
    const fg = await run(['serve', '--json']);
    expect(fg.code).toBe(2);
    expect(fg.stdout).toBe('');
    expect(fg.stderr).toContain('--json is for');
  });

  it('doctor: warnings exit 0, a failure exits 1, data.status tells them apart, fixCommand', async () => {
    const { h, run } = local();
    // Keyless is a supported state: `oort doctor && …` keeps working.
    const d = ok(await run(['doctor', '--json']), 'doctor', 0);
    expect(d.status).toBe('warn');
    expect(d.problems).toBeGreaterThan(0);
    fs.mkdirSync(path.join(h.root, '.gemini'));
    fs.writeFileSync(path.join(h.root, '.gemini', 'settings.json'), '{ not json');
    fs.mkdirSync(path.join(h.root, '.cursor'));
    fs.writeFileSync(
      path.join(h.root, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          oort: {
            type: 'stdio',
            command: path.join(h.root, 'gone', 'node_modules', 'oortmem', 'dist', 'main.js'),
            args: ['mcp'],
          },
        },
      }),
    );
    const fr = await run(['doctor', '--json']);
    const f = ok(fr, 'doctor', 1);
    expect(f.status).toBe('fail');
    expect(JSON.parse(fr.stdout).exitCode).toBe(1);
    const cursor = (f.checks as { name: string; fixCommand?: string }[]).find(
      (c) => c.name === 'cursor',
    );
    expect(cursor, JSON.stringify(f.checks)).toBeDefined();
    expect(cursor?.fixCommand, JSON.stringify(cursor)).toBe('oort connect cursor');
    bad(await run(['doctor', '--bogus', '--json']), 'doctor', 'usage');
  });
});

describe('oort.v1: update', () => {
  it('update: --check reports and exits 0; a bad --version is a usage error', async () => {
    const { run } = local();
    // Fakes only: no registry, no installer, no daemon.
    const updateDeps = {
      latest: async () => '99.0.0',
      daemon: async () => ({ running: false }),
      tmpdir: () => '/nonexistent-tmp',
    };
    const d = ok(
      await run(['update', '--check', '--json'], {}, undefined, { updateDeps }),
      'update',
      0,
    );
    expect(d).toMatchObject({ latest: '99.0.0', check: true, from: 'npm', installed: [] });
    expect(Array.isArray(d.copies)).toBe(true);
    bad(
      await run(['update', '--version', 'nope', '--json'], {}, undefined, { updateDeps }),
      'update',
      'usage',
    );
  });
});

describe('oort.v1: keys, login, logout', () => {
  it('keys list, set, rm', async () => {
    const { run } = local();
    expect(ok(await run(['keys', 'list', '--json']), 'keys list').keys).toHaveLength(4);
    // keys list reads nothing that can refuse: its error is commander's usage error.
    bad(await run(['keys', 'list', '--bogus', '--json']), 'keys list', 'usage');
    // A macOS Keychain double: `security` succeeds, and nothing real is touched.
    const kc = createKeychain({
      platform: 'darwin',
      user: 'tester',
      execFile: async () => {
        throw Object.assign(new Error('nf'), { code: 44 });
      },
      spawnInherit: async () => 0,
      warn: () => {},
    });
    const set = ok(await run(['keys', 'set', 'voyage', '--json'], {}, kc), 'keys set');
    expect(set).toMatchObject({ provider: 'voyage', stored: true });
    expect(ok(await run(['keys', 'rm', 'voyage', '--json'], {}, kc), 'keys rm')).toMatchObject({
      provider: 'voyage',
      removed: true,
    });
    // No key store on this system: a refusal naming the environment instead.
    bad(await run(['keys', 'set', 'voyage', '--json']), 'keys set', 'usage');
    bad(await run(['keys', 'rm', 'voyage', '--json']), 'keys rm', 'usage');
  });

  it('keys create', async () => {
    const e = cloudEnv();
    const k = ok(await e.run(['keys', 'create', '--name', 'ci', '--json']), 'keys create');
    expect(typeof k.key).toBe('string');
    bad(await e.run(['keys', 'create', '--scope', 'checkout', '--json']), 'keys create', 'usage');
    const login = bad(
      await e.run(['keys', 'create', '--json'], { noKey: true }),
      'keys create',
      'needs-login',
    );
    expect(login.fix).toBe('oort login');
  });

  let site: FakeSite | undefined;
  afterAll(async () => site?.close());

  it('login, logout', async () => {
    site = await fakeSite({ approveAtPoll: 1 });
    const { run } = local();
    const k = memoryKeychain();
    const deps = { login: { sleep: async () => {}, openBrowser: async () => false } };
    const env = { env: { OORT_SITE_URL: site.url } };
    expect(ok(await run(['login', '--json'], env, k.kc, deps), 'login')).toMatchObject({
      signedIn: true,
    });
    expect(ok(await run(['logout', '--json'], {}, k.kc), 'logout')).toMatchObject({
      removed: true,
    });
    const noStore = { env: { OORT_NO_KEYCHAIN: '1', OORT_SITE_URL: site.url } };
    bad(await run(['login', '--json'], noStore, k.kc, deps), 'login', 'usage');
    bad(await run(['logout', '--json'], noStore, k.kc), 'logout', 'usage');
  });

  it('open', async () => {
    const e = cloudEnv();
    e.cloud.memories.set(MEM, fakeMemory({ id: MEM, text: 'We deploy with wrangler.' }));
    expect(ok(await e.run(['open', 'memory', MEM.slice(0, 8), '--json']), 'open')).toEqual({
      target: 'memory',
      url: `https://oortcloud.dev/dashboard/memories/${MEM}`,
      opened: false,
    });
    expect(ok(await e.run(['open', '--json']), 'open')).toMatchObject({ target: 'dashboard' });
    bad(await cloudEnv('local').run(['open', 'memory', MEM, '--json']), 'open', 'cloud-only');
    bad(await e.run(['open', 'memory', '--json']), 'open', 'usage');
  });
});

describe('oort.v1: judgment memory', () => {
  const topics: Embedder = {
    dimension: 4,
    async embed(texts) {
      return texts.map((t) =>
        /vitamin|remedy/.test(t) ? Int8Array.from([100, 0, 0, 0]) : Int8Array.from([0, 0, 0, 100]),
      );
    },
  };
  const decide: DecisionController = {
    ...fakeDecide,
    async judge(req) {
      return {
        verdict: 'rejected',
        probability: 0.9,
        probabilities: Object.fromEntries(
          req.verdicts.map((v) => [v, v === 'rejected' ? 0.9 : 0.1]),
        ),
        decisions: [],
      };
    },
  };
  const judging = () => {
    const l = local();
    const base = l.h.wire;
    l.h.wire = async (dir, o) => ({ ...(await base(dir, o)), decide, embed: topics });
    return l;
  };
  const record = [
    'judge',
    'record',
    '--subject',
    'Post says a vitamin cures the flu',
    '--verdict',
    'rejected',
    '--reason',
    'No source.',
    '--domain',
    'content',
    '--by',
    'ada',
    '--json',
  ];

  it('record, apply, list, withdraw, confirm, purge', async () => {
    const { run } = judging();
    const r = ok(await run(record), 'judge record');
    expect(r.outcome).toBe('added');
    const id = r.id as string;
    bad(await run(['judge', 'record', '--verdict', 'x', '--json']), 'judge record', 'usage');
    const a = ok(
      await run(['judge', 'apply', 'Ad says a remedy cures pain', '--json']),
      'judge apply',
    );
    expect(typeof a.status).toBe('string');
    bad(await run(['judge', 'apply', 'x', '--k', 'many', '--json']), 'judge apply', 'usage');
    expect(ok(await run(['judge', 'list', '--json']), 'judge list').judgments).toHaveLength(1);
    bad(await cloudEnv().run(['judge', 'list', '--json']), 'judge list', 'refused');
    // A person recorded it: nothing to confirm, changed false.
    expect(ok(await run(['judge', 'confirm', id, '--json']), 'judge confirm')).toMatchObject({
      id,
      changed: false,
    });
    bad(await run(['judge', 'confirm', 'ffff', '--json']), 'judge confirm', 'not-found');
    bad(await run(['judge', 'withdraw', id, '--json']), 'judge withdraw', 'needs-confirmation');
    expect(
      ok(await run(['judge', 'withdraw', id, '--yes', '--json']), 'judge withdraw'),
    ).toMatchObject({
      id,
      withdrawn: true,
      changed: true,
    });
    bad(await run(['judge', 'purge', 'ffff', '--yes', '--json']), 'judge purge', 'not-found');
    expect(ok(await run(['judge', 'purge', id, '--yes', '--json']), 'judge purge')).toMatchObject({
      id,
      purged: true,
    });
  });

  it('import, eval, pack export, pack import', async () => {
    const { h, run } = judging();
    const csv = [
      'subject,verdict,reason',
      '"Post says a vitamin cures the flu",rejected,"No source."',
      '"Quarterly revenue chart",approved,"Plain data."',
    ].join('\n');
    fs.writeFileSync(path.join(h.cwd, 'past.csv'), csv);
    const args = ['past.csv', '--domain', 'content', '--by', 'ada', '--json'];
    expect(ok(await run(['judge', 'import', ...args]), 'judge import')).toMatchObject({
      rows: 2,
      added: 2,
    });
    bad(await run(['judge', 'import', 'missing.csv', '--json']), 'judge import', 'usage');
    expect(ok(await run(['judge', 'eval', ...args]), 'judge eval')).toHaveProperty('domains');
    const keyless = local();
    fs.writeFileSync(path.join(keyless.h.cwd, 'past.csv'), csv);
    bad(await keyless.run(['judge', 'eval', ...args]), 'judge eval', 'needs-key');
    const out = path.join(h.root, 'p.pack.jsonl');
    expect(
      ok(await run(['judge', 'pack', 'export', '--out', out, '--json']), 'judge pack export'),
    ).toEqual({
      file: out,
      judgments: 2,
    });
    bad(
      await run(['judge', 'pack', 'export', '--out', out, '--json']),
      'judge pack export',
      'usage',
    );
    // To stdout the pack itself is the output.
    const raw = await run(['judge', 'pack', 'export', '--json']);
    expect(raw.code).toBe(0);
    expect(raw.stdout).not.toContain('"schema":');
    const other = judging();
    const imp = ok(
      await other.run(['judge', 'pack', 'import', out, '--yes', '--json']),
      'judge pack import',
    );
    expect(imp.added).toHaveLength(2);
    bad(
      await other.run(['judge', 'pack', 'import', 'nope.jsonl', '--json']),
      'judge pack import',
      'usage',
    );
  });
});

describe('oort.v1: local models, reembed and reindex', () => {
  let unregister: () => void;
  beforeAll(() => {
    unregister = registerTinyModels();
  });
  afterAll(() => unregister());

  it('models list, pull, verify, rm; reembed; reindex', async () => {
    const m = modelsEnv();
    expect(
      ok(await m.run(['models', 'list', '--json']), 'models list').models.length,
    ).toBeGreaterThan(0);
    bad(await m.run(['models', 'list', '--bogus', '--json']), 'models list', 'usage');
    bad(await m.run(['models', 'pull', 'no-such-model', '--json']), 'models pull', 'not-found');
    bad(await m.run(['models', 'verify', 'no-such-model', '--json']), 'models verify', 'not-found');
    bad(await m.run(['models', 'rm', 'no-such-model', '--json']), 'models rm', 'not-found');
    // Nothing stored yet, so reembed refuses before touching anything.
    const pull = ok(
      await m.run(['models', 'pull', 'tiny-embed', 'tiny-rerank', '--json']),
      'models pull',
    );
    expect(pull.used).toBe(true);
    expect(pull.models.map((x: { id: string }) => x.id)).toEqual(['tiny-embed', 'tiny-rerank']);
    const v = ok(await m.run(['models', 'verify', '--json']), 'models verify');
    expect(v.ok).toBe(true);
    const re = ok(await m.run(['reembed', '--json']), 'reembed');
    expect(re.embedder).toBe('local/tiny-embed');
    expect(ok(await m.run(['models', 'rm', '--json']), 'models rm').deleted).toEqual([
      'tiny-embed',
      'tiny-rerank',
    ]);
    // No RaBitQ index in this store: reindex says so and changes nothing (CON-25).
    expect(ok(await m.run(['reindex', '--json']), 'reindex')).toMatchObject({ rebuilt: false });
    const cloud = cloudEnv();
    bad(await cloud.run(['reembed', '--json']), 'reembed', 'refused');
    bad(await cloud.run(['reindex', '--json']), 'reindex', 'refused');
  });
});

describe('oort.v1: Oort Cloud', () => {
  it('cloud use, status, import, export', async () => {
    const e = cloudEnv('local');
    bad(await e.run(['cloud', 'use', '--json'], { noKey: true }), 'cloud use', 'needs-login');
    expect(ok(await e.run(['cloud', 'use', '--json']), 'cloud use')).toMatchObject({
      store: 'cloud',
    });
    expect(ok(await e.run(['cloud', 'use', '--local', '--json']), 'cloud use')).toEqual({
      store: 'local',
    });
    expect(ok(await e.run(['cloud', 'status', '--json']), 'cloud status').store).toBe('local');
    bad(await e.run([...BAD_AGENT, 'cloud', 'status', '--json']), 'cloud status', 'usage');
    expect(
      ok(await e.run(['cloud', 'import', '--dry-run', '--json']), 'cloud import'),
    ).toMatchObject({
      dryRun: true,
      uploaded: 0,
    });
    bad(await e.run([...BAD_AGENT, 'cloud', 'import', '--json']), 'cloud import', 'usage');
    const out = path.join(e.root, 'cloud.jsonl');
    expect(
      ok(await e.run(['cloud', 'export', '--out', out, '--json']), 'cloud export'),
    ).toMatchObject({
      file: out,
      format: 1,
    });
    bad(await e.run(['cloud', 'export', '--json'], { noKey: true }), 'cloud export', 'needs-login');
  });

  it('share, project privacy', async () => {
    const e = cloudEnv();
    team(e);
    expect(
      ok(await e.run(['share', MEM, '--to', 'oort-core', '--yes', '--json']), 'share'),
    ).toMatchObject({
      constellationId: C,
    });
    bad(await cloudEnv('local').run(['share', MEM, '--to', 'x', '--json']), 'share', 'cloud-only');
    fs.mkdirSync(path.join(e.cwd, '.git'));
    expect(
      ok(await e.run(['project', 'privacy', 'private', '--json']), 'project privacy'),
    ).toMatchObject({
      private: true,
    });
    const local = cloudEnv('local');
    const co = bad(
      await local.run(['project', 'privacy', 'private', '--json']),
      'project privacy',
      'cloud-only',
    );
    expect(co.fix).toBe('oort cloud use');
  });

  it('project link and unlink --constellation', async () => {
    const e = cloudEnv();
    team(e);
    fs.mkdirSync(path.join(e.cwd, '.git'));
    expect(
      ok(
        await e.run(['project', 'link', '--constellation', 'oort-core', '--json']),
        'project link',
      ),
    ).toMatchObject({ bound: true });
    expect(
      ok(
        await e.run(['project', 'unlink', '--constellation', 'oort-core', '--json']),
        'project unlink',
      ),
    ).toMatchObject({ bound: false });
  });

  it('galaxy list, members, create', async () => {
    const e = cloudEnv();
    e.cloud.hive.enabled = true;
    e.cloud.hive.galaxies.set('g_aaaaaaaaaaaaaaaa', {
      id: 'g_aaaaaaaaaaaaaaaa',
      name: 'Acme',
      slug: 'acme',
      role: 'admin',
      members: 1,
      constellations: 0,
    });
    e.cloud.hive.galaxyMembers.set('g_aaaaaaaaaaaaaaaa', [
      { member: 'gm_1', role: 'admin', you: true, email: null, joinedAt: '2026-11-01T00:00:00Z' },
    ]);
    expect(ok(await e.run(['galaxy', 'list', '--json']), 'galaxy list').galaxies).toHaveLength(1);
    bad(await e.run(['galaxy', 'list', '--json'], { noKey: true }), 'galaxy list', 'needs-login');
    expect(
      ok(await e.run(['galaxy', 'members', 'acme', '--json']), 'galaxy members').members,
    ).toHaveLength(1);
    bad(await e.run(['galaxy', 'members', 'nope', '--json']), 'galaxy members', 'not-found');
    expect(ok(await e.run(['galaxy', 'create', 'Beta', '--json']), 'galaxy create')).toMatchObject({
      name: 'Beta',
      opened: false,
    });
    bad(await e.run(['galaxy', 'create', ' ', '--json']), 'galaxy create', 'usage');
  });

  it('constellation reads and mutations', async () => {
    const e = cloudEnv();
    team(e);
    const c = (args: string[]) => e.run(['constellation', ...args, '--json']);
    expect(ok(await c(['list']), 'constellation list').constellations).toHaveLength(1);
    // The fake plan holds one Constellation: create in an account that has none yet.
    const fresh = cloudEnv();
    fresh.cloud.hive.enabled = true;
    expect(
      ok(
        await fresh.run(['constellation', 'create', 'team-two', '--json']),
        'constellation create',
      ),
    ).toHaveProperty('id');
    bad(await c(['create', '!!']), 'constellation create', 'usage');
    const inv = ok(await c(['invite', 'oort-core', 'kim@example.com']), 'constellation invite');
    expect(inv).toMatchObject({ role: 'member' });
    bad(await c(['invite', 'oort-core', 'not-an-email']), 'constellation invite', 'usage');
    const invites = ok(await c(['invites', 'oort-core']), 'constellation invites').invites;
    expect(invites).toHaveLength(1);
    expect(
      ok(await c(['revoke', 'oort-core', invites[0].id]), 'constellation revoke'),
    ).toMatchObject({
      revoked: true,
    });
    const link = `https://oortcloud.dev/invite#oort_iv_${'a'.repeat(43)}`;
    expect(ok(await c(['join', link]), 'constellation join')).toMatchObject({ opened: false });
    bad(await c(['join', 'nope']), 'constellation join', 'usage');
    expect(ok(await c(['members', 'oort-core']), 'constellation members').members).toHaveLength(2);
    expect(
      ok(await c(['role', 'oort-core', 'mb_maya00000002', 'reader']), 'constellation role'),
    ).toMatchObject({
      role: 'reader',
    });
    bad(await c(['role', 'oort-core', 'mb_maya00000002', 'king']), 'constellation role', 'usage');
    expect(ok(await c(['policy', 'oort-core', '--open']), 'constellation policy')).toMatchObject({
      policy: 'open',
    });
    bad(await c(['policy', 'oort-core']), 'constellation policy', 'usage');
    expect(
      ok(await c(['attach', 'oort-core', '--agent', 'cursor']), 'constellation attach'),
    ).toMatchObject({
      agent: 'cursor',
    });
    bad(await c(['attach', 'oort-core']), 'constellation attach', 'usage');
    expect(
      ok(await c(['detach', 'oort-core', '--agent', 'cursor']), 'constellation detach'),
    ).toMatchObject({
      detached: true,
    });
    bad(await c(['detach', 'oort-core']), 'constellation detach', 'usage');
    expect(ok(await c(['contested', 'oort-core']), 'constellation contested').contested).toEqual(
      [],
    );
    bad(await c(['contested', 'nope']), 'constellation contested', 'not-found');
    bad(
      await c(['resolve', 'oort-core', MEM, '--keep', MEM]),
      'constellation resolve',
      'not-found',
    );
    e.cloud.hive.contests.set(C, [
      {
        action: 'SUPERSEDE',
        openedAt: '2026-11-05T10:00:00.000Z',
        current: fakeMemory({ id: '11111111-aaaa-4aaa-8aaa-111111111111', text: 'fly' }),
        challenger: fakeMemory({ id: '33333333-cccc-4ccc-8ccc-333333333333', text: 'railway' }),
      },
    ]);
    const chal = '33333333-cccc-4ccc-8ccc-333333333333';
    expect(
      ok(await c(['resolve', 'oort-core', chal, '--keep', chal]), 'constellation resolve'),
    ).toMatchObject({
      kept: chal,
    });
    // Mutations that ask first refuse under --json without --yes, with the --yes fix.
    const r = bad(
      await c(['remove', 'oort-core', 'mb_maya00000002']),
      'constellation remove',
      'needs-confirmation',
    );
    expect(r.fix).toBe('oort constellation remove oort-core mb_maya00000002 --json --yes');
    expect(
      ok(await c(['remove', 'oort-core', 'mb_maya00000002', '--yes']), 'constellation remove'),
    ).toMatchObject({
      removed: true,
    });
    bad(await c(['transfer', 'oort-core', 'mb_x']), 'constellation transfer', 'needs-confirmation');
    bad(await c(['leave', 'oort-core']), 'constellation leave', 'needs-confirmation');
    bad(await c(['delete', 'oort-core']), 'constellation delete', 'needs-confirmation');
    bad(await c(['adopt', 'oort-core']), 'constellation adopt', 'usage');
    e.cloud.hive.archived.set(C, '2026-12-01T00:00:00.000Z');
    expect(ok(await c(['adopt', 'oort-core']), 'constellation adopt')).toBeTypeOf('object');
    // Transfer to the other member (re-added), then leave and delete a fresh one.
    team(e);
    expect(
      ok(await c(['transfer', 'oort-core', 'mb_maya00000002', '--yes']), 'constellation transfer'),
    ).toMatchObject({
      owner: 'mb_maya00000002',
    });
    team(e);
    // The owner cannot leave: as a plain member.
    e.cloud.hive.constellations.set(C, { id: C, name: 'oort-core', role: 'member', owner: false });
    for (const m of e.cloud.hive.members.get(C) ?? []) {
      if (m.you) Object.assign(m, { role: 'member', owner: false });
    }
    expect(ok(await c(['leave', 'oort-core', '--yes']), 'constellation leave')).toMatchObject({
      left: true,
    });
    team(e);
    expect(ok(await c(['delete', 'oort-core', '--yes']), 'constellation delete')).toMatchObject({
      deleted: true,
    });
    // Outside the hive beta every Constellation route is the API's refusal.
    e.cloud.hive.enabled = false;
    bad(await c(['list']), 'constellation list', 'refused');
    bad(await c(['members', 'oort-core']), 'constellation members', 'refused');
    bad(await c(['invites', 'oort-core']), 'constellation invites', 'refused');
    bad(await c(['revoke', 'oort-core', 'inv_x']), 'constellation revoke', 'refused');
  });
});

describe('oort.v1: install, connect, setup (the built bin, a throwaway HOME)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) throw new Error(`${BIN} is missing: build first`);
  });

  it('install, uninstall, connect, disconnect, setup', async () => {
    const b = binEnv();
    const i = ok(await b.run(['install', 'claude-code', '--json']), 'install');
    expect(i).toMatchObject({ harness: 'claude-code', action: 'install', changed: true });
    expect(i.file).toBe(path.join(b.home, '.claude', 'settings.json'));
    bad(await b.run(['install', 'netscape', '--json']), 'install', 'usage');
    expect(ok(await b.run(['uninstall', 'claude-code', '--json']), 'uninstall')).toMatchObject({
      changed: true,
    });
    bad(await b.run(['uninstall', 'netscape', '--json']), 'uninstall', 'usage');
    fs.mkdirSync(path.join(b.home, '.cursor'));
    const c = ok(await b.run(['connect', 'cursor', '--json']), 'connect');
    expect(c.changes[0]).toMatchObject({ host: 'cursor', changed: true, memory: 'planet' });
    bad(await b.run(['connect', 'chatgpt', '--json']), 'connect', 'usage');
    expect(
      ok(await b.run(['disconnect', 'cursor', '--json']), 'disconnect').changes[0],
    ).toMatchObject({
      changed: true,
    });
    bad(await b.run(['disconnect', 'chatgpt', '--json']), 'disconnect', 'usage');
    const s = ok(
      await b.run(['setup', '--yes', '--agents', 'none', '--keys', 'skip', '--no-demo', '--json']),
      'setup',
    );
    expect(s).toMatchObject({ agents: [], keys: 'skip', import: 'skipped', demo: false });
    const e = bad(await b.run(['setup', '--json']), 'setup', 'usage');
    expect(e.fix).toContain('oort setup --yes');
  });

  it('usage errors from commander are envelopes too, and OORT_OUTPUT=json turns JSON on', async () => {
    const { run } = local();
    const missing = bad(await run(['forget', '--json']), 'forget', 'usage');
    expect(missing.fix).toBe('oort --help');
    bad(await run(['stats', '--bogus', '--json']), 'stats', 'usage');
    const env = { env: { OORT_OUTPUT: 'json' } };
    ok(await run(['stats'], env), 'stats');
    bad(await run(['inspect', 'ffff'], env), 'inspect', 'not-found');
    // Never on the hook protocol or a foreground serve: OORT_OUTPUT leaves them be.
    const hook = await run(['hook', 'Stop'], { ...env, stdin: '{}' });
    expect(hook.stdout).not.toContain('oort.v1');
  });
});

describe('oort.v1: review fixes', () => {
  const sk = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  const oortSk = ['oort', 'sk', 'B'.repeat(43)].join('_');

  it('a key pasted as an excess argument never comes back: text, --json, OORT_OUTPUT', async () => {
    const { run } = local();
    const cases: [string[], string, string][] = [
      [['keys', 'set', 'anthropic', sk], 'keys set', 'A'.repeat(12)],
      [['login', oortSk], 'login', 'B'.repeat(12)],
    ];
    for (const [args, command, secretPart] of cases) {
      for (const mode of ['text', 'json', 'env'] as const) {
        const r = await run(
          mode === 'json' ? [...args, '--json'] : args,
          mode === 'env' ? { env: { OORT_OUTPUT: 'json' } } : {},
        );
        expect(r.code).toBe(2);
        expect(r.stdout + r.stderr, `${command} ${mode}`).not.toContain(secretPart);
        expect(r.stderr).toContain('too many arguments');
        if (mode === 'text') expect(r.stdout).toBe('');
        else bad(r, command, 'usage');
      }
    }
  });

  it('a child (npm, security) never writes to stdout: it goes to stderr', async () => {
    const io = pathToFileURL(path.join(import.meta.dirname, '..', 'dist', 'io.js')).href;
    const r = await execa(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runToStderr } from ${JSON.stringify(io)}; process.exitCode = await runToStderr(process.execPath, ['-e', 'console.log("added 1 package")']);`,
      ],
      { reject: false, stdin: 'ignore' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('added 1 package');
    // No spawn in the CLI inherits stdout any more.
    const src = path.join(import.meta.dirname);
    const files = fs
      .readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      // Any stdio setting that hands the child our stdout: 'inherit' (bare or in an array, any
      // quotes), or fd 1 / process.stdout in the second slot.
      for (const m of text.matchAll(/stdio\s*:\s*(\[[^\]]*\]|['"][a-z]+['"])/g)) {
        const v = m[1]!;
        const second = v.startsWith('[') ? v.slice(1, -1).split(',')[1]?.trim() : v;
        expect(/inherit|^1$|process\.stdout/.test(second ?? ''), `${f}: ${m[0]}`).toBe(false);
      }
    }
  });

  it('a rerun fix never repeats free text: share --text gets the sentence', async () => {
    const e = cloudEnv();
    team(e);
    const r = await e.run([
      'share',
      MEM,
      '--to',
      'oort-core',
      '--text',
      'password is hunter2',
      '--json',
    ]);
    const err = bad(r, 'share', 'needs-confirmation');
    expect(err.fix).toBe('re-run the same command with --yes');
    expect(r.stdout).not.toContain('hunter2');
    // An id-only command still gets the runnable fix.
    const plain = bad(
      await e.run(['share', MEM, '--to', 'oort-core', '--json']),
      'share',
      'needs-confirmation',
    );
    expect(plain.fix).toBe(`oort share ${MEM} --to oort-core --json --yes`);
  });

  it('an error after the data (the store failing to close) prints only the failure envelope', async () => {
    const { h, run } = local();
    const base = h.wire;
    h.wire = async (dir, o) => ({
      ...(await base(dir, o)),
      close: async () => {
        throw new Error('the store did not close');
      },
    });
    const r = await run(['stats', '--json', '--debug']);
    const e = bad(r, 'stats', 'internal', 1);
    expect(e.message).toBe('the store did not close');
    expect(r.stdout.match(/"schema"/g)).toHaveLength(1);
    expect(r.stdout).not.toContain('"ok": true');
    expect(r.stderr).toMatch(/\n\s+at /);
  });

  it('--debug prints the stack of every exit-1 error, not only internal ones', async () => {
    const { h, run } = local();
    h.wire = async () => {
      throw new MissingCredentialError('TYPESAFE_API_KEY', 'decide.apiKey');
    };
    const r = await run(['stats', '--json', '--debug']);
    const e = bad(r, 'stats', 'needs-key', 1);
    expect(e.fix).toBe('oort keys set typesafe');
    expect(r.stderr).toMatch(/\n\s+at /);
    const quiet = await run(['stats', '--json']);
    expect(quiet.stderr).not.toMatch(/\n\s+at /);
  });

  it('hook, mcp and a foreground serve never print an envelope, in any case', async () => {
    const { run } = local();
    const env = { env: { OORT_OUTPUT: 'json' } };
    for (const [args, io] of [
      [['serve', '--bogus'], env],
      [['serve', '--json'], {}],
      [['serve', '--json'], env],
      [['hook', 'Stop', '--json'], {}],
      [['hook', 'Stop', '--bogus'], env],
      [['mcp', '--json'], {}],
      [['mcp', '--bogus'], env],
    ] as const) {
      const r = await run([...args], { ...io, stdin: '{}' });
      expect(r.stdout, args.join(' ')).not.toContain('oort.v1');
    }
  });

  it('OORT_OUTPUT=json leaves the hooks and MCP byte for byte as they are', async () => {
    const b = binEnv();
    const store = await openSqliteStore({
      path: path.join(b.oortHome, 'oort.sqlite'),
      coldDir: path.join(b.oortHome, 'cold'),
      dimension: 512,
      log: () => {},
    });
    await store.upsert(TG, memory({ embedding: new Int8Array(512).fill(1) }));
    await store.close();
    const prompt = JSON.stringify({
      session_id: 's1',
      cwd: b.cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'which port does the auth service listen on?',
    });
    const json = { OORT_OUTPUT: 'json' };
    const plain = await b.run(['hook', 'UserPromptSubmit'], { input: prompt });
    const enveloped = await b.run(['hook', 'UserPromptSubmit'], { input: prompt, env: json });
    expect(plain.stdout).toContain('5582');
    expect(enveloped.stdout).toBe(plain.stdout);
    expect(enveloped.code).toBe(plain.code);
    const rpc = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'contract', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n');
    const mcp = await b.run(['mcp'], { input: `${rpc}\n` });
    const mcpJson = await b.run(['mcp'], { input: `${rpc}\n`, env: json });
    expect(mcp.stdout).toContain('"tools"');
    expect(mcpJson.stdout).toBe(mcp.stdout);
  });
});

describe('oort.v1 errors: retryable and retryAfter where they are known', () => {
  it('a rate limit is retryable, with the Retry-After seconds the service sent', async () => {
    const e = cloudEnv();
    e.cloud.fail = { 'POST /v1/recall': { status: 429, code: 'rate_limit', retryAfter: '7' } };
    const err = bad(await e.run(['recall', 'deploy', '--json']), 'recall', 'refused');
    expect(err).toMatchObject({ retryable: true, retryAfter: 7 });
  });

  it('a service that is down or unreachable is retryable; retryAfter only when it was sent', async () => {
    const e = cloudEnv();
    e.cloud.fail = { 'POST /v1/recall': { status: 503, code: 'unavailable', retryAfter: '3' } };
    const busy = bad(await e.run(['recall', 'deploy', '--json']), 'recall', 'network');
    expect(busy).toMatchObject({ retryable: true, retryAfter: 3 });
    e.cloud.fail = { 'POST /v1/recall': 'network' };
    const down = bad(await e.run(['recall', 'deploy', '--json']), 'recall', 'network');
    expect(down.retryable).toBe(true);
    expect(down).not.toHaveProperty('retryAfter');
  });

  it('a local store locked by another process is retryable (internal, exit 1)', async () => {
    const { h, run } = local();
    h.wire = async () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    };
    const busy = bad(await run(['stats', '--json']), 'stats', 'internal', 1);
    expect(busy.retryable).toBe(true);
    expect(busy).not.toHaveProperty('retryAfter');
  });

  it('an error that a retry will not fix has neither field (they are optional)', async () => {
    const e = cloudEnv();
    e.cloud.fail = { 'POST /v1/recall': 402 };
    const lapsed = bad(await e.run(['recall', 'deploy', '--json']), 'recall', 'refused');
    expect(lapsed).not.toHaveProperty('retryable');
    expect(lapsed).not.toHaveProperty('retryAfter');
    const { run } = local();
    const usage = bad(await run(['recall', 'x', '--as-of', 'nope', '--json']), 'recall', 'usage');
    expect(Object.keys(usage).sort()).toEqual(['code', 'exitCode', 'fix', 'message']);
  });
});

// ---------------------------------------------------------------------------------------------

function leaves(cmd: Command): Command[] {
  return cmd.commands.length === 0 ? [cmd] : cmd.commands.flatMap(leaves);
}

describe('every command takes --json and has a contract test', () => {
  const h = harness();
  const root = program(
    { io: fakeIo({ cwd: h.cwd }), wire: h.wire, keychain: createKeychain({ platform: 'none' }) },
    () => {},
  );
  const paths = leaves(root)
    .filter((c) => !EXEMPT.has(commandPath(c)))
    .map((c) => ({ path: commandPath(c), json: hasJsonOption(c) }));
  // `serve` is one commander command with three names; status and stop take --json.
  const names = paths.flatMap((p) =>
    p.path === 'serve' ? ['serve status', 'serve stop'] : [p.path],
  );

  it('contract.every-command-but-hook-and-mcp-has---json', () => {
    expect(paths.length).toBeGreaterThan(60);
    expect(paths.filter((p) => !p.json).map((p) => p.path)).toEqual([]);
  });

  it('contract.every-command-is-listed-for-a-success-and-an-error-case', () => {
    expect([...names].sort()).toEqual([...CONTRACT].sort());
  });
});
