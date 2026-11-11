import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { fakeCloud, fakeMemory } from '../../test/helpers/fake-cloud.js';
import { data, failed, fakeIo, harness, tmpdir } from '../../test/helpers.js';
import { writeCloudSettings } from '../cloud.js';
import { createKeychain } from '../keychain.js';
import { runCli } from '../program.js';
import { wire as realWire, type WireFn } from '../wire.js';
import {
  OPEN_TARGETS,
  noBrowserReason,
  openableUrl,
  openerCommand,
  pageUrl,
  systemOpener,
  type OpenDeps,
} from './open.js';

/**
 * CON-107: `oort open [target]` opens the right oortcloud.dev page. It never opens anything in
 * these tests: every run that could reach a browser passes a fake opener, and the rest have no
 * terminal on stdout.
 */

const MEM = '22222222-3333-4444-8555-666666666666';
const SITE = 'https://oortcloud.dev';

/** A fake opener that records what it was asked to open and answers `ok`. */
function opener(ok = true): OpenDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    platform: 'darwin',
    opener: async (url) => {
      opened.push(url);
      return ok;
    },
  };
}

const TERMINAL = { tty: true, stdoutTTY: true } as const;

describe('oort open: the URL', () => {
  it('open.urls-only-oortcloud-dev-or-loopback', () => {
    for (const ok of [
      `${SITE}/dashboard`,
      `${SITE}/dashboard/memories/${MEM}`,
      'http://localhost:3000/docs',
      'http://127.0.0.1:8787/account',
      'https://[::1]/dashboard',
    ]) {
      expect(openableUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://oortcloud.dev/dashboard',
      'https://oortcloud.dev.example.com/dashboard',
      'https://example.com/dashboard',
      'https://oortcloud.dev:8443/dashboard',
      'https://user:pw@oortcloud.dev/dashboard',
      'https://oortcloud.dev/dashboard?next=https://example.com',
      'https://oortcloud.dev/dashboard#x',
      'https://oortcloud.dev/a b',
      'https://oortcloud.dev/a/../b',
      'https://oortcloud.dev/%2e%2e/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '"; rm -rf ~',
    ]) {
      expect(openableUrl(bad), bad).toBe(false);
    }
  });

  it('open.each-target-has-its-page', () => {
    const urls = Object.fromEntries(
      OPEN_TARGETS.filter((t) => t !== 'memory').map((t) => [t, pageUrl({}, t)]),
    );
    expect(urls).toEqual({
      dashboard: `${SITE}/dashboard`,
      'star-map': `${SITE}/dashboard/star-map`,
      account: `${SITE}/account`,
      docs: `${SITE}/docs`,
      quickstart: `${SITE}/docs/quickstart`,
    });
    expect(pageUrl({}, 'memory', MEM.toUpperCase())).toBe(`${SITE}/dashboard/memories/${MEM}`);
    expect(() => pageUrl({}, 'memory', '1b2c3d4e')).toThrow(/full memory id/);
  });

  it('open.site-url-localhost-for-development-anything-else-refused', () => {
    expect(pageUrl({ OORT_SITE_URL: 'http://localhost:3000' }, 'docs')).toBe(
      'http://localhost:3000/docs',
    );
    expect(() => pageUrl({ OORT_SITE_URL: 'https://staging.example.com' }, 'docs')).toThrow(
      /oortcloud.dev only/,
    );
  });
});

