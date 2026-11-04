import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHookLogger } from '@oortmem/claude-code';
import {
  MissingCredentialError,
  createMemoryStore,
  localScope,
  resolveConfig,
  type DecisionController,
  type Embedder,
  type Memory,
  type MemoryStore,
  type MemoryWriter,
} from '@oortmem/core';
import type { Io } from '../src/io.js';
import type { LoginDeps } from '../src/commands/login.js';
import { createKeychain, type Keychain } from '../src/keychain.js';
import { runCli } from '../src/program.js';
import type { WireFn, Wired } from '../src/wire.js';

export function tmpdir(prefix = 'oort-cli-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface FakeIo extends Io {
  stdout: string;
  stderr: string;
  /** What `hookExit` was given, or undefined if it was never called. */
  hookStdout: string | undefined;
  hookExits: number;
  spawned: number;
  /** The cwd of each `spawnDrain`. */
  spawnCwds: string[];
  asked: string[];
}

export function fakeIo(opts: {
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  tty?: boolean;
  /** stdout is a terminal (colour on unless NO_COLOR). */
  stdoutTTY?: boolean;
  answer?: string;
  /** What `askSecret` returns. */
  secret?: string;
}): FakeIo {
  const io: FakeIo = {
    cwd: opts.cwd,
    env: opts.env ?? {},
    entry: undefined,
    stdinIsTTY: opts.tty ?? false,
    stdoutIsTTY: opts.stdoutTTY ?? false,
    stdout: '',
    stderr: '',
    hookStdout: undefined,
    hookExits: 0,
    spawned: 0,
    spawnCwds: [],
    asked: [],
    out(t) {
      io.stdout += t;
    },
    err(t) {
      io.stderr += t;
    },
    async readStdin() {
      return opts.stdin ?? '';
    },
    async ask(q) {
      io.asked.push(q);
      return opts.answer ?? '';
    },
    async askSecret(q) {
      io.asked.push(q);
      return opts.secret ?? '';
    },
    spawnDrain(cwd) {
      io.spawned++;
      io.spawnCwds.push(cwd);
    },
    hookExit(stdout) {
      io.hookExits++;
      io.hookStdout = stdout;
    },
  };
  return io;
}

export interface Harness {
  root: string;
  home: string;
  cwd: string;
  store: MemoryStore;
  wire: WireFn;
  /** How many times `wire` was called. */
  wired: number;
  run(
    args: string[],
    io?: Partial<Parameters<typeof fakeIo>[0]>,
    keychain?: Keychain,
    deps?: { login?: LoginDeps; fetch?: typeof fetch },
  ): Promise<{ code: number; io: FakeIo }>;
}

export const fakeEmbedder: Embedder = {
  dimension: 4,
  async embed(texts) {
    return texts.map(() => Int8Array.from([10, 20, 30, 40]));
  },
};

export const fakeDecide: DecisionController = {
  async gate() {
    return { shouldStore: 0.9, salience: 0.5, types: { semantic: 1 }, decisions: [] };
  },
  async reconcile() {
    return [{ candidateId: null, action: 'ADD', probability: 0.9, decisions: [] }];
  },
};

export const fakeWriter: MemoryWriter = {
  async write(obs) {
    return {
      text: obs.assistantText,
      stub: obs.assistantText.slice(0, 20),
      entities: [],
      type: 'semantic',
    };
  },
};

/**
 * A temp `OORT_HOME` and an in-memory store behind an injected `wire`. With
 * `adapters: false` the wire reports every adapter missing, as without keys.
 */
export function harness(opts: { adapters?: boolean } = {}): Harness {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const store = createMemoryStore();
  const h: Harness = {
    root,
    home,
    cwd,
    store,
    wired: 0,
    wire: async (dir) => {
      h.wired++;
      const config = resolveConfig(dir, { OORT_HOME: home });
      const keyed = opts.adapters !== false;
      const w: Wired = {
        config,
        scope: localScope(undefined),
        store,
        unavailable: keyed
          ? {}
          : {
              embed: new MissingCredentialError('VOYAGE_API_KEY', 'embed.apiKey'),
              rerank: new MissingCredentialError('VOYAGE_API_KEY', 'rerank.apiKey'),
              decide: new MissingCredentialError('TYPESAFE_API_KEY', 'decide.apiKey'),
              write: new MissingCredentialError('ANTHROPIC_API_KEY', 'writer.apiKey'),
            },
        harnessLog: createHookLogger(home),
        warnings: [],
        close: async () => {},
        ...(keyed && { embed: fakeEmbedder, decide: fakeDecide, write: fakeWriter }),
      };
      return w;
    },
    async run(args, ioOpts = {}, keychain = createKeychain({ platform: 'none' }), deps = {}) {
      // HOME is the temp root too, so nothing can reach the real ~/.claude or ~/.oort.
      const io = fakeIo({ cwd, env: { HOME: root, OORT_HOME: home }, ...ioOpts });
      const code = await runCli(args, io, h.wire, keychain, deps);
      return { code, io };
    },
  };
  return h;
}

/** A current global-scope memory; override any field. */
export function memory(over: Partial<Memory> = {}): Memory {
  const iso = over.createdAt ?? '2026-10-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    scope: localScope(undefined),
    type: 'semantic',
    text: 'The auth service listens on port 5582.',
    stub: 'auth service port',
    entities: ['auth-service'],
    salience: 0.5,
    pinned: false,
    tier: 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: iso,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'claude-code', decisions: [] },
    embedding: Int8Array.from([1, -2, 3, -4]),
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

/** Assembled at runtime so no full key literal sits in a source file. */
export const AWS_KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
export const syntheticKey = (name: string): string =>
  ['test', name, 'not', 'a', 'real', 'key'].join('-');

const FIXTURE = path.join(
  import.meta.dirname,
  '..',
  '..',
  'claude-code',
  'test',
  'fixtures',
  'session.jsonl',
);

/** Writes claude-code's synthetic session transcript under `projectsDir`, recorded at `cwd`. */
export function writeTranscript(projectsDir: string, cwd: string): string {
  const esc = (s: string): string => JSON.stringify(s).slice(1, -1);
  const dir = path.join(projectsDir, 'synthetic-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(FIXTURE, 'utf8')
      .replaceAll('__CWD__', esc(cwd))
      .replaceAll('__AWS_KEY__', AWS_KEY),
  );
  return file;
}

/**
 * A Keychain held in memory, shaped like the macOS one (`security` argv and
 * `security -i` input are parsed back), so tests never touch a real Keychain.
 */
export function memoryKeychain(items: Record<string, string> = {}): {
  kc: Keychain;
  items: Record<string, string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const service = (args: string[]): string => args[args.indexOf('-s') + 1] ?? '';
  const kc = createKeychain({
    platform: 'darwin',
    user: 'tester',
    execFile: async (_f, args) => {
      calls.push(args);
      const v = items[service(args)];
      if (v === undefined) throw Object.assign(new Error('not found'), { code: 44 });
      return { stdout: `${v}\n` };
    },
    spawnInherit: async (_f, args) => {
      calls.push(args);
      if (args[0] !== 'delete-generic-password') return 1;
      if (items[service(args)] === undefined) return 44;
      delete items[service(args)];
      return 0;
    },
    spawnWithInput: async (_f, args, input) => {
      calls.push(args);
      const m = /^add-generic-password -U -a "[^"]+" -s "([^"]+)" -w "([^"]+)"\n$/.exec(input);
      if (m === null) return 1;
      items[m[1] ?? ''] = m[2] ?? '';
      return 0;
    },
    warn: () => {},
  });
  return { kc, items, calls };
}
