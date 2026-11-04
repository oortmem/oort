import { describe, expect, it } from 'vitest';
import { harness } from '../../test/helpers.js';
import { createKeychain } from '../keychain.js';

const planted = (): string => ['sk', 'test', String(Date.now())].join('-');

function fakeKeychain(items: Record<string, string>, supported = true) {
  const calls: string[][] = [];
  const kc = createKeychain({
    platform: supported ? 'darwin' : 'linux',
    user: 'alice',
    execFile: async (_f, args) => {
      calls.push(args);
      const v = items[args[args.indexOf('-s') + 1] ?? ''];
      if (v === undefined) throw Object.assign(new Error('nf'), { code: 44 });
      return { stdout: `${v}\n` };
    },
    spawnInherit: async (_f, args) => {
      calls.push(args);
      return 0;
    },
    warn: () => {},
  });
  return { kc, calls };
}

describe('oort keys', () => {
  it('keys.list-shows-presence-only', async () => {
    const key = planted();
    const key2 = `${planted()}-env`;
    const h = harness();
    const { kc } = fakeKeychain({ 'oort.voyage': key });
    const r = await h.run(
      ['keys', 'list'],
      { env: { VOYAGE_API_KEY: '', TYPESAFE_API_KEY: key2 } },
      kc,
    );
    expect(r.code).toBe(0);
    expect(r.io.stdout).toBe('voyage: keychain\ntypesafe: env\nanthropic: missing\n');
    expect(r.io.stdout + r.io.stderr).not.toContain(key);
    expect(r.io.stdout + r.io.stderr).not.toContain(key2);
  });

  it('keys.set-delegates-to-security-and-rm-deletes', async () => {
    const h = harness();
    const { kc, calls } = fakeKeychain({});
    expect((await h.run(['keys', 'set', 'voyage'], {}, kc)).code).toBe(0);
    expect((await h.run(['keys', 'rm', 'voyage'], {}, kc)).code).toBe(0);
    expect(calls[0]?.at(-1)).toBe('-w');
    expect(calls[1]?.[0]).toBe('delete-generic-password');
  });

  it('keys.unknown-provider-is-usage-error-without-echoing-secret', async () => {
    const key = planted();
    const h = harness();
    const { kc, calls } = fakeKeychain({});
    const r = await h.run(['keys', 'set', key], {}, kc);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('voyage, typesafe, anthropic');
    expect(r.io.stderr).not.toContain(key);
    expect(calls).toEqual([]);
  });

  it('keys.not-macos-refuses-with-env-hint', async () => {
    const h = harness();
    const { kc } = fakeKeychain({}, false);
    const r = await h.run(['keys', 'set', 'voyage'], {}, kc);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('macOS');
  });
});

describe('oort init with the Keychain', () => {
  it('init.counts-keychain-keys-as-set', async () => {
    const key = planted();
    const { kc } = fakeKeychain({
      'oort.voyage': key,
      'oort.typesafe': key,
      'oort.anthropic': key,
    });
    const h = harness();
    const { code, io } = await h.run(['init'], {}, kc);
    expect(code).toBe(0);
    expect(io.stdout).toContain('All keys are set.');
    expect(io.stdout).not.toContain(key);
  });

  it('init.reports-only-keys-missing-from-env-and-keychain', async () => {
    const { kc } = fakeKeychain({ 'oort.voyage': planted() });
    const h = harness();
    const { io } = await h.run(['init'], {}, kc);
    expect(io.stdout).not.toContain('VOYAGE_API_KEY');
    expect(io.stdout).toContain('oort keys set typesafe');
    expect(io.stdout).toContain('oort keys set anthropic');
  });
});
