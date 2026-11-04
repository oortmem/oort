import { describe, expect, it } from 'vitest';
import { createKeychain, keychainFor, type KeychainDeps } from './keychain.js';

type Call = { file: string; args: string[]; input?: string };

function rig(over: Partial<KeychainDeps> = {}): {
  calls: Call[];
  warnings: string[];
  kc: ReturnType<typeof createKeychain>;
} {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const kc = createKeychain({
    platform: 'darwin',
    user: 'alice',
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'value-from-keychain\n' };
    },
    spawnInherit: async (file, args) => {
      calls.push({ file, args });
      return 0;
    },
    spawnWithInput: async (file, args, input) => {
      calls.push({ file, args, input });
      return 0;
    },
    warn: (m) => warnings.push(m),
    ...over,
  });
  return { calls, warnings, kc };
}

describe('keychain', () => {
  it('keychain.read-builds-exact-argv-and-trims', async () => {
    const { calls, kc } = rig();
    expect(await kc.read('voyage')).toBe('value-from-keychain');
    expect(calls).toEqual([
      {
        file: '/usr/bin/security',
        args: ['find-generic-password', '-a', 'alice', '-s', 'oort.voyage', '-w'],
      },
    ]);
  });

  it('keychain.set-puts-w-last-with-inherited-stdio', async () => {
    const { calls, kc } = rig();
    expect(await kc.set('anthropic')).toBe(0);
    expect(calls).toEqual([
      {
        file: '/usr/bin/security',
        args: ['add-generic-password', '-U', '-a', 'alice', '-s', 'oort.anthropic', '-w'],
      },
    ]);
  });

  it('keychain.remove-builds-exact-argv', async () => {
    const { calls, kc } = rig();
    await kc.remove('typesafe');
    expect(calls[0]).toEqual({
      file: '/usr/bin/security',
      args: ['delete-generic-password', '-a', 'alice', '-s', 'oort.typesafe'],
    });
  });

  it('keychain.store-sends-the-value-on-stdin-never-in-argv', async () => {
    const { calls, kc } = rig();
    const key = ['oort', 'sk', 'AbC-123_xyz0123456789'].join('_');
    expect(await kc.store('oort', key)).toBe(0);
    expect(calls).toEqual([
      {
        file: '/usr/bin/security',
        args: ['-i'],
        input: `add-generic-password -U -a "alice" -s "oort.oort" -w "${key}"\n`,
      },
    ]);
    expect(calls[0]!.args.join(' ')).not.toContain(key);
  });

  it('keychain.store-refuses-values-it-cannot-quote', async () => {
    for (const bad of ['', 'a"b', 'a\\b', 'a\nb', 'a b']) {
      const { calls, kc } = rig();
      expect(await kc.store('oort', bad)).toBe(1);
      expect(calls).toEqual([]);
    }
    const { calls, kc } = rig({ user: 'ev"il' });
    expect(await kc.store('oort', 'oort_sk_abc')).toBe(1);
    expect(calls).toEqual([]);
  });

  it('keychain.missing-item-is-undefined-without-warning', async () => {
    const { warnings, kc } = rig({
      execFile: async () => {
        throw Object.assign(new Error('not found'), { code: 44 });
      },
    });
    expect(await kc.read('voyage')).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('keychain.other-failure-warns-presence-only', async () => {
    const planted = ['sk', 'test', String(Date.now())].join('-');
    const { warnings, kc } = rig({
      execFile: async () => {
        throw Object.assign(new Error(`boom ${planted}`), { code: 'ENOENT' });
      },
    });
    expect(await kc.read('voyage')).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('oort.voyage');
    expect(warnings[0]).not.toContain(planted);
  });

  it('keychain.unsupported-platform-never-spawns', async () => {
    const { calls, kc } = rig({ platform: 'none' });
    expect(kc.supported).toBe(false);
    expect(await kc.read('voyage')).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('keychainFor', () => {
  it('keychain.oort-no-keychain-switches-every-command-off', async () => {
    const calls: string[][] = [];
    const deps: KeychainDeps = {
      platform: 'darwin',
      execFile: async (_f, args) => {
        calls.push(args);
        return { stdout: 'x\n' };
      },
      spawnInherit: async (_f, args) => {
        calls.push(args);
        return 0;
      },
    };
    const off = keychainFor({ OORT_NO_KEYCHAIN: '1' }, deps);
    expect(off.supported).toBe(false);
    expect(await off.read('voyage')).toBeUndefined();
    expect(await off.set('voyage')).toBe(1);
    expect(await off.store('oort', 'oort_sk_abc')).toBe(1);
    expect(calls).toEqual([]);
    const on = keychainFor({}, deps);
    expect(on.supported).toBe(true);
    expect(await on.read('voyage')).toBe('x');
    expect(calls).toHaveLength(1);
  });
});
