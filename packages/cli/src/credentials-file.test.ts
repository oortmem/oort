import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSite, type FakeSite } from '../test/fake-site.js';
import { fakeIo, tmpdir, data } from '../test/helpers.js';
import { credentialsPath } from './credentials-file.js';
import { createKeychain, keychainFor } from './keychain.js';
import { runCli } from './program.js';
import type { WireFn } from './wire.js';

const posix = process.platform === 'win32' ? it.skip : it;
const noWire: WireFn = async () => {
  throw new Error('these commands must not open the store');
};

/** Assembled at runtime so no key literal sits in a source file. */
const fakeKey = (tag: string): string => ['test', tag, String(Date.now())].join('-');
const oortKey = (): string => ['oort', 'sk', `file${Date.now()}AAAAAAAAAAAAAAAA`].join('_');

/** A temp OORT_HOME and a Linux-style keychain over it; the real ~/.oort is never touched. */
function rig(secret?: string) {
  const root = tmpdir();
  const home = path.join(root, 'home');
  const env = { HOME: root, OORT_HOME: home };
  const warnings: string[] = [];
  const kc = createKeychain({
    platform: 'linux',
    env,
    warn: (m) => warnings.push(m),
    promptSecret: async () => secret ?? '',
  });
  return { root, home, env, file: credentialsPath(env), warnings, kc };
}

