import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSite, type FakeSite } from '../../test/fake-site.js';
import { fakeIo, memoryKeychain, tmpdir } from '../../test/helpers.js';
import { createKeychain, type Keychain } from '../keychain.js';
import { runCli } from '../program.js';
import type { WireFn } from '../wire.js';
import { matchCode, newSessionId, type LoginDeps } from './login.js';

const noWire: WireFn = async () => {
  throw new Error('login must not open the store');
};

let sites: FakeSite[] = [];
afterEach(async () => {
  await Promise.all(sites.map((s) => s.close()));
  sites = [];
});

async function site(opts: Parameters<typeof fakeSite>[0] = {}): Promise<FakeSite> {
  const s = await fakeSite(opts);
  sites.push(s);
  return s;
}

async function login(
  s: FakeSite | undefined,
  opts: {
    args?: string[];
    keychain?: Keychain;
    env?: Record<string, string>;
    tty?: boolean;
    deps?: LoginDeps;
  } = {},
) {
  const root = tmpdir();
  const io = fakeIo({
    cwd: root,
    env: {
      HOME: root,
      OORT_HOME: path.join(root, 'home'),
      ...(s !== undefined && { OORT_SITE_URL: s.url }),
      ...opts.env,
    },
    tty: opts.tty ?? false,
    stdoutTTY: opts.tty ?? false,
  });
  const sleeps: number[] = [];
  // Never the real Keychain: a test without its own gets one that is switched off.
  const keychain = opts.keychain ?? createKeychain({ platform: 'disabled' });
  const code = await runCli(opts.args ?? ['login'], io, noWire, keychain, {
    login: {
      sleep: async (ms) => void sleeps.push(ms),
      openBrowser: async () => {
        throw new Error('no browser in tests unless a test asks for one');
      },
      ...opts.deps,
    },
  });
  return { code, io, sleeps };
}

