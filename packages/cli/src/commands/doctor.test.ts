import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from '@oortmem/claude-code';
import { harness, memory, memoryKeychain, type Harness } from '../../test/helpers.js';
import { connectHost } from '../connectors.js';
import type { Keychain } from '../keychain.js';
import { hostContext } from './connect.js';

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

async function doctor(h: Harness, env: Record<string, string> = {}, keychain?: Keychain) {
  const kc = keychain ?? memoryKeychain().kc;
  const human = await h.run(['doctor'], { env: { HOME: h.root, OORT_HOME: h.home, ...env } }, kc);
  const json = await h.run(
    ['doctor', '--json'],
    { env: { HOME: h.root, OORT_HOME: h.home, ...env } },
    kc,
  );
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
  // Doctor makes no request: the relay has no health endpoint to ask.
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
    await h.store.upsert(memory());
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
    expect(d.check('relay', 'relay')).toMatchObject({ status: 'unknown' });
    expect(d.check('relay', 'relay')?.detail).toContain('https://relay.oortcloud.dev');
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
});
