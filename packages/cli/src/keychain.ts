import { execFile as nodeExecFile, spawn } from 'node:child_process';
import * as os from 'node:os';
import {
  credentialsPath,
  describeProblem,
  inspectCredentialsFile,
  readKeys,
  writeKeys,
} from './credentials-file.js';
import type { Env } from './io.js';

/** The model vendors Oort calls, each with its own key. */
export const VENDORS = ['voyage', 'typesafe', 'anthropic'] as const;
export type Vendor = (typeof VENDORS)[number];

/**
 * Keys that can live in the Keychain, as `oort.<provider>` items: the three
 * vendors, and `oort`, the Oort Pro key (`oort login`) that reaches all three
 * through the relay.
 */
export const PROVIDERS = [...VENDORS, 'oort'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_ENV: Record<Provider, string> = {
  voyage: 'VOYAGE_API_KEY',
  typesafe: 'TYPESAFE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  oort: 'OORT_API_KEY',
};

export const isProvider = (s: string): s is Provider =>
  (PROVIDERS as readonly string[]).includes(s);

/** Reads a provider's key, or undefined when there is none. */
export type KeychainReader = (provider: Provider) => Promise<string | undefined>;

export const SECURITY = '/usr/bin/security';

export interface KeychainDeps {
  /**
   * Defaults to `process.platform`. `darwin` uses the Keychain; `linux` and `win32` use
   * `$OORT_HOME/credentials.json`; anything else is unsupported.
   */
  platform?: string;
  /** Where `OORT_HOME` comes from for the credentials file; defaults to `process.env`. */
  env?: Env;
  /** Reads a secret from the user with the input hidden; `''` when none was given. */
  promptSecret?: (question: string) => Promise<string>;
  /** The keychain account; defaults to the OS username. */
  user?: string;
  /** Runs a binary without a shell; rejects with `code` set (a number for a non-zero exit). */
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  /** Runs a binary with stdio inherited (the Keychain prompts on the terminal); resolves its exit code. */
  spawnInherit?: (file: string, args: string[]) => Promise<number>;
  /** Runs a binary with `input` on its stdin and its output discarded; resolves its exit code. */
  spawnWithInput?: (file: string, args: string[], input: string) => Promise<number>;
  /** One presence-only line (never a key) when the Keychain cannot be read. */
  warn?: (message: string) => void;
}

export interface Keychain {
  /** `keychain` on macOS, `file` (credentials.json) on Linux and Windows, else `none`. */
  readonly kind: 'keychain' | 'file' | 'none';
  /** Where keys are kept, for messages: `the Keychain` or `the credentials file`. */
  readonly label: string;
  /** false when keys cannot be stored here: every operation then does nothing. */
  readonly supported: boolean;
  /** The place one key lives, for messages: `Keychain oort.voyage` or the file path. Never a value. */
  where(provider: Provider): string;
  readonly read: KeychainReader;
  /** `security` prompts for the value itself; resolves its exit code. */
  set(provider: Provider): Promise<number>;
  /**
   * Stores a value the CLI already holds (the key `oort login` received). The
   * value goes to `security -i` on stdin, never in argv, so `ps` cannot see it.
   * Resolves 1 without running anything for a value or user it cannot quote.
   */
  store(provider: Provider, value: string): Promise<number>;
  remove(provider: Provider): Promise<number>;
}

const service = (p: Provider): string => `oort.${p}`;

/**
 * The CLI's Keychain for this environment: switched off entirely by
 * `OORT_NO_KEYCHAIN=1` (as `wire` already is), so no command, including
 * `keys list`, `init` and `setup`, ever runs `security` then.
 */
export function keychainFor(
  env: Record<string, string | undefined>,
  deps: KeychainDeps = {},
): Keychain {
  return createKeychain(
    env['OORT_NO_KEYCHAIN'] === '1' ? { ...deps, env, platform: 'disabled' } : { ...deps, env },
  );
}

/**
 * Tests must inject a fake: the real login Keychain is never touched under vitest
 * (VITEST is set by the runner). Throws synchronously so no catch can swallow it.
 */
const REAL_KEYCHAIN_IN_TEST = 'ERR_OORT_REAL_KEYCHAIN_IN_TEST';

function refuseUnderTest(): void {
  if (process.env['VITEST'] !== undefined && process.env['OORT_ALLOW_REAL_KEYCHAIN'] !== '1') {
    throw Object.assign(
      new Error('refusing to run /usr/bin/security under the test runner: inject a fake keychain'),
      { code: REAL_KEYCHAIN_IN_TEST },
    );
  }
}

const defaultExecFile: NonNullable<KeychainDeps['execFile']> = (file, args) => {
  refuseUnderTest();
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { encoding: 'utf8' }, (err, stdout) =>
      err === null ? resolve({ stdout }) : reject(err),
    );
  });
};

const defaultSpawnInherit: NonNullable<KeychainDeps['spawnInherit']> = (file, args) => {
  refuseUnderTest();
  return new Promise((resolve, reject) => {
    spawn(file, args, { stdio: 'inherit' })
      .once('error', reject)
      .once('close', (code) => resolve(code ?? 1));
  });
};

