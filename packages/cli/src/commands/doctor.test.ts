import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from '@oortmem/claude-code';
import { harness, memory, memoryKeychain, type Harness } from '../../test/helpers.js';
import { connectHost } from '../connectors.js';
import { createKeychain, type Keychain } from '../keychain.js';
import { hostContext } from './connect.js';
import { TG } from '@oortmem/core/store-conformance';

interface Check {
  group: string;
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info' | 'unknown';
  detail: string;
  fix?: string;
}

const oortKey = (): string => ['oort', 'sk', `doctor${Date.now()}AAAAAAAAAAAA`].join('_');

/** An executable stand-in for the installed bin, so hook and MCP commands resolve. */
function fakeBin(h: Harness): string {
  const bin = path.join(h.root, 'lib', 'node_modules', 'oortmem', 'dist', 'main.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
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
) {
  const kc = keychain ?? memoryKeychain().kc;
  const io = { env: { HOME: h.root, OORT_HOME: h.home, ...env } };
  const human = await h.run(['doctor'], io, kc, { fetch: fetchFn });
  const json = await h.run(['doctor', '--json'], io, kc, { fetch: fetchFn });
  const report = JSON.parse(json.io.stdout) as { ok: boolean; checks: Check[] };
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
    expect(d.report.ok).toBe(true);
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
    expect(d.check('relay', 'relay')).toMatchObject({ status: 'ok' });
    expect(d.check('relay', 'relay')?.detail).toContain('https://relay.oortcloud.dev');
    expect(d.check('relay', 'relay')?.detail).toContain('reachable');
    expect(d.human.io.stdout.split('\n')[0]).toMatch(/^oort doctor/);
    expect(d.human.io.stdout + d.json.io.stdout).not.toContain(key);
    expect(d.human.io.stdout + d.json.io.stdout).not.toContain('test-voyage-key-for-doctor');
    expect(d.json.io.stdout.trimStart().startsWith('{')).toBe(true);
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
    expect(d.human.code).toBe(1);
    expect(d.json.code).toBe(1);
    expect(d.report.ok).toBe(false);
    expect(d.check('hooks', 'claude-code')).toMatchObject({
      status: 'fail',
      fix: 'oort install claude-code',
    });
    expect(d.check('mcp', 'cursor')).toMatchObject({ status: 'fail', fix: 'oort connect cursor' });
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
      expect(d.human.code).toBe(0);
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
      const out = JSON.parse((await pending).io.stdout) as { checks: Check[] };
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
    });
    expect(d.human.code).toBe(1);
    fs.chmodSync(file, 0o600);
    const ok = await doctor(h, {}, kc);
    expect(ok.check('keys', 'credentials')).toBeUndefined();
  });
});
