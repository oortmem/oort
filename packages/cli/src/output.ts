import { CommanderError, type Command } from 'commander';
import { MissingCredentialError, scrub } from '@oortmem/core';
import { OortCloudError, type CloudErrorKind } from './cloud.js';
import type { Env, Io } from './io.js';
import { OortRelayError } from './relay.js';
import { PROVIDER_ENV, type Provider } from './keychain.js';
import { Refusal, echo, safeJson, type Ctx, type ErrorCode } from './util.js';

/**
 * The `oort.v1` JSON contract (docs/cli.md, "JSON output"). With `--json` (or `OORT_OUTPUT=json`)
 * stdout carries exactly one envelope:
 *
 *   success: {"schema":"oort.v1","command":"<path>","ok":true,"data":{…},"warnings":[{code,message}]}
 *   failure: {"schema":"oort.v1","command":"<path>","ok":false,"error":{code,message,fix,exitCode}}
 *
 * Everything else a command prints for people goes to stderr in JSON mode, so stdout stays one
 * parseable document. Every envelope goes through `safeJson`.
 */
export const SCHEMA = 'oort.v1';

export interface Warning {
  code: string;
  message: string;
}

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  /** A command that fixes it, or null where none does. */
  fix: string | null;
  exitCode: number;
}

export interface Success<T extends object = Record<string, unknown>> {
  schema: typeof SCHEMA;
  command: string;
  ok: true;
  data: T;
  warnings: Warning[];
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
  emitted: boolean;
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
    emitted: false,
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
 * Prints the success envelope for this run on stdout, with the warnings recorded so far. Called
 * once per run, in JSON mode only.
 */
export function emit<T extends object>(ctx: Pick<Ctx, 'output' | 'io'>, data: DataObject<T>): void {
  const out = ctx.output;
  if (out === undefined || !out.json) throw new Error('emit() outside JSON mode');
  if (out.emitted) throw new Error(`${out.command}: emitted twice`);
  out.emitted = true;
  const env: Success<T> = {
    schema: SCHEMA,
    command: out.command,
    ok: true,
    data,
    warnings: out.warnings,
  };
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
  ctx.output.emitted = true;
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

/** A shell word: plain when safe, else single-quoted. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_\-.,/:=@+%]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `oort <args> <flag>`, runnable, for a fix that is "the same again with --yes". Undefined when
 * an argument would be scrubbed (a pasted secret must not come back in the fix).
 */
export function rerunWith(args: readonly string[], flag: string): string | undefined {
  if (args.some((a) => scrub(a).text !== a)) return undefined;
  const kept = args.filter((a) => a !== flag);
  return ['oort', ...kept, flag].map(shellWord).join(' ');
}

/**
 * The first runnable `oort …` command quoted in a message (`` `oort login` ``), skipping ones with
 * placeholders (`<id>`, `…`): the fix most refusals already name.
 */
export function fixInMessage(message: string): string | undefined {
  for (const m of message.matchAll(/`(oort [^`]+)`/g)) {
    const c = m[1]!;
    if (!/[<>…]|\.\.\./.test(c)) return c;
  }
  return undefined;
}

const CLOUD_CODE: Record<CloudErrorKind, ErrorCode> = {
  unauthorized: 'needs-login',
  'payment-required': 'refused',
  'not-enabled': 'refused',
  'hive-not-enabled': 'refused',
  'rate-limit': 'refused',
  'too-large': 'usage',
  'not-found': 'not-found',
  'ambiguous-prefix': 'ambiguous-id',
  'bad-request': 'usage',
  busy: 'network',
  refused: 'refused',
  network: 'network',
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** A connection that failed (refused, reset, DNS, timeout), from fetch or a socket. */
export function isNetworkError(e: Error): boolean {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  const code = (e as { code?: unknown }).code ?? cause?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return e.name === 'TypeError' && e.message === 'fetch failed';
}

const ENV_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDER_ENV).map(([p, v]) => [v, p as Provider]),
) as Record<string, Provider | undefined>;

/** Error names (other packages' classes) that are a problem with the input, not a bug. */
const USAGE_ERRORS = new Set([
  'JudgmentInputError',
  'JudgmentPackError',
  'ExportFormatError',
  'EmbedderMismatchError',
]);
const REFUSED_ERRORS = new Set(['GrantError', 'ScopeDeniedError']);

/**
 * The one place an error becomes its `oort.v1` code, fix and exit code: every command's refusals
 * (`Refusal` and its `code`), Oort Cloud and relay refusals by kind, a missing key, commander's
 * usage errors, network failures, and anything else as `internal`. `args` builds the "again with
 * --yes" fix.
 */
export function describeError(e: unknown, args: readonly string[]): ErrorInfo {
  const err = e instanceof Error ? e : new Error(String(e));
  // Exit codes stay as docs/cli.md has them: 2 for the CLI's own refusals and usage errors (1
  // for one coded `internal`), 1 for anything raised outside them (an adapter's relay or key
  // error, a network failure), whatever its code.
  const own = err instanceof Refusal || err instanceof CommanderError;
  const make = (code: ErrorCode, message: string, fix?: string, exitCode?: number): ErrorInfo => ({
    code,
    message,
    fix: fix ?? fixInMessage(message) ?? null,
    exitCode: exitCode ?? (own && code !== 'internal' ? 2 : 1),
  });
  if (err instanceof CommanderError) {
    // Commander's own wording, scrubbed like its stderr line (program.ts outputError).
    const message = err.message
      .replace(/^error: /, '')
      .replace(/'([^'\n]*)'/g, (_m, a: string) => echo(a));
    return make('usage', message, 'oort --help');
  }
  if (err instanceof OortCloudError) return make(CLOUD_CODE[err.kind], err.message);
  if (err instanceof Refusal) {
    const fix =
      err.fix ?? (err.code === 'needs-confirmation' ? rerunWith(args, '--yes') : undefined);
    return make(err.code, err.message, fix, err.exitCode);
  }
  if (err instanceof OortRelayError) {
    const code: ErrorCode =
      err.kind === 'unauthorized' ? 'needs-login' : err.kind === 'busy' ? 'network' : 'refused';
    return make(code, err.message, code === 'needs-login' ? 'oort login' : undefined);
  }
  if (err instanceof MissingCredentialError) {
    const provider = ENV_PROVIDER[err.envVar];
    return make(
      'needs-key',
      err.message,
      provider === 'voyage'
        ? 'oort models pull'
        : provider !== undefined
          ? `oort keys set ${provider}`
          : undefined,
    );
  }
  if (USAGE_ERRORS.has(err.name)) return make('usage', err.message);
  if (REFUSED_ERRORS.has(err.name)) return make('refused', err.message);
  if (isNetworkError(err)) return make('network', err.message);
  return make('internal', err.message);
}
