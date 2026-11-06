import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMemoryStore,
  resolveConfig,
  type DecisionController,
  type Embedder,
  type MemoryStore,
  type MemoryWriter,
  type Observation,
  type ResolvedConfig,
} from '@oortmem/core';
import { createHookLogger, type HookLogEntry } from '../src/log.js';
import type { HookDeps } from '../src/deps.js';

export const SESSION = '11111111-1111-4111-8111-111111111111';
/** Assembled at runtime so no full key literal sits in a source file. */
export const AWS_KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'session.jsonl');

export interface TempHome {
  root: string;
  home: string;
  /** A project directory (no `.git`, so recall runs in the global scope). */
  cwd: string;
  config: ResolvedConfig;
}

export function tempHome(): TempHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-claude-code-'));
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  return { root, home, cwd, config: resolveConfig(cwd, { OORT_HOME: home }) };
}

/** The synthetic fixture with its placeholders filled in. */
export function fixtureText(cwd: string): string {
  const esc = (s: string): string => JSON.stringify(s).slice(1, -1);
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .replaceAll('__CWD__', esc(cwd))
    .replaceAll('__AWS_KEY__', AWS_KEY);
}

/** Writes the fixture as `<dir>/<session>.jsonl` and returns its path. */
export function writeTranscript(
  dir: string,
  cwd: string,
  session = SESSION,
  text?: string,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, text ?? fixtureText(cwd).replaceAll(SESSION, session));
  return file;
}

export interface Calls {
  embed: number;
  gate: number;
  reconcile: number;
  write: number;
  rerank: number;
  /** Observations the writer saw, in order. */
  written: Observation[];
}

export function newCalls(): Calls {
  return { embed: 0, gate: 0, reconcile: 0, write: 0, rerank: 0, written: [] };
}

/** Deterministic 4-d vectors: one axis per keyword family. */
export function fakeEmbedder(calls: Calls): Embedder {
  return {
    dimension: 4,
    async embed(texts) {
      calls.embed++;
      return texts.map((t) => {
        const s = t.toLowerCase();
        return Int8Array.from([
          s.includes('port') ? 100 : 1,
          s.includes('region') ? 100 : 1,
          s.includes('deploy') ? 100 : 1,
          10,
        ]);
      });
    },
  };
}

/** Stores every turn as a standalone ADD. */
export function fakeDecide(calls: Calls): DecisionController {
  return {
    async gate() {
      calls.gate++;
      return {
        shouldStore: 0.9,
        salience: 0.5,
        types: { semantic: 0.9 },
        decisions: [{ stage: 'gate', question: 'store?', answer: 'yes', probability: 0.9 }],
      };
    },
    async reconcile() {
      calls.reconcile++;
      return [{ candidateId: null, action: 'ADD', probability: 0.9, decisions: [] }];
    },
  };
}

/** Writes the assistant text as the claim. */
export function fakeWriter(calls: Calls, fail?: () => boolean): MemoryWriter {
  return {
    async write(obs) {
      calls.write++;
      calls.written.push(obs);
      if (fail?.()) throw new Error('writer unavailable');
      return {
        text: obs.assistantText,
        stub: obs.assistantText.slice(0, 40),
        entities: [],
        type: 'semantic',
      };
    },
  };
}

export function makeDeps(
  t: TempHome,
  overrides: Partial<HookDeps> & { calls?: Calls; store?: MemoryStore } = {},
): HookDeps & { calls: Calls } {
  const calls = overrides.calls ?? newCalls();
  const { calls: _c, ...rest } = overrides;
  return {
    store: createMemoryStore({ d: t.config.activation.d }),
    embed: fakeEmbedder(calls),
    decide: fakeDecide(calls),
    write: fakeWriter(calls),
    config: t.config,
    log: createHookLogger(t.home),
    ...rest,
    calls,
  };
}

export function readLog(home: string): HookLogEntry[] {
  const file = path.join(home, 'logs', 'hooks.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as HookLogEntry);
}

export function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/** Lines of the session's queue file (parsed), or [] when absent. */
export function queueLines(home: string, session = SESSION): Record<string, unknown>[] {
  const file = path.join(home, 'queue', `${session}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * CPU milliseconds this thread spends in `fn`. Wall-clock time also counts the time spent waiting
 * for a core, which on a loaded machine (a load average of 100+) is most of it; CPU time is what
 * the code itself costs, so a bound on it holds whatever else the machine runs.
 */
export function cpuMs(fn: () => void): number {
  // `threadCpuUsage` (Node 23.9+) leaves out other threads; `cpuUsage` is the whole process.
  const usage = (prev?: NodeJS.CpuUsage): NodeJS.CpuUsage =>
    typeof process.threadCpuUsage === 'function'
      ? process.threadCpuUsage(prev)
      : process.cpuUsage(prev);
  const before = usage();
  fn();
  const spent = usage(before);
  return (spent.user + spent.system) / 1000;
}
