import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Database from 'better-sqlite3';
import { execa } from 'execa';
import { fakeSite } from '../test/fake-site.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OortConfig, projectIdFor, type Memory } from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { memory, syntheticKey, tmpdir, writeTranscript } from '../test/helpers.js';
import { TG } from '@oortmem/core/store-conformance';
import { localGrant } from '@oortmem/core';

/** The built bin; these tests run it as a real process, so build first. */
const BIN = path.join(import.meta.dirname, '..', 'dist', 'main.js');

// Most tests start a process or several; on a loaded machine (a load average of 100+) one start
// can take seconds. The timeouts here only catch a hang, so they are generous.
vi.setConfig({ testTimeout: 120_000 });

interface Sandbox {
  root: string;
  /** A temp HOME, never the real one. */
  home: string;
  oortHome: string;
  cwd: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = tmpdir('oort-bin-');
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
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      OORT_HOME: oortHome,
      // The real bin must never reach the real Keychain from a test.
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

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to stdin (which is otherwise /dev/null, as for a non-interactive run). */
  input?: string;
}

function oort(s: Sandbox, args: string[], opts: RunOptions = {}) {
  return execa(BIN, args, {
    cwd: opts.cwd ?? s.cwd,
    env: opts.env ?? s.env,
    extendEnv: false,
    reject: false,
    timeout: 60_000,
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: 'ignore' as const }),
  });
}

beforeAll(() => {
  if (!fs.existsSync(BIN))
    throw new Error(`${BIN} is missing: run \`pnpm --filter oort build\` first`);
});