describe('oort open: when no browser starts', () => {
  const io = (env: Record<string, string> = {}, stdoutTTY = true) =>
    fakeIo({ cwd: '/', env, stdoutTTY });

  it('open.no-browser-without-a-terminal-display-or-with-BROWSER-none', () => {
    expect(noBrowserReason(io({}, false), 'darwin')).toBe('stdout is not a terminal');
    expect(noBrowserReason(io({ BROWSER: 'none' }), 'darwin')).toBe('BROWSER=none');
    expect(noBrowserReason(io({ CI: 'true' }), 'darwin')).toBe('CI is set');
    expect(noBrowserReason(io({ CI: 'false' }), 'darwin')).toBeUndefined();
    expect(noBrowserReason(io({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }), 'darwin')).toBe(
      'this is an SSH session',
    );
    expect(noBrowserReason(io({}), 'linux')).toMatch(/no display/);
    expect(noBrowserReason(io({ DISPLAY: ':0' }), 'linux')).toBeUndefined();
    expect(noBrowserReason(io({ WAYLAND_DISPLAY: 'wayland-0' }), 'linux')).toBeUndefined();
    expect(noBrowserReason(io({}), 'darwin')).toBeUndefined();
    expect(noBrowserReason(io({}), 'win32')).toBeUndefined();
  });

  it('open.opener-is-one-argument-never-a-shell', () => {
    const url = `${SITE}/docs`;
    expect(openerCommand(url, 'darwin', {})).toEqual(['open', [url]]);
    expect(openerCommand(url, 'linux', {})).toEqual(['xdg-open', [url]]);
    expect(openerCommand(url, 'win32', {})).toEqual([
      'rundll32',
      ['url.dll,FileProtocolHandler', url],
    ]);
    expect(openerCommand(url, 'linux', { BROWSER: 'w3m' })).toEqual(['w3m', [url]]);
  });

  it('open.system-opener-spawns-without-a-shell-and-reports-failure', async () => {
    const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const fake = (behave: (child: EventEmitter) => void) =>
      ((file: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ file, args, opts });
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        queueMicrotask(() => behave(child));
        return child;
      }) as never;
    const url = `${SITE}/dashboard`;
    expect(
      await systemOpener(
        'darwin',
        {},
        fake((c) => c.emit('exit', 0)),
      )(url),
    ).toBe(true);
    expect(calls[0]).toEqual({
      file: 'open',
      args: [url],
      opts: { stdio: 'ignore', detached: true, shell: false },
    });
    expect(
      await systemOpener(
        'linux',
        {},
        fake((c) => c.emit('exit', 3)),
      )(url),
    ).toBe(false);
    const enoent = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
    expect(
      await systemOpener(
        'linux',
        {},
        fake((c) => c.emit('error', enoent)),
      )(url),
    ).toBe(false);
    const throws = (() => {
      throw new Error('EACCES');
    }) as never;
    expect(await systemOpener('linux', {}, throws)(url)).toBe(false);
    // A browser that keeps running (BROWSER=firefox) has started.
    vi.useFakeTimers();
    try {
      const running = systemOpener(
        'linux',
        { BROWSER: 'firefox' },
        fake(() => {}),
      )(url);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await running).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('oort open: the command', () => {
  const signedIn = (h: ReturnType<typeof harness>, extra: Record<string, string> = {}) => ({
    env: { HOME: h.root, OORT_HOME: h.home, OORT_API_KEY: 'oort_sk_test', ...extra },
  });

  it('open.opens-the-page-on-a-terminal', async () => {
    const h = harness();
    const o = opener();
    const r = await h.run(['open', 'docs'], TERMINAL, undefined, { open: o });
    expect(r.code, r.io.stderr).toBe(0);
    expect(o.opened).toEqual([`${SITE}/docs`]);
    expect(stripVTControlCharacters(r.io.stdout)).toBe(`✓ Opened ${SITE}/docs\n`);
  });

  it('open.json-prints-the-envelope-and-opens-nothing', async () => {
    const h = harness();
    const o = opener();
    const r = await h.run(['open', 'star-map', '--json'], TERMINAL, undefined, { open: o });
    expect(r.code).toBe(0);
    expect(o.opened).toEqual([]);
    expect(data(r.io.stdout, 'open')).toEqual({
      target: 'star-map',
      url: `${SITE}/dashboard/star-map`,
      opened: false,
    });
  });

  it('open.prints-the-url-without-a-terminal-with-no-browser-or-BROWSER-none', async () => {
    const h = harness();
    const o = opener();
    const piped = await h.run(['open', 'account'], { tty: true }, undefined, { open: o });
    expect(piped.code).toBe(0);
    expect(piped.io.stdout).toBe(`${SITE}/account\n`);
    expect(piped.io.stderr).toContain('Not opening a browser (stdout is not a terminal)');

    const flag = await h.run(['open', 'account', '--no-browser'], TERMINAL, undefined, { open: o });
    expect(flag.io.stdout).toBe(`${SITE}/account\n`);
    expect(flag.io.stderr).toBe('');

    const none = await h.run(
      ['open', 'account'],
      { ...TERMINAL, env: { HOME: h.root, OORT_HOME: h.home, BROWSER: 'none' } },
      undefined,
      { open: o },
    );
    expect(none.io.stdout).toBe(`${SITE}/account\n`);
    expect(none.io.stderr).toContain('BROWSER=none');

    const linux = await h.run(['open', 'account'], TERMINAL, undefined, {
      open: { ...o, platform: 'linux' },
    });
    expect(linux.io.stdout).toBe(`${SITE}/account\n`);
    expect(linux.io.stderr).toContain('no display');
    expect(o.opened).toEqual([]);
  });

  it('open.a-browser-that-does-not-start-prints-the-url-exit-0', async () => {
    const h = harness();
    const r = await h.run(['open', 'docs'], TERMINAL, undefined, { open: opener(false) });
    expect(r.code).toBe(0);
    expect(r.io.stdout).toBe(`${SITE}/docs\n`);
    expect(r.io.stderr).toContain('The browser did not start');
  });

  it('open.default-dashboard-when-signed-in-or-in-cloud-mode-else-the-quickstart', async () => {
    const h = harness();
    const local = await h.run(['open', '--json']);
    expect(data(local.io.stdout, 'open')).toMatchObject({
      target: 'quickstart',
      url: `${SITE}/docs/quickstart`,
    });
    const env = JSON.parse(local.io.stdout) as { warnings: { code: string }[] };
    expect(env.warnings.map((w) => w.code)).toEqual(['no-dashboard']);
    expect(local.io.stderr).toContain('Oort has no local viewer');

    const pro = await h.run(['open', '--json'], signedIn(h));
    expect(data(pro.io.stdout, 'open')).toMatchObject({ target: 'dashboard' });

    writeCloudSettings(h.home, { store: 'cloud' });
    const cloud = await h.run(['open'], {});
    expect(cloud.io.stdout).toBe(`${SITE}/dashboard\n`);
    expect(cloud.io.stderr).not.toContain('no local viewer');
  });

  it('open.memory-needs-an-id-and-oort-cloud', async () => {
    const h = harness();
    expect(failed(await h.run(['open', 'memory', '--json']), 'usage', 'open').message).toContain(
      'needs the memory id',
    );
    expect(failed(await h.run(['open', 'docs', MEM, '--json']), 'usage', 'open').message).toContain(
      'takes no id',
    );
    expect(
      failed(await h.run(['open', 'memory', '../account', '--json']), 'usage', 'open').message,
    ).toContain('is not a memory id');
    const local = failed(await h.run(['open', 'memory', MEM, '--json']), 'cloud-only', 'open');
    expect(local.fix).toBe(`oort inspect ${MEM}`);
    expect(failed(await h.run(['open', 'nowhere', '--json']), 'usage', 'open').message).toContain(
      'Allowed choices',
    );
  });

  it('open.memory-prefix-resolves-in-oort-cloud', async () => {
    const root = tmpdir();
    const home = path.join(root, 'oort-home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const key = ['oort', 'sk', 'openTest'.padEnd(43, 'O')].join('_');
    const cloud = fakeCloud(key);
    cloud.memories.set(MEM, fakeMemory({ id: MEM, text: 'We deploy with wrangler.' }));
    writeCloudSettings(home, { store: 'cloud' });
    const wire: WireFn = (dir, o = {}) =>
      realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
    const run = async (args: string[]) => {
      const io = fakeIo({
        cwd,
        env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      });
      const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
        fetch: cloud.fetch,
      });
      return { code, io };
    };
    const r = await run(['open', 'memory', MEM.slice(0, 8), '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(data(r.io.stdout, 'open')).toEqual({
      target: 'memory',
      url: `${SITE}/dashboard/memories/${MEM}`,
      opened: false,
    });
    const missing = await run(['open', 'memory', '99999999', '--json']);
    expect(failed(missing, 'not-found', 'open').exitCode).toBe(2);
  });
});
