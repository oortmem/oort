import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from '@oortmem/claude-code';
import { harness, memory, memoryKeychain, type Harness, data } from '../../test/helpers.js';
import { connectHost } from '../connectors.js';
import { createKeychain, type Keychain } from '../keychain.js';
import { hostContext } from './connect.js';
import { TG } from '@oortmem/core/store-conformance';
import { VERSION, resolveConfig } from '@oortmem/core';
import {
  downgradeSqliteStore,
  listBackups,
  openSqliteStore,
  sqliteSchemaVersion,
  SCHEMA_VERSION,
} from '@oortmem/store-sqlite';
import { wire as realWire } from '../wire.js';
import { MIGRATION_PENDING_NOTE } from './hook.js';
import { consolidationCheck, unstableCopy } from './doctor.js';
import { writeUpdateCache } from '../update-check.js';

interface Check {
  group: string;
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info' | 'unknown';
  detail: string;
  fix?: string;
  fixCommand?: string;
}

const oortKey = (): string => ['oort', 'sk', `doctor${Date.now()}AAAAAAAAAAAA`].join('_');

/** An executable stand-in for the installed bin, so hook and MCP commands resolve. */
function fakeBin(h: Harness, version: string = VERSION, dir = 'lib'): string {
  const bin = path.join(h.root, dir, 'node_modules', 'oortmem', 'dist', 'main.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\necho "oort ${version}"\n`, { mode: 0o755 });
  return bin;
}

function storeFile(h: Harness): void {
  fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(h.home, 0o700);
  fs.writeFileSync(path.join(h.home, 'oort.sqlite'), '');
}

const realFetch = globalThis.fetch;

/** The relay's /health as a fake: every request it saw, and what it answers. */
function fakeRelay(answer: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: req.headers });
    return answer();
  }) as typeof fetch;
  return { seen, fetchFn };
}

async function doctor(
  h: Harness,
  env: Record<string, string> = {},
  keychain?: Keychain,
  fetchFn: typeof fetch = fakeRelay().fetchFn,
  running?: { entry: string; script: string },
) {
  const kc = keychain ?? memoryKeychain().kc;
  const io = {
    env: { HOME: h.root, OORT_HOME: h.home, ...env },
    ...(running !== undefined && { entry: running.entry }),
  };
  const deps = { fetch: fetchFn, ...(running !== undefined && { binPath: running.script }) };
  const human = await h.run(['doctor'], io, kc, deps);
  const json = await h.run(['doctor', '--json'], io, kc, deps);
  const report = data(json.io.stdout, 'doctor') as {
    status: 'ok' | 'warn' | 'fail';
    problems: number;
    checks: Check[];
  };
  return {
    human,
    json,
    report,
    check: (g: string, n: string) => report.checks.find((c) => c.group === g && c.name === n),
  };
}

let net: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // Doctor reaches the relay only through the injected fetch, never the real one.
  net = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('doctor must not use the network');
  });
});
afterEach(() => {
  expect(net).not.toHaveBeenCalled();
  net.mockRestore();
});