const defaultSpawnWithInput: NonNullable<KeychainDeps['spawnWithInput']> = (file, args, input) => {
  refuseUnderTest();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject).once('close', (code) => resolve(code ?? 1));
    child.stdin.on('error', () => {}); // an early exit closes the pipe; `close` reports it
    child.stdin.end(input);
  });
};

/** Safe inside double quotes in `security -i`'s command line: no quote, backslash, space or control. */
const QUOTABLE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** The credentials file (Linux and Windows): keys in `$OORT_HOME/credentials.json`, mode 0600. */
function createFileStore(deps: KeychainDeps): Keychain {
  const file = credentialsPath(deps.env ?? process.env);
  const warn = deps.warn ?? (() => {});
  const warned = new Set<string>();
  const warnOnce = (m: string): void => {
    if (warned.has(m)) return;
    warned.add(m);
    warn(m);
  };
  const SAFE = /^[\x21-\x7e]+$/; // one visible token: no space, newline or control character
  return {
    kind: 'file',
    label: 'the credentials file',
    supported: true,
    where: () => file,
    async read(provider) {
      const r = readKeys(file);
      if ('problem' in r) {
        warnOnce(r.problem);
        return undefined;
      }
      return r.keys[provider];
    },
    async set(provider) {
      const prompt = deps.promptSecret;
      if (prompt === undefined) return 1;
      const state = inspectCredentialsFile(file);
      const problem = describeProblem(file, state);
      if (problem !== undefined) {
        warnOnce(problem);
        return 1;
      }
      const value = (await prompt(`${provider} key (input hidden): `)).trim();
      if (value === '') {
        warn('no key entered; nothing was stored.');
        return 1;
      }
      return this.store(provider, value);
    },
    async store(provider, value) {
      if (!SAFE.test(value)) return 1;
      const r = readKeys(file);
      if ('problem' in r) {
        warnOnce(r.problem);
        return 1;
      }
      try {
        writeKeys(file, { ...r.keys, [provider]: value });
        return 0;
      } catch {
        warn(`could not write ${file}.`);
        return 1;
      }
    },
    async remove(provider) {
      const r = readKeys(file);
      if ('problem' in r) {
        warnOnce(r.problem);
        return 1;
      }
      if (r.keys[provider] === undefined) return 1;
      const { [provider]: _gone, ...rest } = r.keys;
      try {
        writeKeys(file, rest);
        return 0;
      } catch {
        warn(`could not write ${file}.`);
        return 1;
      }
    },
  };
}

/**
 * The macOS Keychain through `/usr/bin/security`, via execFile (never a
 * shell); on Linux and Windows, the credentials file instead.
 */
export function createKeychain(deps: KeychainDeps = {}): Keychain {
  const platform = deps.platform ?? process.platform;
  if (platform === 'linux' || platform === 'win32') return createFileStore(deps);
  const supported = platform === 'darwin';
  const exec = deps.execFile ?? defaultExecFile;
  const inherit = deps.spawnInherit ?? defaultSpawnInherit;
  const withInput = deps.spawnWithInput ?? defaultSpawnWithInput;
  const warn = deps.warn ?? (() => {});
  const user = (): string => deps.user ?? os.userInfo().username;
  return {
    kind: supported ? 'keychain' : 'none',
    label: 'the Keychain',
    supported,
    where: (provider) => `Keychain ${service(provider)}`,
    async read(provider) {
      if (!supported) return undefined;
      try {
        const { stdout } = await exec(SECURITY, [
          'find-generic-password',
          '-a',
          user(),
          '-s',
          service(provider),
          '-w',
        ]);
        const key = stdout.replace(/\r?\n$/, '').trim();
        return key === '' ? undefined : key;
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (code === REAL_KEYCHAIN_IN_TEST) throw e;
        // A non-zero exit is "no such item" (44) or a locked/denied keychain: no key either way.
        if (typeof code !== 'number') {
          const why = typeof code === 'string' ? code : 'error';
          warn(`could not read keychain item ${service(provider)} (${why}).`);
        }
        return undefined;
      }
    },
    async set(provider) {
      if (!supported) return 1;
      // -w last, with no value: `security` prompts for it with hidden input.
      return inherit(SECURITY, [
        'add-generic-password',
        '-U',
        '-a',
        user(),
        '-s',
        service(provider),
        '-w',
      ]);
    },
    async store(provider, value) {
      if (!supported) return 1;
      const account = user();
      if (!QUOTABLE.test(value) || !QUOTABLE.test(account)) return 1;
      return withInput(
        SECURITY,
        ['-i'],
        `add-generic-password -U -a "${account}" -s "${service(provider)}" -w "${value}"\n`,
      );
    },
    async remove(provider) {
      if (!supported) return 1;
      return inherit(SECURITY, ['delete-generic-password', '-a', user(), '-s', service(provider)]);
    },
  };
}
