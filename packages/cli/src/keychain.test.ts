import { describe, expect, it } from 'vitest';
import { createKeychain, type KeychainDeps } from './keychain.js';

type Call = { file: string; args: string[] };

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

  it('keychain.not-macos-never-spawns', async () => {
    const { calls, kc } = rig({ platform: 'linux' });
    expect(kc.supported).toBe(false);
    expect(await kc.read('voyage')).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