describe('oort doctor', () => {
  it('doctor.migrates-the-store-the-hooks-left-alone', async () => {
    const h = harness();
    h.wire = (cwd, o) => realWire(cwd, { keychain: async () => undefined, ...o });
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    const db = path.join(h.home, 'oort.sqlite');
    const { embed } = resolveConfig(h.cwd, { OORT_HOME: h.home }, { projectConfig: false });
    // A version 1 store: written by this version, then taken back down.
    const s = await openSqliteStore({
      path: db,
      coldDir: path.join(h.home, 'cold'),
      dimension: embed.dimension,
      log: () => {},
    });
    await s.upsert(TG, memory({ embedding: undefined }));
    await s.close();
    downgradeSqliteStore({ path: db });
    expect(sqliteSchemaVersion(db)).toBe(1);

    const hook = await h.run(['hook', 'UserPromptSubmit'], {
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd, prompt: 'which port?' }),
    });
    expect(hook.code).toBe(0);
    expect(hook.io.hookStdout).toBe('');
    expect(hook.io.stderr).toBe(MIGRATION_PENDING_NOTE);
    expect(sqliteSchemaVersion(db)).toBe(1);
    expect(listBackups(db, 'pre-v2')).toEqual([]);

    const d = await doctor(h);
    expect(d.human.io.stdout).toContain(
      `migrated the store from schema version 1 to ${SCHEMA_VERSION}`,
    );
    expect(sqliteSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(listBackups(db, 'pre-v2')).toHaveLength(1);
    expect(d.check('store', 'spaces')?.detail).toBe('Planet: 1 memory (every project)');
    expect(d.check('store', 'backup')?.detail).toContain('oort.sqlite.pre-v2.');
  });

  it('doctor.says-it-is-rebuilding-the-search-index (CON-110)', async () => {
    const h = harness();
    h.wire = (cwd, o) => realWire(cwd, { keychain: async () => undefined, ...o });
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    const db = path.join(h.home, 'oort.sqlite');
    const { embed } = resolveConfig(h.cwd, { OORT_HOME: h.home }, { projectConfig: false });
    const s = await openSqliteStore({
      path: db,
      coldDir: path.join(h.home, 'cold'),
      dimension: embed.dimension,
      log: () => {},
    });
    await s.upsert(TG, memory({ embedding: undefined }));
    await s.close();
    downgradeSqliteStore({ path: db, to: 3 });
    expect(sqliteSchemaVersion(db)).toBe(3);
    // The store's one-line notices go to stderr, before the migration's transaction.
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let said: string[];
    try {
      const d = await doctor(h);
      expect(d.human.io.stdout).toContain(
        `migrated the store from schema version 3 to ${SCHEMA_VERSION}`,
      );
      // An Oort started before the upgrade cannot write to the renamed index.
      expect(d.human.io.stdout).toContain('restart any Oort MCP server started before the upgrade');
    } finally {
      said = err.mock.calls.map((c) => String(c[0]));
      err.mockRestore();
    }
    expect(said).toContain('Rebuilding the search index (1 memory)…\n');
    expect(said.filter((l) => l.startsWith('Rebuilding'))).toHaveLength(1);
    expect(sqliteSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(listBackups(db, 'pre-v4')).toHaveLength(1);
  });

  it('doctor.a-hook-first-leaves-a-pre-rename-index-for-the-cli-to-repair (CON-110)', async () => {
    const h = harness();
    h.wire = (cwd, o) => realWire(cwd, { keychain: async () => undefined, ...o });
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    const db = path.join(h.home, 'oort.sqlite');
    const { embed } = resolveConfig(h.cwd, { OORT_HOME: h.home }, { projectConfig: false });
    const s = await openSqliteStore({
      path: db,
      coldDir: path.join(h.home, 'cold'),
      dimension: embed.dimension,
      log: () => {},
    });
    await s.upsert(TG, memory({ embedding: undefined }));
    await s.close();
    // A version 4 store migrated by the pre-rename build: the index still named memories_fts.
    const raw = new Database(db);
    raw.exec('ALTER TABLE memories_fts2 RENAME TO memories_fts');
    raw.close();

    const hook = await h.run(['hook', 'UserPromptSubmit'], {
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd, prompt: 'which port does auth use?' }),
    });
    expect(hook.code).toBe(0);
    expect(hook.io.stderr).toBe(MIGRATION_PENDING_NOTE);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await h.run(['recall', 'auth service port', '--json'], {
        env: { HOME: h.root, OORT_HOME: h.home },
      });
      expect(r.code, r.io.stderr).toBe(0);
      expect(r.io.stdout).toContain('5582');
    } finally {
      err.mockRestore();
    }
  });

  it('doctor.healthy-setup-passes-and-says-which-key-serves-each-role', async () => {
    const h = harness();
    const bin = fakeBin(h);
    installHooks(path.join(h.root, '.claude', 'settings.json'), bin);
    fs.mkdirSync(path.join(h.root, '.cursor'));
    const hc = hostContext({ io: { env: { HOME: h.root } } } as never);
    connectHost('cursor', hc, bin);
    storeFile(h);
    await h.store.upsert(TG, memory());
    const key = oortKey();
    const k = memoryKeychain({ 'oort.voyage': 'test-voyage-key-for-doctor' });
    const d = await doctor(h, { OORT_API_KEY: key }, k.kc);
    expect(d.human.code).toBe(0);
    expect(d.report.status).toBe('ok');
    expect(d.check('keys', 'embed')).toMatchObject({ status: 'ok' });
    expect(d.check('keys', 'embed')?.detail).toContain('Keychain oort.voyage');
    expect(d.check('keys', 'write')?.detail).toContain('Oort Pro');
    expect(d.check('keys', 'write')?.detail).toContain('OORT_API_KEY');
    expect(d.check('hooks', 'claude-code')).toMatchObject({ status: 'ok' });
    expect(d.check('mcp', 'cursor')).toMatchObject({ status: 'ok' });
    expect(d.check('mcp', 'codex')).toMatchObject({ status: 'info' });
    expect(d.check('store', 'store')).toMatchObject({ status: 'ok' });
    expect(d.check('store', 'store')?.detail).toMatch(/1 memor/);
    expect(d.check('store', 'spaces')?.detail).toBe('Planet: 1 memory (every project)');
    expect(d.check('store', 'consolidation')).toMatchObject({ status: 'info' });
    expect(d.check('store', 'consolidation')?.detail).toContain('never ran from the hooks; due');
    expect(d.check('relay', 'relay')).toMatchObject({ status: 'ok' });
    expect(d.check('relay', 'relay')?.detail).toContain('https://relay.oortcloud.dev');
    expect(d.check('relay', 'relay')?.detail).toContain('reachable');
    expect(d.human.io.stdout.split('\n')[0]).toMatch(/^oort doctor/);
    expect(d.human.io.stdout + d.json.io.stdout).not.toContain(key);
    expect(d.human.io.stdout + d.json.io.stdout).not.toContain('test-voyage-key-for-doctor');
    expect(d.json.io.stdout.trimStart().startsWith('{')).toBe(true);
  });

  it('doctor.hook-binary-of-another-version-warns-with-both-versions-and-the-path', async () => {
    const h = harness();
    const old = fakeBin(h, '0.1.0', 'old');
    installHooks(path.join(h.root, '.claude', 'settings.json'), old);
    const d = await doctor(h);
    const c = d.check('hooks', 'claude-code bin');
    expect(c).toMatchObject({ status: 'warn' });
    expect(c?.detail).toContain('0.1.0');
    expect(c?.detail).toContain(VERSION);
    expect(c?.detail).toContain(old.replace(h.root, '~'));
    expect(c?.fix).toContain('oort install claude-code');
    // One warning for one cause: the generic "another path" row is not added on top.
    expect(d.check('hooks', 'claude-code')?.status).not.toBe('warn');
    expect(d.human.io.stdout).toContain('fix: oort update, or oort install claude-code');
    expect(c?.fixCommand).toBe('oort update');
  });

  it('doctor.hook-binary-that-is-gone-fails-and-is-never-run', async () => {
    const h = harness();
    const gone = path.join(h.root, 'gone', 'node_modules', 'oortmem', 'dist', 'main.js');
    installHooks(path.join(h.root, '.claude', 'settings.json'), gone);
    const d = await doctor(h);
    expect(d.check('hooks', 'claude-code')).toMatchObject({
      status: 'fail',
      fix: 'oort install claude-code',
    });
    expect(d.check('hooks', 'claude-code')?.detail).toContain(gone);
    expect(d.check('hooks', 'claude-code bin')).toBeUndefined();
  });

  it('doctor.hook-binary-under-a-node-version-manager-gets-a-note', async () => {
    const h = harness();
    const bin = fakeBin(h, VERSION, path.join('.nvm', 'versions', 'node', 'v20.1.0', 'lib'));
    installHooks(path.join(h.root, '.claude', 'settings.json'), bin);
    const d = await doctor(h);
    const note = d.check('hooks', 'claude-code node');
    expect(note).toMatchObject({ status: 'info' });
    expect(note?.detail).toContain('switching Node versions will break');
    expect(note?.fix).toContain('stable');
    // The version still matches, so the binary row is green and doctor does not fail: the only
    // warnings are the missing keys, which exit 0 (data.status is `warn`).
    expect(d.check('hooks', 'claude-code bin')).toMatchObject({ status: 'ok' });
    expect(d.human.code).toBe(0);
    expect(d.report.status).toBe('warn');
  });

  it('doctor.hook-binary-of-this-version-is-green', async () => {
    const h = harness();
    const bin = fakeBin(h);
    installHooks(path.join(h.root, '.claude', 'settings.json'), bin);
    const d = await doctor(h);
    expect(d.check('hooks', 'claude-code bin')).toMatchObject({ status: 'ok' });
    expect(d.check('hooks', 'claude-code bin')?.detail).toContain(VERSION);
    expect(d.check('hooks', 'claude-code node')).toBeUndefined();
  });

  it('doctor.missing-key-fixes-share-one-remedy-local-models-first-never-export (CON-107)', async () => {
    const h = harness();
    // A Keychain (macOS) and a no-key-store system (OORT_NO_KEYCHAIN=1): neither says `export`.
    for (const kc of [memoryKeychain().kc, createKeychain({ platform: 'none' })]) {
      const d = await doctor(h, {}, kc);
      for (const role of ['embed', 'rerank', 'decide', 'write']) {
        const fix = d.check('keys', role)?.fix ?? '';
        expect(d.check('keys', role)?.status, role).toBe('warn');
        expect(fix, role).toContain('oort models pull');
        expect(fix, role).not.toMatch(/export [A-Z_]+_API_KEY/);
        expect(fix, role).not.toContain('=...');
        expect(fix, role).toContain('Oort Pro');
      }
      const embed = d.check('keys', 'embed')?.fix ?? '';
      // Order: free local models, then a key, then Oort Pro.
      expect(embed.indexOf('oort models pull')).toBeLessThan(embed.search(/voyage/i));
      expect(embed.search(/voyage/i)).toBeLessThan(embed.indexOf('Oort Pro'));
      // decide and write have no local model: saving needs a key or Pro even with local models.
      for (const role of ['decide', 'write']) {
        expect(d.check('keys', role)?.fix, role).toMatch(/no local model does (decide|write)/);
      }
      if (kc.supported) {
        expect(embed).toBe(
          'oort models pull (free local embed and rerank, no keys), oort keys set voyage, or oort login (Oort Pro)',
        );
        expect(d.check('keys', 'decide')?.fix).toContain('oort keys set typesafe, or oort login');
        expect(d.check('keys', 'write')?.fix).toContain('oort keys set anthropic, or oort login');
      } else {
        expect(embed).toContain('set VOYAGE_API_KEY in the environment your agent starts with');
      }
    }
  });

  it('doctor.uses-the-ui-info-mark (CON-107)', async () => {
    const h = harness();
    const d = await doctor(h);
    // Claude Code is not installed in the harness home: an info row.
    expect(d.check('hooks', 'claude-code')?.status).toBe('info');
    expect(d.human.io.stdout).toMatch(/^ {2}• claude-code/m);
    expect(d.human.io.stdout).not.toContain('·  ');
    expect(d.human.io.stdout).not.toMatch(/^ {2}· /m);
  });

  it('doctor.every-failure-has-a-one-line-fix-and-exits-1', async () => {
    const h = harness();
    const gone = path.join(h.root, 'gone', 'node_modules', 'oortmem', 'dist', 'main.js');
    installHooks(path.join(h.root, '.claude', 'settings.json'), gone);
    fs.mkdirSync(path.join(h.root, '.cursor'));
    fs.writeFileSync(
      path.join(h.root, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { oort: { type: 'stdio', command: gone, args: ['mcp'] } } }),
    );
    fs.mkdirSync(path.join(h.root, '.gemini'));
    fs.writeFileSync(path.join(h.root, '.gemini', 'settings.json'), '{ not json');
    const d = await doctor(h);
    // A failed check exits 1, in text and JSON.
    expect(d.human.code).toBe(1);
    expect(d.json.code).toBe(1);
    expect(d.report.status).toBe('fail');
    // A fix that is a command is also `fixCommand`, runnable as it is.
    expect(d.check('hooks', 'claude-code')).toMatchObject({
      status: 'fail',
      fix: 'oort install claude-code',
      fixCommand: 'oort install claude-code',
    });
    expect(d.check('mcp', 'cursor')).toMatchObject({
      status: 'fail',
      fix: 'oort connect cursor',
      fixCommand: 'oort connect cursor',
    });
    // A sentence that is not a command has no fixCommand.
    expect(d.check('mcp', 'gemini')?.fixCommand).toBeUndefined();
    expect(d.check('mcp', 'gemini')?.status).toBe('fail');
    expect(d.check('keys', 'embed')).toMatchObject({ status: 'warn' });
    expect(d.check('keys', 'embed')?.fix).toContain('oort keys set voyage');
    expect(d.check('keys', 'embed')?.fix).toContain('oort login');
    expect(d.check('relay', 'relay')?.status).toBe('info');
    for (const c of d.report.checks) {
      if (c.status === 'warn' || c.status === 'fail') {
        expect(c.fix, `${c.group} ${c.name}`).toBeTruthy();
        expect(c.fix, `${c.group} ${c.name}`).not.toContain('\n');
      }
    }
    // The human report names each fix too.
    expect(d.human.io.stdout).toContain('oort connect cursor');
  });

  it('doctor.store-not-created-yet-is-not-opened', async () => {
    const h = harness();
    const d = await doctor(h);
    expect(h.wired).toBe(0);
    expect(d.check('store', 'store')).toMatchObject({ status: 'info' });
    expect(fs.existsSync(h.home)).toBe(false);
  });

  it('doctor.flags-a-store-others-can-read', async () => {
    const h = harness();
    storeFile(h);
    fs.chmodSync(h.home, 0o755);
    const d = await doctor(h);
    expect(d.check('store', 'permissions')).toMatchObject({ status: 'warn' });
    expect(d.check('store', 'permissions')?.fix).toContain('chmod 700');
  });

  it('doctor.relay-problems-are-failures-with-a-fix', async () => {
    const h = harness();
    const bad = await doctor(h, {
      OORT_API_KEY: oortKey(),
      OORT_RELAY_URL: 'http://relay.example',
    });
    expect(bad.check('relay', 'relay')).toMatchObject({ status: 'fail' });
    expect(bad.check('relay', 'relay')?.fix).toContain('unset OORT_RELAY_URL');
    const local = await doctor(h, {
      OORT_API_KEY: oortKey(),
      OORT_RELAY_URL: 'http://127.0.0.1:8787',
    });
    expect(local.check('relay', 'relay')?.detail).toContain('http://127.0.0.1:8787');

    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(
      path.join(h.home, 'config.json'),
      JSON.stringify({ writer: { provider: 'anthropic', model: 'claude-opus-5-5' } }),
    );
    const model = await doctor(h, { OORT_API_KEY: oortKey() });
    expect(model.check('keys', 'write')).toMatchObject({ status: 'fail' });
    expect(model.check('keys', 'write')?.detail).toContain('not served by Oort Pro');
  });

  it('doctor.relay-health-reachable-sends-no-key-and-asks-/health-only', async () => {
    const h = harness();
    const key = oortKey();
    const relay = fakeRelay();
    const d = await doctor(h, { OORT_API_KEY: key }, undefined, relay.fetchFn);
    expect(d.check('relay', 'relay')).toMatchObject({ status: 'ok' });
    expect(d.check('relay', 'relay')?.detail).toMatch(/\breachable\b/);
    expect(relay.seen.map((r) => r.url)).toEqual([
      'https://relay.oortcloud.dev/health',
      'https://relay.oortcloud.dev/health',
    ]);
    for (const r of relay.seen) {
      expect(r.headers.get('authorization')).toBeNull();
      expect(r.headers.get('x-api-key')).toBeNull();
    }
    expect(d.human.io.stdout + d.json.io.stdout).not.toContain(key);
  });

  it('doctor.relay-health-unreachable-is-a-warning-with-a-fix', async () => {
    const h = harness();
    for (const answer of [
      () => Response.json({ error: 'x' }, { status: 503 }),
      () => Response.json({ nope: 1 }),
      () => new Response('<html>', { status: 200 }),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const d = await doctor(h, { OORT_API_KEY: oortKey() }, undefined, fakeRelay(answer).fetchFn);
      expect(d.check('relay', 'relay')).toMatchObject({ status: 'warn' });
      expect(d.check('relay', 'relay')?.detail).toContain('unreachable');
      expect(d.check('relay', 'relay')?.fix).toBeDefined();
      // A warning only: exit 0, data.status `warn`.
      expect(d.human.code).toBe(0);
      expect(d.report.status).toBe('warn');
    }
  });

  it('doctor.relay-health-times-out-after-3s', async () => {
    const h = harness();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let aborted = false;
      const hang = (async (_u: unknown, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as typeof fetch;
      const pending = h.run(
        ['doctor', '--json'],
        { env: { HOME: h.root, OORT_HOME: h.home, OORT_API_KEY: oortKey() } },
        memoryKeychain().kc,
        { fetch: hang },
      );
      await vi.advanceTimersByTimeAsync(2_900);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(aborted).toBe(true);
      const out = data((await pending).io.stdout) as { checks: Check[] };
      const relay = out.checks.find((c) => c.group === 'relay');
      expect(relay).toMatchObject({ status: 'warn' });
      expect(relay?.detail).toContain('3 s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('doctor.relay-health-against-a-local-fake-server', async () => {
    const h = harness();
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/health' ? '{"ok":true}' : '{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as { port: number };
      const d = await doctor(
        h,
        { OORT_API_KEY: oortKey(), OORT_RELAY_URL: `http://127.0.0.1:${port}` },
        undefined,
        realFetch,
      );
      expect(d.check('relay', 'relay')).toMatchObject({ status: 'ok' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('doctor.relay-health-is-not-probed-when-no-role-uses-the-relay', async () => {
    const h = harness();
    const relay = fakeRelay();
    const d = await doctor(h, {}, undefined, relay.fetchFn);
    expect(d.check('relay', 'relay')?.status).toBe('info');
    expect(relay.seen).toHaveLength(0);
  });

  it('doctor.a-credentials-file-wider-than-0600-fails-with-chmod', async () => {
    if (process.platform === 'win32') return;
    const h = harness();
    const file = path.join(h.home, 'credentials.json');
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(file, '{"version":1,"keys":{}}', { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    const kc = createKeychain({ platform: 'linux', env: { OORT_HOME: h.home }, warn: () => {} });
    const d = await doctor(h, {}, kc);
    expect(d.check('keys', 'credentials')).toMatchObject({
      status: 'fail',
      fix: `chmod 600 ${file}`,
      fixCommand: `chmod 600 ${file}`,
    });
    expect(d.human.code).toBe(1);
    fs.chmodSync(file, 0o600);
    const ok = await doctor(h, {}, kc);
    expect(ok.check('keys', 'credentials')).toBeUndefined();
  });
});

describe('doctor consolidation check (CON-48)', () => {
  const NOW = new Date('2026-06-01T12:00:00.000Z');
  const write = (home: string, state: Record<string, unknown>): void => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'consolidate.json'), JSON.stringify({ v: 1, ...state }));
  };

  it('doctor.consolidation-shows-the-last-run-and-what-is-due', () => {
    const h = harness();
    write(h.home, {
      lastRunAt: '2026-06-01T09:00:00.000Z',
      lastCompleteAt: '2026-06-01T09:00:00.000Z',
      lastOutcome: 'complete',
      savesSince: 50,
      last: { promoted: 2, demoted: 5, evicted: 4, expired: 1, skipped: 0, ms: 120 },
    });
    expect(consolidationCheck(h.home, NOW)).toEqual({
      group: 'store',
      name: 'consolidation',
      status: 'info',
      detail:
        'last ran 3 h ago (4 to cold, 1 expired, 3 re-tiered); next 2026-06-02T09:00:00.000Z, or after 150 more saved turns',
    });
  });

  it('doctor.consolidation-partial-and-failed-runs', () => {
    const h = harness();
    write(h.home, { lastRunAt: '2026-06-01T11:59:30.000Z', lastOutcome: 'partial' });
    expect(consolidationCheck(h.home, NOW).detail).toContain('stopped at its time budget');
    write(h.home, { lastRunAt: '2026-06-01T10:00:00.000Z', lastOutcome: 'error' });
    expect(consolidationCheck(h.home, NOW)).toMatchObject({
      status: 'warn',
      fix: 'oort consolidate',
    });
    expect(consolidationCheck(h.home, NOW).detail).toContain('the next drain retries it');
  });
});

/**
 * CON-113: doctor run from a PATH copy of oort (an npm global under fnm, reached through fnm's
 * per-shell link) while the hooks run the managed copy (~/.oort/cli).
 */
describe('doctor: the hooks and another copy of oort (CON-113)', () => {
  /** An oortmem package whose main.js answers `--version` with `version`; its realpath. */
  function copy(prefix: string, version: string): string {
    const pkg = path.join(prefix, 'lib', 'node_modules', 'oortmem');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oortmem', version }));
    const main = path.join(pkg, 'dist', 'main.js');
    fs.writeFileSync(main, `#!/bin/sh\necho "oort ${version}"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.symlinkSync(main, path.join(prefix, 'bin', 'oort'));
    return fs.realpathSync(main);
  }

  /** The managed copy with the hooks on it, and this doctor running from fnm's link. */
  function machine(hooksVersion: string = VERSION, opts: { managed?: boolean } = {}) {
    const h = harness();
    const managed = path.join(h.home, 'cli');
    const hooksBin =
      opts.managed === false
        ? copy(path.join(h.root, 'elsewhere'), hooksVersion)
        : copy(managed, hooksVersion);
    installHooks(path.join(h.root, '.claude', 'settings.json'), hooksBin);
    const install = path.join(
      h.root,
      '.local',
      'share',
      'fnm',
      'node-versions',
      'v22.15.0',
      'installation',
    );
    const script = copy(install, VERSION);
    const shells = path.join(h.root, '.local', 'state', 'fnm_multishells');
    fs.mkdirSync(shells, { recursive: true });
    fs.symlinkSync(install, path.join(shells, '51197_1793280789587'));
    const entry = path.join(shells, '51197_1793280789587', 'bin', 'oort');
    return {
      h,
      hooksBin,
      running: { entry, script },
      managedBin: path.join(managed, 'bin', 'oort'),
    };
  }

  it('doctor.same-version-from-another-path-is-ok-with-an-info-line-naming-both', async () => {
    const m = machine();
    const d = await doctor(m.h, {}, undefined, undefined, m.running);
    expect(d.check('hooks', 'claude-code')).toMatchObject({ status: 'ok' });
    expect(d.check('hooks', 'claude-code bin')).toMatchObject({ status: 'ok' });
    const info = d.check('hooks', 'claude-code copy');
    expect(info).toMatchObject({ status: 'info' });
    expect(info?.detail).toContain(m.hooksBin.replace(m.h.root, '~'));
    expect(info?.detail).toContain(m.running.entry.replace(m.h.root, '~'));
    expect(info?.detail).toContain(`another copy of oort ${VERSION}`);
    // Nothing under hooks asks to be fixed, least of all by repointing them at fnm's link.
    for (const c of d.report.checks.filter((c) => c.group === 'hooks')) {
      expect(['ok', 'info']).toContain(c.status);
    }
    expect(d.human.io.stdout).not.toContain('installed from another path');
    expect(d.human.io.stdout).not.toContain('fix: oort install claude-code');
  });

  it('doctor.a-transient-running-copy-is-never-suggested-for-the-hooks', async () => {
    const m = machine();
    // One event missing: the hooks need reinstalling, but not from this fnm shell's copy.
    const file = path.join(m.h.root, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks['Stop'];
    fs.writeFileSync(file, JSON.stringify(settings));
    const d = await doctor(m.h, {}, undefined, undefined, m.running);
    const row = d.check('hooks', 'claude-code');
    expect(row).toMatchObject({ status: 'warn' });
    expect(row?.fix).toContain(
      "~/oort-home/cli/bin/oort install claude-code (this oort is in fnm's link for this shell)",
    );
    expect(row?.fix).not.toMatch(/^oort install claude-code/);
    expect(row?.fixCommand).toBe(`${m.managedBin} install claude-code`);
    expect(row?.fixCommand).not.toContain('fnm_multishells');
  });

  it('doctor.with-no-managed-copy-the-fix-installs-it-first', async () => {
    const m = machine(VERSION, { managed: false });
    const file = path.join(m.h.root, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks['Stop'];
    fs.writeFileSync(file, JSON.stringify(settings));
    const d = await doctor(m.h, {}, undefined, undefined, m.running);
    const row = d.check('hooks', 'claude-code');
    expect(row?.fix).toContain(
      'npm i -g --prefix ~/oort-home/cli oortmem && ~/oort-home/cli/bin/oort install claude-code',
    );
    expect(row?.fixCommand).toBe(
      `npm i -g --prefix ${path.join(m.h.home, 'cli')} oortmem && ${m.managedBin} install claude-code`,
    );
  });

  it('doctor.a-different-version-still-warns', async () => {
    const m = machine('0.1.0');
    const d = await doctor(m.h, {}, undefined, undefined, m.running);
    const bin = d.check('hooks', 'claude-code bin');
    expect(bin).toMatchObject({ status: 'warn', fixCommand: 'oort update' });
    expect(bin?.detail).toContain('0.1.0');
    expect(bin?.detail).toContain(VERSION);
    expect(bin?.fix).toContain('oort update, or ~/oort-home/cli/bin/oort install claude-code');
    expect(d.check('hooks', 'claude-code copy')).toBeUndefined();
  });

  it('doctor.unstable-copies-are-caches-temp-dirs-fnm-links-and-version-managers', () => {
    const tmp = '/private/var/folders/T';
    expect(
      unstableCopy('/usr/local/bin/oort', '/usr/local/lib/node_modules/oortmem/dist/main.js', tmp),
    ).toBeUndefined();
    expect(
      unstableCopy(undefined, '/Users/x/.oort/cli/lib/node_modules/oortmem/dist/main.js', tmp),
    ).toBeUndefined();
    expect(
      unstableCopy(undefined, '/Users/x/.npm/_npx/1/node_modules/oortmem/dist/main.js', tmp),
    ).toBe('a package cache');
    expect(
      unstableCopy(undefined, '/Users/x/Library/Caches/pnpm/dlx/1/oortmem/dist/main.js', tmp),
    ).toBe('a package cache');
    expect(unstableCopy(undefined, `${tmp}/x/oortmem/dist/main.js`, tmp)).toBe(
      'a temporary directory',
    );
    expect(unstableCopy('/Users/x/.local/state/fnm_multishells/1_2/bin/oort', undefined, tmp)).toBe(
      "fnm's link for this shell",
    );
    expect(
      unstableCopy(
        undefined,
        '/Users/x/.nvm/versions/node/v22/lib/node_modules/oortmem/dist/main.js',
        tmp,
      ),
    ).toBe('a Node version manager');
  });

  it('doctor.shows-an-available-update-as-an-info-line-never-in-json', async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    writeUpdateCache(h.home, { checkedAt: Date.now(), latest: '99.0.0' });
    const d = await doctor(h);
    expect(d.human.io.stdout).toContain(`Oort 99.0.0 is available (you have ${VERSION})`);
    expect(d.human.io.stdout).toContain('try: oort update');
    expect(d.json.io.stdout).not.toContain('99.0.0');
    // Off: no line at all.
    const off = await doctor(h, { OORT_NO_UPDATE_CHECK: '1' });
    expect(off.human.io.stdout).not.toContain('99.0.0');
    // Doctor never starts a check itself.
    expect(d.human.io.updateChecks).toBe(0);
  });
});