describe('credentials file (Linux and Windows)', () => {
  it('creds.store-then-read-roundtrips-with-0600-file-and-0700-dir', async () => {
    const { kc, home, file } = rig();
    const key = fakeKey('voyage');
    expect(kc.kind).toBe('file');
    expect(kc.supported).toBe(true);
    expect(await kc.read('voyage')).toBeUndefined();
    expect(await kc.store('voyage', key)).toBe(0);
    expect(await kc.store('oort', oortKey())).toBe(0);
    expect(await kc.read('voyage')).toBe(key);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      version: 1,
      keys: { voyage: key },
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(home)).toEqual(['credentials.json']); // no temp file left behind
  });

  posix('creds.a-wider-umask-cannot-widen-the-file', async () => {
    const { kc, file } = rig();
    const old = process.umask(0);
    try {
      expect(await kc.store('voyage', fakeKey('voyage'))).toBe(0);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  posix('creds.refuses-to-read-a-file-wider-than-0600-and-says-how-to-fix-it', async () => {
    const { kc, file, warnings } = rig();
    const key = fakeKey('voyage');
    expect(await kc.store('voyage', key)).toBe(0);
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o601]) {
      fs.chmodSync(file, mode);
      warnings.length = 0;
      const again = createKeychain({
        platform: 'linux',
        env: { OORT_HOME: path.dirname(file) },
        warn: (m) => warnings.push(m),
      });
      expect(await again.read('voyage'), mode.toString(8)).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`chmod 600 ${file}`);
      expect(warnings[0]).toContain(mode.toString(8));
      expect(warnings[0]).not.toContain(key);
      // Nor does it write over a file it will not read.
      expect(await again.store('typesafe', fakeKey('ts'))).toBe(1);
      expect(await again.remove('voyage')).toBe(1);
    }
    fs.chmodSync(file, 0o600);
    const ok = createKeychain({ platform: 'linux', env: { OORT_HOME: path.dirname(file) } });
    expect(await ok.read('voyage')).toBe(key);
  });

  posix('creds.0400-is-narrower-than-0600-and-is-read', async () => {
    const { kc, file } = rig();
    const key = fakeKey('voyage');
    await kc.store('voyage', key);
    fs.chmodSync(file, 0o400);
    expect(await kc.read('voyage')).toBe(key);
  });

  it('creds.warns-once-per-keychain-however-many-keys-are-read', async () => {
    const { kc, file, warnings } = rig();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json with a key sk-secret-123', { mode: 0o600 });
    for (const p of ['voyage', 'typesafe', 'anthropic', 'oort'] as const) {
      expect(await kc.read(p)).toBeUndefined();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('sk-secret-123');
  });

  it('creds.remove-deletes-one-key-and-keeps-the-others', async () => {
    const { kc } = rig();
    await kc.store('voyage', fakeKey('a'));
    await kc.store('oort', oortKey());
    expect(await kc.remove('voyage')).toBe(0);
    expect(await kc.read('voyage')).toBeUndefined();
    expect(await kc.read('oort')).toBeDefined();
    expect(await kc.remove('voyage')).toBe(1); // already gone
  });

  it('creds.store-refuses-values-that-are-not-one-token', async () => {
    const { kc, file } = rig();
    for (const bad of ['', 'a b', 'a\nb', 'a\u0000b']) expect(await kc.store('oort', bad)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('creds.set-takes-the-value-from-the-hidden-prompt', async () => {
    const key = fakeKey('typed');
    const { kc } = rig(`  ${key}  `);
    expect(await kc.set('typesafe')).toBe(0);
    expect(await kc.read('typesafe')).toBe(key);
    const none = rig('');
    expect(await none.kc.set('typesafe')).toBe(1);
    expect(none.warnings.join()).toContain('nothing was stored');
  });

  it('creds.OORT_NO_KEYCHAIN-switches-the-file-off-too', async () => {
    const { env, file } = rig();
    const kc = keychainFor({ ...env, OORT_NO_KEYCHAIN: '1' }, { platform: 'linux' });
    expect(kc.supported).toBe(false);
    expect(await kc.store('voyage', fakeKey('v'))).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('creds.macos-keeps-the-keychain-and-never-touches-the-file', async () => {
    const { env, file } = rig();
    const kc = createKeychain({
      platform: 'darwin',
      env,
      execFile: async () => ({ stdout: 'k\n' }),
    });
    expect(kc.kind).toBe('keychain');
    expect(await kc.read('voyage')).toBe('k');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('oort keys and oort login on Linux', () => {
  let sites: FakeSite[] = [];
  afterEach(async () => {
    await Promise.all(sites.map((s) => s.close()));
    sites = [];
  });

  it('creds.keys-set-list-rm-through-the-cli-never-print-the-key', async () => {
    const r = rig();
    const key = fakeKey('cli');
    const run = async (args: string[], secret?: string) => {
      const io = fakeIo({ cwd: r.root, env: r.env, ...(secret !== undefined && { secret }) });
      const kc = createKeychain({
        platform: 'linux',
        env: r.env,
        warn: (m) => io.err(`oort: ${m}\n`),
        promptSecret: (q) => io.askSecret(q),
      });
      return { code: await runCli(args, io, noWire, kc), io };
    };
    const set = await run(['keys', 'set', 'voyage'], key);
    expect(set.code).toBe(0);
    expect(set.io.stdout).toContain(r.file);
    expect(set.io.asked.join()).not.toContain(key);
    const list = await run(['keys', 'list', '--json']);
    expect(data(list.io.stdout).keys).toContainEqual({
      provider: 'voyage',
      envVar: 'VOYAGE_API_KEY',
      source: 'keychain',
    });
    const rm = await run(['keys', 'rm', 'voyage']);
    expect(rm.code).toBe(0);
    expect((await run(['keys', 'list', '--json'])).io.stdout).toContain('"missing"');
    for (const x of [set, list, rm]) expect(x.io.stdout + x.io.stderr).not.toContain(key);
  });

  it('creds.login-keeps-the-key-in-the-file-and-logout-removes-it', async () => {
    const r = rig();
    const s = await fakeSite({ approveAtPoll: 1 });
    sites.push(s);
    const env = { ...r.env, OORT_SITE_URL: s.url };
    const io = fakeIo({ cwd: r.root, env });
    const kc = createKeychain({ platform: 'linux', env, warn: (m) => io.err(`oort: ${m}\n`) });
    const code = await runCli(['login'], io, noWire, kc, {
      login: { sleep: async () => {}, openBrowser: async () => false },
    });
    expect(code).toBe(0);
    expect(s.minted).toBeDefined();
    expect(await kc.read('oort')).toBe(s.minted);
    expect(io.stdout).toContain(r.file);
    expect(io.stdout + io.stderr).not.toContain(s.minted ?? 'x');
    const out = fakeIo({ cwd: r.root, env });
    expect(await runCli(['logout'], out, noWire, kc)).toBe(0);
    expect(await kc.read('oort')).toBeUndefined();
    expect(out.stdout).toContain('Removed');
  });
});