describe('oort bin', () => {
  it('cli.init-creates-config', async () => {
    const s = sandbox();
    const r = await oort(s, ['init']);
    expect(r.exitCode).toBe(0);
    const file = path.join(s.oortHome, 'config.json');
    expect(r.stdout).toContain(`Created ${file}`);
    expect(fs.statSync(s.oortHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(OortConfig.parse({}));
    for (const v of ['VOYAGE_API_KEY', 'TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(r.stdout).toContain(`export ${v}=`);
    }

    // Never overwritten.
    fs.writeFileSync(file, '{"recall":{"returnK":3}}\n');
    const again = await oort(s, ['init']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('Kept existing');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"recall":{"returnK":3}}\n');

    // --project writes the project file at the git root.
    fs.mkdirSync(path.join(s.cwd, '.git'));
    fs.mkdirSync(path.join(s.cwd, 'sub'));
    const proj = await oort(s, ['init', '--project'], { cwd: path.join(s.cwd, 'sub') });
    expect(proj.exitCode).toBe(0);
    const projectFile = path.join(s.cwd, 'oort.config.json');
    expect(proj.stdout).toContain(projectFile);
    expect(JSON.parse(fs.readFileSync(projectFile, 'utf8'))).toEqual({
      project: { private: false },
    });
  });

  it('cli.recall-without-key-names-fix', async () => {
    const s = sandbox();
    const store = await openSqliteStore({
      path: path.join(s.oortHome, 'oort.sqlite'),
      coldDir: path.join(s.oortHome, 'cold'),
      dimension: 512,
      log: () => {},
    });
    await store.upsert(TG, memory({ embedding: new Int8Array(512).fill(3) }));
    await store.close();

    const r = await oort(s, ['recall', 'which port does the auth service listen on']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('<oort-memory>');
    expect(r.stdout).toContain('port 5582');
    expect(r.stderr).toContain('VOYAGE_API_KEY');
    expect(r.stderr).toContain('oort keys set voyage');
    expect(r.stderr).not.toContain('config.json');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).not.toContain('5582');

    const json = await oort(s, ['recall', 'auth service port', '--json']);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      memories: { explanation: unknown }[];
      degraded: string[];
    };
    expect(parsed.degraded).toEqual(['no-embedder', 'no-reranker']);
    expect(parsed.memories[0]?.explanation).toMatchObject({ lexicalRank: 1, hydrated: false });
  });

  it('cli.import-estimate-asks-before-running', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.cwd, '.git'));
    const projects = path.join(s.home, '.claude', 'projects');
    writeTranscript(projects, s.cwd);
    const env = {
      ...s.env,
      VOYAGE_API_KEY: syntheticKey('voyage'),
      TYPESAFE_API_KEY: syntheticKey('typesafe'),
      ANTHROPIC_API_KEY: syntheticKey('anthropic'),
    };

    const r = await oort(s, ['import', 'claude-code', '--since', '3650d'], { env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/sessions\s+1\n/);
    expect(r.stdout).toMatch(/observations\s+[1-9]/);
    expect(r.stdout).toMatch(/estimated tokens\s+[1-9]/);
    expect(r.stdout).toMatch(/skipped \(unresolved\)\s+0/);
    expect(r.stderr).toMatch(/not a terminal.*--yes/);
    for (const k of Object.values(env))
      if (k.startsWith('test-')) expect(r.stdout + r.stderr).not.toContain(k);

    const est = await oort(s, ['import', 'claude-code', '--estimate-only'], { env });
    expect(est.exitCode).toBe(0);
    expect(est.stdout).toBe(r.stdout.replace(/ since \S+:/, ':'));

    // Nothing was observed.
    const store = await openSqliteStore({
      path: path.join(s.oortHome, 'oort.sqlite'),
      coldDir: path.join(s.oortHome, 'cold'),
      dimension: 512,
      log: () => {},
    });
    const all = await store.list(
      localGrant({
        orgId: 'local',
        customerId: 'self',
        agentId: 'claude-code',
        projectIds: [null, projectIdFor(s.cwd) ?? null],
      }),
      { validOnly: false },
    );
    await store.close();
    expect(all).toEqual([]);

    // Without keys the import refuses after the estimate, naming each fix.
    const keyless = await oort(s, ['import', 'claude-code', '--yes']);
    expect(keyless.exitCode).toBe(2);
    expect(keyless.stdout).toMatch(/observations\s+[1-9]/);
    expect(keyless.stderr).toContain('oort keys set typesafe');
  });

  it('cli.hook-exit-zero-on-garbage-stdin', async () => {
    const s = sandbox();
    const r = await oort(s, ['hook', 'UserPromptSubmit'], { input: '{not json \\u0000 \x00\xff' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.durationMs).toBeLessThan(1000);
    const log = fs.readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8');
    expect(log).toContain('"outcome":"invalid-input"');

    const unknown = await oort(s, ['hook', 'NoSuchEvent'], { input: '{}' });
    expect(unknown.exitCode).toBe(0);
    expect(unknown.stdout).toBe('');
  });

  it('cli.hook-loads-only-the-hook-path (CON-51)', async () => {
    const s = sandbox();
    // Records every module the bin resolves, written out when the process exits.
    const recorder = path.join(s.root, 'record.mjs');
    const loaded = path.join(s.root, 'loaded.txt');
    fs.writeFileSync(
      recorder,
      [
        "import { registerHooks } from 'node:module';",
        "import { writeFileSync } from 'node:fs';",
        'const seen = [];',
        'registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.push(r.url); return r; } });',
        "process.on('exit', () => writeFileSync(process.env.LOADED, seen.join('\\n')));",
      ].join('\n'),
    );
    const input = JSON.stringify({ session_id: 's1', cwd: s.cwd, source: 'startup' });
    const r = await execa(
      process.execPath,
      ['--import', pathToFileURL(recorder).href, BIN, 'hook', 'SessionStart'],
      {
        cwd: s.cwd,
        env: { ...s.env, LOADED: loaded },
        extendEnv: false,
        reject: false,
        timeout: 60_000,
        input,
      },
    );
    expect(r.exitCode).toBe(0);
    const urls = fs.readFileSync(loaded, 'utf8').split('\n');
    expect(urls.some((u) => u.endsWith('/commands/hook.js'))).toBe(true);
    // No argument parser and no other command: their imports are what a hook used to pay for.
    for (const u of urls) {
      expect(u).not.toMatch(
        /\/commander\/|\/program\.js$|\/commands\/(?!hook\.js$)|modelcontextprotocol/,
      );
    }
    expect(fs.readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8')).toContain(
      '"event":"SessionStart"',
    );
  });

  it('cli.hook-loads-chrono-only-for-a-date-cue (CON-82)', async () => {
    const s = sandbox();
    await seed(s, [memory({ embedding: new Int8Array(512).fill(3) })]);
    const recorder = path.join(s.root, 'record.mjs');
    fs.writeFileSync(
      recorder,
      [
        "import { registerHooks } from 'node:module';",
        "import { writeFileSync } from 'node:fs';",
        'const seen = [];',
        'registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.push(r.url); return r; } });',
        "process.on('exit', () => writeFileSync(process.env.LOADED, seen.join('\\n')));",
      ].join('\n'),
    );
    const resolved = async (prompt: string): Promise<string[]> => {
      const loaded = path.join(s.root, `loaded-${prompt.length}.txt`);
      const r = await execa(
        process.execPath,
        ['--import', pathToFileURL(recorder).href, BIN, 'hook', 'UserPromptSubmit'],
        {
          cwd: s.cwd,
          env: { ...s.env, LOADED: loaded },
          extendEnv: false,
          reject: false,
          timeout: 60_000,
          input: JSON.stringify({
            session_id: 's1',
            cwd: s.cwd,
            hook_event_name: 'UserPromptSubmit',
            prompt,
          }),
        },
      );
      expect(r.exitCode).toBe(0);
      return fs.readFileSync(loaded, 'utf8').split('\n');
    };
    // A prompt without a date recalls without ever resolving chrono-node.
    const plain = await resolved('which port does the auth service listen on?');
    expect(plain.some((u) => u.endsWith('/temporal.js'))).toBe(true);
    expect(plain.filter((u) => u.includes('chrono-node'))).toEqual([]);
    // A dated one loads it, from the built bin, on demand.
    const dated = await resolved('which port did the auth service use on 2 April 2026?');
    expect(dated.some((u) => u.includes('/chrono-node/'))).toBe(true);
    const log = fs.readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8');
    expect(log).not.toContain('error');
  });

  it('cli.hook-yields-when-store-locked', async () => {
    const s = sandbox();
    const dbPath = path.join(s.oortHome, 'oort.sqlite');
    const store = await openSqliteStore({
      path: dbPath,
      coldDir: path.join(s.oortHome, 'cold'),
      dimension: 512,
      log: () => {},
    });
    await store.upsert(TG, memory({ embedding: new Int8Array(512).fill(3) }));
    await store.close();
    // Another process (say, a drain) holds the write lock for the whole hook run.
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const r = await oort(s, ['hook', 'UserPromptSubmit'], {
        input: JSON.stringify({
          session_id: 's-locked',
          cwd: s.cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'which port does the auth service listen on?',
        }),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.durationMs).toBeLessThan(1500);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    const log = fs.readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8');
    expect(log).toContain('"outcome":"degraded:busy"');
  });

  it('cli.hook-exits-promptly-with-slow-adapters', async () => {
    const s = sandbox();
    await seed(s, [memory({ embedding: new Int8Array(512).fill(3) })]);
    const preload = path.join(import.meta.dirname, '..', 'test', 'preload-never-fetch.mjs');
    const r = await oort(s, ['hook', 'UserPromptSubmit'], {
      env: {
        ...s.env,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        VOYAGE_API_KEY: syntheticKey('voyage'),
      },
      input: JSON.stringify({
        session_id: 's-slow',
        cwd: s.cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'which port does the auth service listen on?',
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeLessThan(3500);
    // The embed never answers; the lexical fallback still injects context.
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('port 5582');
    const log = fs.readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8');
    expect(log).toContain('"timeout"');
  });

  it('cli.epipe-exits-quietly', async () => {
    const s = sandbox();
    await seed(
      s,
      Array.from({ length: 600 }, (_, i) =>
        memory({
          text: `fact number ${i} `.repeat(20),
          embedding: new Int8Array(512).fill(i % 100),
        }),
      ),
    );
    // Like `oort export | head -n 1`: the reader closes after the first line.
    const child = spawn(BIN, ['export'], {
      cwd: s.cwd,
      env: s.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    let first = '';
    child.stdout.on('data', (d: Buffer) => {
      first += d.toString();
      if (first.includes('\n')) child.stdout.destroy();
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(first.split('\n')[0]).toMatch(/^\{"oort":"export"/);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('cli.doctor-json-reports-every-group-and-creates-nothing', async () => {
    const s = sandbox();
    const r = await oort(s, ['doctor', '--json']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { ok: boolean; checks: { group: string }[] };
    expect(report.ok).toBe(true);
    expect([...new Set(report.checks.map((c) => c.group))]).toEqual([
      'keys',
      'hooks',
      'serve',
      'mcp',
      'store',
      'relay',
      'cloud',
    ]);
    expect(fs.existsSync(s.oortHome)).toBe(false);
  });

  it('cli.login-refuses-before-any-request-while-the-keychain-is-off', async () => {
    const s = sandbox();
    const site = await fakeSite({ approveAtPoll: 1 });
    try {
      const r = await execa(BIN, ['login'], {
        cwd: s.cwd,
        env: { ...s.env, OORT_SITE_URL: site.url },
        extendEnv: false,
        reject: false,
        stdin: 'ignore',
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('OORT_NO_KEYCHAIN=1');
      expect(site.polls).toEqual([]);
      const out = await execa(BIN, ['logout'], {
        cwd: s.cwd,
        env: s.env,
        extendEnv: false,
        reject: false,
        stdin: 'ignore',
      });
      expect(out.exitCode).toBe(2);
    } finally {
      await site.close();
    }
  });

  it('cli.install-refuses-without-bin', async () => {
    const s = sandbox();
    const settings = path.join(s.home, '.claude', 'settings.json');

    // Not started as the bin: `node -e "import(...)"`.
    const evalRun = await execa(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(BIN).href)})`,
        'install',
        'claude-code',
      ],
      { cwd: s.cwd, env: s.env, extendEnv: false, reject: false, stdin: 'ignore' },
    );
    expect(evalRun.exitCode).toBe(2);
    expect(evalRun.stderr).toContain('npm i -g oortmem');
    expect(evalRun.stderr).toMatch(/not running as its bin/);
    expect(fs.existsSync(settings)).toBe(false);

    // A copy in a temporary package cache, as `npx oortmem` would run it.
    const cache = path.join(s.root, '_npx', 'abc123', 'node_modules', 'oortmem');
    fs.mkdirSync(cache, { recursive: true });
    fs.cpSync(path.dirname(BIN), path.join(cache, 'dist'), { recursive: true });
    fs.copyFileSync(
      path.join(path.dirname(BIN), '..', 'package.json'),
      path.join(cache, 'package.json'),
    );
    fs.symlinkSync(
      path.join(path.dirname(BIN), '..', 'node_modules'),
      path.join(cache, 'node_modules'),
    );
    const cached = await execa(path.join(cache, 'dist', 'main.js'), ['install', 'claude-code'], {
      cwd: s.cwd,
      env: s.env,
      extendEnv: false,
      reject: false,
      stdin: 'ignore',
    });
    expect(cached.exitCode).toBe(2);
    expect(cached.stderr).toMatch(/temporary package cache/);
    expect(fs.existsSync(settings)).toBe(false);
  });

  it('cli.install-uninstall-roundtrip', async () => {
    const s = sandbox();
    const settings = path.join(s.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = {
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    };
    fs.writeFileSync(settings, JSON.stringify(original, null, 2));
    const bin = fs.realpathSync(BIN);

    const r = await oort(s, ['install', 'claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(settings);
    const installed = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
      theme: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(installed.theme).toBe('dark');
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionStart']) {
      const commands = (installed.hooks[event] ?? []).flatMap((g) => g.hooks.map((x) => x.command));
      expect(commands).toContain(`${bin} hook ${event}`);
    }
    expect(JSON.stringify(installed)).not.toContain('npx');
    expect(installed.hooks['Stop']?.[0]?.hooks[0]?.command).toBe('echo done');

    const again = await oort(s, ['install', 'claude-code']);
    expect(again.stdout).toMatch(/already installed/);

    const un = await oort(s, ['uninstall', 'claude-code']);
    expect(un.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(original);

    // --project targets <cwd>/.claude/settings.json.
    const proj = await oort(s, ['install', 'claude-code', '--project']);
    expect(proj.exitCode).toBe(0);
    expect(fs.existsSync(path.join(s.cwd, '.claude', 'settings.json'))).toBe(true);
  });

  it('cli.install-prints-the-hook-binary-and-notes-a-different-oort-on-path', async () => {
    const s = sandbox();
    const bin = fs.realpathSync(BIN);
    // A PATH with only node on it, so no real oort on this machine is ahead of the fake one.
    const nodeOnly = path.join(s.root, 'node-only');
    fs.mkdirSync(nodeOnly);
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    s.env['PATH'] = nodeOnly;
    const first = await oort(s, ['install', 'claude-code']);
    expect(first.stdout).toContain(`Hook binary: ${bin}`);
    expect(first.stdout).not.toContain('first on your PATH');

    // A different oort ahead on PATH is named, with how to switch.
    const other = path.join(s.root, 'other-bin');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'oort'), '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    s.env['PATH'] = `${other}${path.delimiter}${s.env['PATH'] ?? ''}`;
    const second = await oort(s, ['install', 'claude-code']);
    expect(second.stdout).toContain(
      `Another oort comes first on your PATH: ${fs.realpathSync(path.join(other, 'oort'))}`,
    );
    expect(second.stdout).toContain(`Hook binary: ${bin}`);

    // The same oort on PATH (a symlink to this bin) is not a difference.
    fs.rmSync(path.join(other, 'oort'));
    fs.symlinkSync(bin, path.join(other, 'oort'));
    const third = await oort(s, ['install', 'claude-code']);
    expect(third.stdout).not.toContain('first on your PATH');
  });

  it('cli.mcp-stdio-serves-tools-scoped-to-the-start-directory', async () => {
    const s = sandbox();
    const repo = path.join(s.root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    // A repository file cannot choose the scope without `oort project link`.
    fs.writeFileSync(path.join(repo, 'oort.config.json'), '{"project":{"id":"stolen"}}\n');
    const derived = projectIdFor(repo);

    const whoami = async (args: string[], cwd: string): Promise<Record<string, unknown>> => {
      const transport = new StdioClientTransport({
        command: BIN,
        args,
        cwd,
        env: s.env,
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      const client = new Client({ name: 'oort-bin-test', version: '0.0.0' });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(9);
        const r = await client.callTool({ name: 'whoami', arguments: {} });
        const content = r.content as { text: string }[];
        const recall = await client.callTool({ name: 'recall', arguments: { query: 'anything' } });
        expect(recall.isError).not.toBe(true);
        return { ...(JSON.parse(content[0]?.text ?? '{}') as object), stderr };
      } finally {
        await client.close();
      }
    };

    const fromCwd = await whoami(['mcp'], repo);
    expect(fromCwd['project']).toBe(derived);
    expect(fromCwd['project']).not.toContain('stolen');
    expect(fromCwd['stderr']).toContain('oort project link');

    const fromFlag = await whoami(['mcp', '--project', repo], s.cwd);
    expect(fromFlag['project']).toBe(derived);

    const global = await whoami(['mcp'], s.cwd);
    expect(global['project']).toBeNull();
  });

  it('cli.connect-disconnect-roundtrip', async () => {
    const s = sandbox();
    const bin = fs.realpathSync(BIN);
    const cursor = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    const original = '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n';
    fs.writeFileSync(cursor, original);
    const codex = path.join(s.home, '.codex', 'config.toml');

    const r = await oort(s, ['connect', 'cursor', 'codex']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('oort connect cursor');
    expect(r.stdout).toContain('+ mcpServers.oort.command');
    expect(r.stdout).toContain('+ mcp_servers.oort.args');
    expect(r.stdout).toContain('~/.cursor/mcp.json.oort-backup');
    expect(r.stdout).toContain('oort disconnect cursor');
    const entry = (
      JSON.parse(fs.readFileSync(cursor, 'utf8')) as { mcpServers: Record<string, unknown> }
    ).mcpServers['oort'];
    expect(entry).toEqual({
      type: 'stdio',
      command: bin,
      args: ['mcp', '--agent', 'cursor', '--project', '${workspaceFolder}'],
    });
    expect(fs.readFileSync(codex, 'utf8')).toContain(`command = ${JSON.stringify(bin)}`);

    const again = await oort(s, ['connect', 'cursor']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/already connected/);
    expect(again.stdout).toContain('new memories go to your Planet');

    // --star (CON-62): the entry stays as it is; agents.json records the Star.
    const star = await oort(s, ['connect', 'cursor', '--star']);
    expect(star.exitCode).toBe(0);
    expect(star.stdout).toContain('Cursor now keeps its new memories in its own Star');
    expect(star.stdout).toContain('new memories stay in Star cursor');
    const agents = path.join(s.oortHome, 'agents.json');
    expect(JSON.parse(fs.readFileSync(agents, 'utf8'))).toEqual({
      version: 1,
      agents: { cursor: { star: true } },
    });
    expect(fs.statSync(agents).mode & 0o777).toBe(0o600);
    const planet = await oort(s, ['connect', 'cursor', '--no-star']);
    expect(planet.stdout).toContain('Cursor now writes new memories to your Planet');

    const un = await oort(s, ['disconnect', 'cursor', 'codex']);
    expect(un.exitCode).toBe(0);
    expect(fs.readFileSync(cursor, 'utf8')).toBe(original);
    expect(fs.readFileSync(codex, 'utf8')).toBe('');
  });

  it('cli.install-cursor-and-codex-add-the-mcp-server (CON-18)', async () => {
    const s = sandbox();
    const bin = fs.realpathSync(BIN);
    const cursor = path.join(s.home, '.cursor', 'mcp.json');
    const codex = path.join(s.home, '.codex', 'config.toml');
    for (const harness of ['cursor', 'codex']) {
      const r = await oort(s, ['install', harness]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`oort connect ${harness}`);
    }
    const entry = (
      JSON.parse(fs.readFileSync(cursor, 'utf8')) as { mcpServers: Record<string, unknown> }
    ).mcpServers['oort'];
    expect(entry).toEqual({
      type: 'stdio',
      command: bin,
      args: ['mcp', '--agent', 'cursor', '--project', '${workspaceFolder}'],
    });
    const toml = fs.readFileSync(codex, 'utf8');
    expect(toml).toContain('[mcp_servers.oort]');
    expect(toml).toContain(`command = ${JSON.stringify(bin)}`);

    const project = await oort(s, ['install', 'cursor', '--project']);
    expect(project.exitCode).toBe(2);
    const unknown = await oort(s, ['install', 'emacs']);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('expected one of');

    for (const harness of ['cursor', 'codex']) {
      expect((await oort(s, ['uninstall', harness])).exitCode).toBe(0);
    }
    expect(fs.readFileSync(cursor, 'utf8')).not.toContain('"oort"');
    expect(fs.readFileSync(codex, 'utf8')).not.toContain('mcp_servers.oort');
  });

  it('cli.setup-yes-connects-and-runs-the-demo', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.claude'));
    fs.mkdirSync(path.join(s.home, '.codex'));
    const r = await oort(s, [
      'setup',
      '--yes',
      '--agents',
      'claude-code,codex',
      '--keys',
      'byo',
      '--import',
      'skip',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('\u001b[');
    expect(r.stdout).toContain('6/6 Done');
    expect(r.stdout).toMatch(/recalled it/);
    const bin = fs.realpathSync(BIN);
    expect(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8')).toContain(
      `${bin} hook Stop`,
    );
    expect(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8')).toContain(bin);
    // Nothing from the demo is left in the store.
    const db = new Database(path.join(s.oortHome, 'oort.sqlite'), { readonly: true });
    const n = db.prepare('select count(*) as n from memories').get() as { n: number };
    db.close();
    expect(n.n).toBe(0);

    // Without --yes and without a terminal it never prompts.
    const refused = await oort(s, ['setup']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('--yes');
  });
});
