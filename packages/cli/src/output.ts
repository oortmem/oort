import { CommanderError, type Command } from 'commander';
import { describeError as describeOther, type ErrorInfo } from './describe-error.js';
import type { Env, Io } from './io.js';
import { commanderText, safeJson, scrubArg, shown, type Ctx } from './util.js';

export { fixInMessage, isNetworkError, type ErrorInfo } from './describe-error.js';

/**
 * The `oort.v1` JSON contract (docs/cli.md, "JSON output"). With `--json` (or `OORT_OUTPUT=json`)
 * stdout carries exactly one envelope:
 *
 *   success: {"schema":"oort.v1","command":"<path>","ok":true,"data":{…},"warnings":[{code,message}]}
 *            (and "exitCode" when the command exits non-zero: serve status 1, import 3)
 *   failure: {"schema":"oort.v1","command":"<path>","ok":false,"error":{code,message,fix,exitCode}}
 *
 * Everything else a command prints for people goes to stderr in JSON mode, so stdout stays one
 * parseable document. Every envelope goes through `safeJson`. `oort hook`, `oort mcp` and a
 * foreground `oort serve` never print one (`exempt`).
 */
export const SCHEMA = 'oort.v1';

export interface Warning {
  code: string;
  message: string;
}

export interface Success<T extends object = Record<string, unknown>> {
  schema: typeof SCHEMA;
  command: string;
  ok: true;
  data: T;
  warnings: Warning[];
  /** Only when the command exits non-zero although it succeeded (serve status 1, import 3). */
  exitCode?: number;
}

export interface Failure {
  schema: typeof SCHEMA;
  command: string;
  ok: false;
  error: ErrorInfo;
}

/** The running command's output state, on `ctx.output` (set by `startOutput`). */
export interface OutputState {
  /** The command path: `recall`, `constellation create`, `judge pack import`. */
  command: string;
  /** `--json`, or `OORT_OUTPUT=json` on a command that has `--json`. */
  json: boolean;
  /** `--json` was on the command line (not only `OORT_OUTPUT`). */
  explicit: boolean;
  warnings: Warning[];
  /** The real stdout: in JSON mode `ctx.io.out` goes to stderr. */
  stdout: (text: string) => void;
  /** The success data `emit` was given, printed by `flush` once the command and its cleanup end. */
  pending?: object;
  /** Something reached stdout: a flushed envelope, or a format of its own (`rawOut`). */
  written: boolean;
}

/** True when `OORT_OUTPUT=json` asks for JSON on every command that has `--json`. */
export function jsonFromEnv(env: Env): boolean {
  return env['OORT_OUTPUT']?.trim().toLowerCase() === 'json';
}

/**
 * Sets up `ctx` for one command run: records the command path and output mode, and in JSON mode
 * points `ctx.io.out` at stderr (human lines stay visible, stdout carries only the envelope).
 */
export function startOutput(ctx: Ctx, command: string, json: boolean, explicit: boolean): void {
  const io = ctx.io;
  ctx.output = {
    command,
    json,
    explicit,
    warnings: [],
    stdout: (t) => io.out(t),
    written: false,
  };
  if (json) {
    const human: Io = { ...io, out: (t) => io.err(t), stdoutIsTTY: false };
    ctx.io = human;
  }
}

/** Whether this run prints `oort.v1` JSON. */
export function jsonMode(ctx: Pick<Ctx, 'output'>): boolean {
  return ctx.output?.json === true;
}

/** Data, never an array: `data` is always an object (wrap lists: `{ memories: [...] }`). */
type DataObject<T> = T extends readonly unknown[] ? never : T;

/**
 * This run's success data: once per run, in JSON mode only. Nothing is printed yet: `flush` prints
 * the envelope after the command and its cleanup (`withWired` closing the store) have finished, so
 * an error after this point prints the failure envelope instead, never both.
 */
export function emit<T extends object>(ctx: Pick<Ctx, 'output' | 'io'>, data: DataObject<T>): void {
  const out = ctx.output;
  if (out === undefined || !out.json) throw new Error('emit() outside JSON mode');
  if (out.pending !== undefined || out.written) throw new Error(`${out.command}: emitted twice`);
  out.pending = data;
}

/** Whether this run has its output: success data waiting, or something already on stdout. */
export function emitted(out: OutputState): boolean {
  return out.pending !== undefined || out.written;
}

/**
 * Prints the success envelope `emit` buffered, with the warnings recorded meanwhile and, when the
 * command exits non-zero (serve status 1, import 3), that exit code.
 */
export function flush(ctx: Pick<Ctx, 'output'>, exitCode: number): void {
  const out = ctx.output;
  if (out?.pending === undefined) return;
  const env: Success<object> = {
    schema: SCHEMA,
    command: out.command,
    ok: true,
    data: out.pending,
    warnings: out.warnings,
    ...(exitCode !== 0 && { exitCode }),
  };
  out.pending = undefined;
  out.written = true;
  out.stdout(`${safeJson(env)}\n`);
}

/**
 * Data that is its own format on stdout (`export`'s JSON Lines, a judgment pack): written to the
 * real stdout whatever the mode.
 */
export function rawOut(ctx: Pick<Ctx, 'output' | 'io'>, text: string): void {
  if (ctx.output === undefined) return ctx.io.out(text);
  ctx.output.stdout(text);
  // That format is this run's output: no envelope follows it.
  ctx.output.written = true;
}

