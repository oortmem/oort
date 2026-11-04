import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSite, type FakeSite } from '../../test/fake-site.js';
import { fakeIo, memoryKeychain, tmpdir } from '../../test/helpers.js';
import { createKeychain, type Keychain } from '../keychain.js';
import { runCli } from '../program.js';
import type { WireFn } from '../wire.js';
import { challengeOf, newSecret, thisSystem, type LoginDeps } from './login.js';
import CONTRACT from '../../test/relay-contract.json' with { type: 'json' };

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
    const secret = s.polls[0] ?? '';
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.polls).toEqual([secret, secret, secret]);
    // Not a terminal: the page URL and the code are printed, no browser, no question.
    expect(r.io.stdout).toContain(`${s.url}/account/cli`);
    expect(r.io.stdout).toContain(s.sessions[0]!.code);
    expect(r.io.stdout).toContain('oort.oort');
    expect(r.io.stdout).toContain('revoke it at oortcloud.dev/account');
    expect(r.io.asked).toEqual([]);
    expect(r.io.stdout + r.io.stderr).not.toContain(s.minted);
    expect(r.io.stdout + r.io.stderr).not.toContain((s.minted ?? '').slice(0, 12));
    expect(r.sleeps).toEqual([2000, 2000]);
  });

  it('login.the-secret-never-leaves-in-a-url-or-on-screen-and-only-its-hash-starts-the-session', async () => {
    const s = await site({ approveAtPoll: 1 });
    const r = await login(s, { keychain: memoryKeychain().kc });
    expect(r.code).toBe(0);
    const secret = s.polls[0]!;
    // The session started with h = base64url(SHA-256(S)) over the raw bytes, not S.
    expect(s.sessions[0]!.challenge).toBe(
      createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url'),
    );
    expect(s.sessions[0]!.challenge).toBe(challengeOf(Buffer.from(secret, 'base64url')));
    expect(s.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      'POST /api/cli/session',
      'POST /api/cli/session/poll',
    ]);
    expect(s.requests[0]!.body).not.toContain(secret);
    for (const q of s.requests) expect(q.path).not.toContain(secret);
    expect(r.io.stdout + r.io.stderr).not.toContain(secret);
    expect(r.io.stdout + r.io.stderr).not.toContain(s.sessions[0]!.challenge);
  });

  it('login.challenge-is-the-sites-challenge', () => {
    // The site (private oortmem/oortcloud) tests its challengeOf against the same vectors.
    for (const v of CONTRACT.loginChallenge.vectors) {
      expect(challengeOf(Buffer.from(v.secret, 'base64url'))).toBe(v.challenge);
    }
    const raw = newSecret();
    expect(raw).toHaveLength(32);
  });

  it('login.reports-this-computers-os-and-host-name', async () => {
    const s = await site({ approveAtPoll: 1 });
    await login(s, {
      keychain: memoryKeychain().kc,
      deps: { system: () => ({ os: 'Linux', host: 'build-box' }) },
    });
    expect(s.sessions[0]).toMatchObject({ os: 'Linux', host: 'build-box' });
    expect(['macOS', 'Linux', 'Windows']).toContain(thisSystem().os);
  });

  it('login.opens-the-page-without-a-secret-on-a-terminal-and-prints-it-when-it-cannot', async () => {
    const s = await site({ approveAtPoll: 1 });
    const opened: string[] = [];
    const ok = await login(s, {
      keychain: memoryKeychain().kc,
      tty: true,
      deps: { openBrowser: async (u) => (opened.push(u), true) },
    });
    expect(ok.code).toBe(0);
    expect(opened).toEqual([`${s.url}/account/cli`]);
    expect(ok.io.stdout).toContain('Opened');
    expect(ok.io.stdout).toContain(s.sessions[0]!.code);

    const failed = await login(s, {
      keychain: memoryKeychain().kc,
      tty: true,
      deps: { openBrowser: async () => false },
    });
    expect(failed.code).toBe(0);
    expect(failed.io.stdout).toContain(`Open this page in a browser`);

    const flag = await login(s, {
      args: ['login', '--no-browser'],
      keychain: memoryKeychain().kc,
      tty: true,
    });
    expect(flag.code).toBe(0);
    expect(flag.io.stdout).toContain(`${s.url}/account/cli`);
  });

  it('login.expired-used-unknown-and-key-limit-stop-with-the-fix-and-store-nothing', async () => {
    const k = memoryKeychain();
    const expired = await login(await site({ ttlMs: -1 }), { keychain: k.kc });
    expect(expired.code).toBe(1);
    expect(expired.io.stderr).toContain('expired. Run `oort login` again.');

    const limit = await login(await site({ approveAtPoll: 1, keyLimit: true }), { keychain: k.kc });
    expect(limit.code).toBe(1);
    expect(limit.io.stderr).toContain('most live keys');
    expect(limit.io.stderr).toContain('Revoke a key at https://oortcloud.dev/account');

    const busy = await login(await site({ createStatus: 429 }), { keychain: k.kc });
    expect(busy.code).toBe(1);
    expect(busy.io.stderr).toContain('too many sign-in requests');

    const unknown = await login(await site({ failFirst: { polls: 1, status: 404 } }), {
      keychain: k.kc,
    });
    expect(unknown.code).toBe(1);
    expect(unknown.io.stderr).toContain('does not know this sign-in request');
    expect(k.items).toEqual({});
  });

  it('login.a-site-that-cannot-be-reached-stops-before-polling', async () => {
    const k = memoryKeychain();
    const r = await login(undefined, {
      keychain: k.kc,
      env: { OORT_SITE_URL: 'http://127.0.0.1:9' },
    });
    expect(r.code).toBe(1);
    expect(r.io.stderr).toContain('Could not reach');
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
    const linux = await login(s, { keychain: createKeychain({ platform: 'none' }) });
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