describe('oort login', () => {
  it('login.polls-until-approved-stores-the-key-and-never-prints-it', async () => {
    const s = await site({ approveAtPoll: 3 });
    const k = memoryKeychain();
    const r = await login(s, { keychain: k.kc });
    expect(r.code).toBe(0);
    expect(s.minted).toBeDefined();
    expect(k.items['oort.oort']).toBe(s.minted);
    const id = s.polls[0] ?? '';
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.polls).toEqual([id, id, id]);
    // Not a terminal: the URL is printed, no browser, no question.
    expect(r.io.stdout).toContain(`${s.url}/account/cli?session=${id}`);
    expect(r.io.stdout).toContain(matchCode(id));
    expect(r.io.stdout).toContain('oort.oort');
    expect(r.io.stdout).toContain('revoke it at oortcloud.dev/account');
    expect(r.io.asked).toEqual([]);
    expect(r.io.stdout + r.io.stderr).not.toContain(s.minted);
    expect(r.io.stdout + r.io.stderr).not.toContain((s.minted ?? '').slice(0, 12));
    expect(r.sleeps).toEqual([2000, 2000]);
  });

  it('login.match-code-is-the-sites-code', async () => {
    const keys = (await import(
      pathToFileURL(
        path.join(
          import.meta.dirname,
          '..',
          '..',
          '..',
          '..',
          'apps',
          'site',
          'src',
          'server',
          'keys.ts',
        ),
      ).href
    )) as { cliCode: (id: string) => Promise<string> };
    for (let i = 0; i < 5; i++) {
      const id = newSessionId();
      expect(matchCode(id)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(matchCode(id)).toBe(await keys.cliCode(id));
    }
  });

  it('login.opens-the-browser-on-a-terminal-and-prints-the-url-when-it-cannot', async () => {
    const s = await site({ approveAtPoll: 1 });
    const opened: string[] = [];
    const ok = await login(s, {
      keychain: memoryKeychain().kc,
      tty: true,
      deps: { openBrowser: async (u) => (opened.push(u), true) },
    });
    expect(ok.code).toBe(0);
    expect(opened).toEqual([`${s.url}/account/cli?session=${s.polls[0]}`]);
    expect(ok.io.stdout).not.toContain('?session=');
    expect(ok.io.stdout).toContain('Opened');

    const failed = await login(s, {
      keychain: memoryKeychain().kc,
      tty: true,
      deps: { openBrowser: async () => false },
    });
    expect(failed.code).toBe(0);
    expect(failed.io.stdout).toContain(`/account/cli?session=${s.polls.at(-1)}`);

    const flag = await login(s, {
      args: ['login', '--no-browser'],
      keychain: memoryKeychain().kc,
      tty: true,
    });
    expect(flag.code).toBe(0);
    expect(flag.io.stdout).toContain('?session=');
  });

  it('login.expired-and-used-requests-stop-with-the-fix-and-store-nothing', async () => {
    const expired = await site({ ttlMs: -1 });
    const k = memoryKeychain();
    const r = await login(expired, { keychain: k.kc });
    expect(r.code).toBe(1);
    expect(r.io.stderr).toContain('expired. Run `oort login` again.');
    expect(k.items).toEqual({});

    const used = await site();
    const id = newSessionId();
    used.approve(id);
    await fetch(`${used.url}/api/cli/session/${id}`); // someone else took the key
    const r2 = await login(used, { keychain: k.kc, deps: { sessionId: () => id } });
    expect(r2.code).toBe(1);
    expect(r2.io.stderr).toContain('already used');
    expect(k.items).toEqual({});
  });

  it('login.ctrl-c-cancels-the-wait', async () => {
    const s = await site();
    const k = memoryKeychain();
    const ctl = new AbortController();
    const r = await login(s, {
      keychain: k.kc,
      deps: { signal: ctl.signal, sleep: async () => ctl.abort() },
    });
    expect(r.code).toBe(1);
    expect(r.io.stderr).toContain('cancelled; nothing was stored');
    expect(s.polls).toHaveLength(1);
    expect(k.items).toEqual({});
  });

  it('login.backs-off-through-a-struggling-site-and-gives-up-at-the-deadline', async () => {
    const s = await site({ failFirst: { polls: 3, status: 503 }, approveAtPoll: 1 });
    const ok = await login(s, { keychain: memoryKeychain().kc });
    expect(ok.code).toBe(0);
    expect(ok.sleeps).toEqual([3000, 4500, 5000]);

    let t = 0;
    const slow = await site();
    const late = await login(slow, {
      keychain: memoryKeychain().kc,
      deps: { now: () => t, sleep: async () => void (t += 60_000) },
    });
    expect(late.code).toBe(1);
    expect(late.io.stderr).toContain('expired');
    expect(slow.polls.length).toBeLessThanOrEqual(12);
  });

  it('login.refuses-before-the-flow-without-a-keychain', async () => {
    const s = await site({ approveAtPoll: 1 });
    const off = await login(s, { env: { OORT_NO_KEYCHAIN: '1' } });
    expect(off.code).toBe(2);
    expect(off.io.stderr).toContain('OORT_NO_KEYCHAIN=1');
    expect(off.io.stderr).toContain('OORT_API_KEY');
    const linux = await login(s, { keychain: createKeychain({ platform: 'linux' }) });
    expect(linux.code).toBe(2);
    expect(linux.io.stderr).toContain('macOS Keychain');
    expect(s.polls).toEqual([]);
  });

  it('login.a-keychain-that-does-not-keep-the-key-is-reported', async () => {
    const s = await site({ approveAtPoll: 1 });
    const k = memoryKeychain();
    const broken: Keychain = { ...k.kc, store: async () => 0 }; // claims success, keeps nothing
    const r = await login(s, { keychain: broken });
    expect(r.code).toBe(1);
    expect(r.io.stderr).toContain('did not store the key');
    expect(r.io.stderr).toContain('revoke it at oortcloud.dev/account');
    expect(r.io.stderr).not.toContain(s.minted);
  });

  it('login.refuses-a-site-url-that-is-not-https-or-loopback', async () => {
    const r = await login(undefined, {
      keychain: memoryKeychain().kc,
      env: { OORT_SITE_URL: 'http://oortcloud.example' },
    });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('OORT_SITE_URL');
  });
});

describe('oort logout', () => {
  it('logout.removes-the-item-and-says-how-to-revoke', async () => {
    const key = ['oort', 'sk', 'test0123456789abcdef'].join('_');
    const k = memoryKeychain({ 'oort.oort': key });
    const r = await login(undefined, { args: ['logout'], keychain: k.kc });
    expect(r.code).toBe(0);
    expect(k.items).toEqual({});
    expect(r.io.stdout).toContain('revoke it at oortcloud.dev/account');
    expect(r.io.stdout).not.toContain(key);
    const again = await login(undefined, { args: ['logout'], keychain: k.kc });
    expect(again.code).toBe(0);
    expect(again.io.stdout).toContain('nothing changed');
    const env = await login(undefined, {
      args: ['logout'],
      keychain: k.kc,
      env: { OORT_API_KEY: key },
    });
    expect(env.io.stdout).toContain('OORT_API_KEY is still set');
    expect(env.io.stdout).not.toContain(key);
  });

  it('logout.refuses-with-the-keychain-off', async () => {
    const r = await login(undefined, { args: ['logout'], env: { OORT_NO_KEYCHAIN: '1' } });
    expect(r.code).toBe(2);
  });
});