/**
 * Runs another command's function inside this one (setup pulling models, importing) as human
 * output: in JSON mode its lines go to stderr with the rest, and only the outer command emits.
 */
export async function nested<T>(ctx: Pick<Ctx, 'output'>, fn: () => Promise<T>): Promise<T> {
  const out = ctx.output;
  if (out === undefined || !out.json) return fn();
  out.json = false;
  try {
    return await fn();
  } finally {
    out.json = true;
  }
}

/** The failure envelope. */
export function failure(command: string, error: ErrorInfo): Failure {
  return { schema: SCHEMA, command, ok: false, error };
}

/** `constellation create` for that subcommand: the names from the root down, the root left out. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c !== null && c.parent !== null; c = c.parent) {
    names.unshift(c.name());
  }
  return names.join(' ');
}

/**
 * The command `args` name (for a usage error commander raises before any action runs): the
 * subcommands they walk, skipping options and the values of options that take one.
 */
export function commandFor(root: Command, args: readonly string[]): Command {
  let cmd = root;
  let skip = false;
  for (const a of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (a === '--') break;
    if (a.startsWith('-')) {
      const flag = a.split('=')[0]!;
      const opt = [...cmd.options, ...root.options].find(
        (o) => o.long === flag || o.short === flag,
      );
      skip = opt !== undefined && !a.includes('=') && (opt.required || opt.optional);
      continue;
    }
    const sub = cmd.commands.find((c) => c.name() === a || c.aliases().includes(a));
    if (sub === undefined) break;
    cmd = sub;
  }
  return cmd;
}

/** Whether a command defines `--json`. */
export function hasJsonOption(cmd: Command): boolean {
  return cmd.options.some((o) => o.long === '--json');
}

/**
 * `serve`'s action as its command name: `serve status`, `serve stop`, or `serve start` (the
 * default, in the foreground unless `--detach`). Other commands' paths are as they are.
 */
export function commandName(path: string, serveAction: string | undefined): string {
  return path === 'serve' ? `serve ${serveAction ?? 'start'}` : path;
}

/** The commands that never print an envelope: the hook protocol, MCP on stdio, a foreground serve. */
export function exempt(name: string, detach: boolean): boolean {
  return name === 'hook' || name === 'mcp' || (name === 'serve start' && !detach);
}

/** `serve`'s action in raw arguments (for a usage error before any action ran). */
export function serveActionIn(args: readonly string[]): string | undefined {
  const i = args.indexOf('serve');
  return args
    .slice(i + 1)
    .find((a) => a === 'status' || a === 'stop' || a === 'start' || a === 'token');
}

/** Options whose value is an id, a name or an enum: the only values a rerun fix repeats. */
const ID_VALUE_OPTIONS = new Set([
  '--agent',
  '--to',
  '--keep',
  '--role',
  '--since',
  '--format',
  '--galaxy',
  '--constellation',
  '--id',
  '--domain',
]);

/** An id, a name or an enum value: one word, no path, no spaces, nothing a scrubber would cut. */
const ID_WORD = /^[A-Za-z0-9][A-Za-z0-9_.:@,+-]{0,63}$/;

/**
 * `oort <args> <flag>`, runnable, for a fix that is "the same again with --yes": only when every
 * argument is a known flag, a subcommand, an id or an enum (`cmd` names the options). Free text
 * (`--text`, `--by`, a path) is never repeated: the fix is then the sentence instead.
 */
export function rerunWith(
  root: Command,
  cmd: Command,
  args: readonly string[],
  flag: string,
): string {
  const sentence = `re-run the same command with ${flag}`;
  const options = [...cmd.options, ...root.options];
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) continue;
    if (scrubArg(a) !== a) return sentence;
    if (a.startsWith('-')) {
      const [name, inline] = a.split(/=(.*)/s) as [string, string | undefined];
      const opt = options.find((o) => o.long === name || o.short === name);
      if (opt === undefined) return sentence;
      kept.push(a);
      if (!opt.required && !opt.optional) continue;
      const value = inline ?? args[++i];
      if (value === undefined || !ID_VALUE_OPTIONS.has(opt.long ?? '') || !ID_WORD.test(value)) {
        return sentence;
      }
      if (inline === undefined) kept.push(value);
      continue;
    }
    if (!ID_WORD.test(a)) return sentence;
    kept.push(a);
  }
  return shown(['oort', ...kept, flag].join(' '));
}

/**
 * The one place an error becomes its `oort.v1` code, fix and exit code: commander's usage errors
 * here, and everything else (every command's refusals, Oort Cloud and relay refusals by kind, a
 * missing key, network failures, anything else as `internal`) in `describe-error.ts`, which the
 * SDK shares. `rerun` gives the "again with --yes" fix for the command that ran.
 */
export function describeError(e: unknown, rerun: (flag: string) => string): ErrorInfo {
  if (e instanceof CommanderError) {
    // Commander's own wording, every argument scrubbed and clipped as on its stderr line.
    const message = commanderText(e.message.replace(/^error: /, ''));
    return { code: 'usage', message, fix: shown('oort --help'), exitCode: 2 };
  }
  return describeOther(e, rerun);
}
