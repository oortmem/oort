import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTRADICTS,
  DISPLAY_UNSAFE_SOURCE,
  Grant,
  MissingCredentialError,
  grantWrites,
  localGrant,
  scrub,
  type DecisionController,
  type Embedder,
  type Memory,
  type MemoryStore,
  type MemoryWriter,
  type ScopeFilter,
} from '@oortmem/core';
import type { LoginDeps } from './commands/login.js';
import { ROLE_VENDOR, type AdapterRole } from './credentials.js';
import type { Io } from './io.js';
import { PROVIDER_ENV, type Keychain } from './keychain.js';
import type { CloudClient } from './cloud.js';
import type { OutputState } from './output.js';
import type { WireFn, Wired } from './wire.js';

/**
 * A user argument as echoed in a message: scrubbed, clipped to 24 characters,
 * quoted and escaped, so a pasted secret or memory text never comes back
 * (a 20-character AWS key would fit the clip, hence the scrub).
 */
export function echo(arg: string): string {
  const clean = scrubArg(arg);
  // JSON escapes C0 controls; `shown` also catches C1 (\u009b CSI) and bidi overrides.
  return shown(JSON.stringify(clean.length > 24 ? `${clean.slice(0, 23)}…` : clean));
}

/** An Oort key (`oort_sk_…`), which the shared scrubber does not know (it is Oort's own). */
const OORT_KEY = /oort_sk_[A-Za-z0-9_-]{8,}/g;

/** `scrub()` for a command-line argument, Oort keys included. */
export function scrubArg(text: string): string {
  return scrub(text).text.replace(OORT_KEY, '[REDACTED:oort-key]');
}

/**
 * A commander error line as it may be printed (stderr) or put in an `oort.v1` error: every
 * argument it quotes (`'…'`) or lists unquoted (`got 2: anthropic, sk-ant-…`, excess arguments)
 * is echoed (scrubbed, clipped to 24 characters), then the whole line is scrubbed again.
 */
export function commanderText(line: string): string {
  const listed = line.replace(
    /(but got \d+: )(.*)\.(\n?)$/,
    (_m, head: string, list: string, nl: string) =>
      `${head}${list.split(', ').map(echo).join(', ')}.${nl}`,
  );
  const quoted = listed.replace(/'([^'\n]*)'/g, (_m, a: string) => echo(a));
  return shown(scrubArg(quoted), { newlines: true });
}

/**
 * The `oort.v1` error codes (docs/cli.md, "JSON output"): what kind of problem stopped a command,
 * for scripts and agents to branch on. A CLI refusal with any code but `internal` exits 2; an error
 * an adapter or the network raised exits 1 whatever its code (a relay's needs-login, a missing
 * key's needs-key, `network`), as does `internal`.
 */
export type ErrorCode =
  | 'usage'
  | 'not-found'
  | 'ambiguous-id'
  | 'needs-key'
  | 'needs-login'
  | 'needs-confirmation'
  | 'cloud-only'
  | 'network'
  | 'refused'
  | 'internal';

/**
 * A refusal or usage problem: the message is printed and the CLI exits 2 (1 for `internal`).
 * `code` is its `oort.v1` error code (default `usage`); `fix` a command that fixes it, when the
 * message's own first `oort …` command is not the one; `exitCode` keeps a command's documented
 * exit code where it differs (`oort login` exits 1 when the sign-in does not complete).
 */
export class Refusal extends Error {
  readonly code: ErrorCode;
  readonly fix: string | undefined;
  readonly exitCode: number | undefined;

  constructor(message: string, opts: { code?: ErrorCode; fix?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'Refusal';
    this.code = opts.code ?? 'usage';
    this.fix = opts.fix;
    this.exitCode = opts.exitCode;
  }
}

export interface Ctx {
  io: Io;
  wire: WireFn;
  keychain: Keychain;
  /** The network and browser `oort login` uses; tests inject a fake site. */
  login?: LoginDeps;
  /** The network `oort doctor` probes the relay with; tests inject a fake. */
  fetch?: typeof fetch;
  /** The agent to act as (`oort --agent <id>`); wiring falls back to `OORT_AGENT`, then `claude-code`. */
  agent?: string;
  /** The running command's output mode and `oort.v1` envelope state (output.ts); set before it runs. */
  output?: OutputState;
}

/**
 * Prints a warning on stderr (`oort: <message>`) and records it for the `oort.v1` envelope's
 * `warnings`, so a script sees the same degraded state a person reads.
 */
export function warn(ctx: Pick<Ctx, 'io' | 'output'>, code: string, message: string): void {
  ctx.io.err(`oort: ${message}\n`);
  noteWarning(ctx, code, message);
}

/** Records a warning for the envelope only: the command has already told people in its own words. */
export function noteWarning(ctx: Pick<Ctx, 'output'>, code: string, message: string): void {
  ctx.output?.warnings.push({ code, message });
}

/**
 * The acting agent, for header lines: `as claude-code`, or `as cursor (Star)` when its new
 * memories stay in its own Star.
 */
export function agentLabel(w: Pick<Wired, 'agent'>): string {
  if (w.agent.source === 'none') return 'no agent named (Planet only)';
  return `as ${w.agent.id}${w.agent.home === 'star' ? ' (Star)' : ''}`;
}

/**
 * The grant a command changes memories with: the acting agent's local grant. For an agent whose
 * home is its Star the Planet is read-only, so forget, pin and the like never touch it.
 */
export function writeGrant(w: Pick<Wired, 'scope' | 'agent'>): Grant {
  const { orgId, customerId, agentId, projectId } = w.scope;
  return localGrant(
    { orgId, customerId, agentId, projectIds: [...new Set([projectId ?? null, null])] },
    { home: w.agent.home },
  );
}

/** Why a Star agent cannot write in cloud mode, for refusals and the hooks' one stderr line. */
export function starInCloudMessage(agentId: string): string {
  return `${agentId} keeps its memories in its own Star, which Oort Cloud does not have yet, so nothing was saved (your Planet in the cloud is left as it is). Run \`oort connect ${agentId} --no-star\` to write your Planet, or \`oort cloud use --local\`.`;
}

/**
 * Refuses a write in cloud mode by an agent whose home is its Star: the cloud would put it on the
 * shared Planet. Reads are fine.
 */
export function refuseStarInCloud(w: Pick<Wired, 'mode' | 'agent'>): void {
  if (w.mode === 'cloud' && w.agent.home === 'star') {
    throw new Refusal(starInCloudMessage(w.agent.id), { code: 'refused' });
  }
}

/**
 * `writeGrant(w)`, refusing when it cannot change `m`: a memory on the shared Planet, for an
 * agent whose home is its Star. A silent no-op would read as done.
 */
export function writeGrantFor(w: Pick<Wired, 'scope' | 'agent'>, m: Memory): Grant {
  const g = writeGrant(w);
  if (!grantWrites(g, m)) {
    throw new Refusal(
      `${w.agent.id} keeps its memories in its own Star: it reads your Planet but cannot change it. Run this without --agent (or as an agent that writes your Planet).`,
      { code: 'refused' },
    );
  }
  return g;
}

/** The scope a command reads, for header lines: `project <id>` or `global`. */
export function scopeLabel(w: Pick<Wired, 'scope'>): string {
  return w.scope.projectId === undefined ? 'global' : `project ${w.scope.projectId}`;
}

/**
 * The Oort Cloud client when this machine uses the cloud store, undefined in local mode. In cloud
 * mode without a client (no Oort key, a bad URL) it refuses with the reason.
 */
export function cloudOf(
  w: Pick<Wired, 'mode' | 'cloud' | 'cloudProblem'>,
): CloudClient | undefined {
  if (w.mode !== 'cloud') return undefined;
  if (w.cloud === undefined) {
    throw new Refusal(w.cloudProblem ?? 'Oort Cloud is not set up.', { code: 'needs-login' });
  }
  return w.cloud;
}

/**
 * Wires for the cwd, runs `fn`, and always closes the store. `opts.agent` fixes the agent (a
 * Claude Code transcript import is always Claude Code); otherwise `--agent` decides.
 */
export async function withWired<T>(
  ctx: Ctx,
  fn: (w: Wired) => Promise<T>,
  opts: { agent?: string; cloudKeepAlive?: boolean } = {},
): Promise<T> {
  const agent = opts.agent ?? ctx.agent;
  const w = await ctx.wire(ctx.io.cwd, {
    env: ctx.io.env,
    ...(agent !== undefined && { agent }),
    ...(opts.cloudKeepAlive === true && { cloudKeepAlive: true }),
  });
  for (const warning of w.warnings) warn(ctx, warning.code, warning.message);
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

/**
 * What to run when a key is missing, in the order to try: free local models (`oort models pull`,
 * embed and rerank only), your own vendor key, or Oort Pro. Every missing-key message (recall,
 * reembed, saving, init, doctor) uses this one text, for the `roles` that lack a key (all of
 * them when absent, with `<provider>`). For decide and write alone it leaves local models out of
 * the list, since they do neither, and says so. `keyStore: false` (no Keychain or credentials
 * file here) names the environment variables instead of `oort keys set` and `oort login`, which
 * would have nowhere to keep the key.
 */
export function keyRemedy(
  opts: { roles?: readonly AdapterRole[]; keyStore?: boolean; code?: boolean } = {},
): string {
  const c = (s: string): string => (opts.code === false ? s : `\`${s}\``);
  const roles = opts.roles;
  const local = roles === undefined || roles.some((r) => r === 'embed' || r === 'rerank');
  const vendors = roles === undefined ? undefined : [...new Set(roles.map((r) => ROLE_VENDOR[r]))];
  const and = (xs: string[]): string =>
    xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
  const parts = [
    ...(local ? [`${c('oort models pull')} (free local embed and rerank, no keys)`] : []),
    opts.keyStore === false
      ? `set ${vendors === undefined ? 'the key variable (VOYAGE_API_KEY, TYPESAFE_API_KEY or ANTHROPIC_API_KEY)' : and(vendors.map((v) => PROVIDER_ENV[v]))} in the environment your agent starts with`
      : vendors === undefined
        ? c('oort keys set <provider>')
        : and(vendors.map((v) => c(`oort keys set ${v}`))),
    opts.keyStore === false
      ? 'set OORT_API_KEY from oortcloud.dev/account (Oort Pro)'
      : `${c('oort login')} (Oort Pro)`,
  ];
  const list = `${parts.slice(0, -1).join(', ')}, or ${parts.at(-1)}`;
  if (local) return list;
  const what = and((roles ?? []).filter((r) => r === 'decide' || r === 'write'));
  return `${list}; no local model does ${what} (${c('oort models pull')} covers embed and rerank only), so saving needs one of these`;
}

/** The remedy as a sentence: "Run `oort …`, …" or, when it starts with an instruction to set a variable, "Set …". */
export function remedySentence(
  opts: { roles?: readonly AdapterRole[]; keyStore?: boolean; code?: boolean } = {},
): string {
  const r = keyRemedy(opts);
  return r.startsWith('set ') ? `S${r.slice(1)}` : `Run ${r}`;
}

/** Saving (observe, import, MCP remember) needs all three; local models serve only the first. */
export const SAVING_NEEDS =
  'Saving new memories needs embed, decide (TypeSafe) and write (Anthropic). Local models (`oort models pull`) cover only embed (and rerank); decide and write need your own TypeSafe and Anthropic keys, or Oort Pro.';

/**
 * Why an adapter is unavailable, for people: a missing key becomes the shared remedy (never
 * `export KEY=...`, which leaves the key in shell history); any other reason keeps its message.
 */
export function adapterProblem(
  err: Error | undefined,
  role: AdapterRole,
  keyStore = true,
): string | undefined {
  if (err === undefined) return undefined;
  if (err instanceof MissingCredentialError) {
    return `No ${role} model or key. ${remedySentence({ roles: [role], keyStore })}.`;
  }
  return err.message;
}

/**
 * The adapters the write path needs (embed, decide, write). Refuses (exit 2) when any is missing,
 * with each missing adapter's reason and the shared remedy for a missing key.
 */
export function writePath(
  w: Wired,
  what: string,
): { embed: Embedder; decide: DecisionController; write: MemoryWriter } {
  const { embed, decide, write } = w;
  if (embed !== undefined && decide !== undefined && write !== undefined) {
    return { embed, decide, write };
  }
  const missing = (['embed', 'decide', 'write'] as const).filter((r) => w[r] === undefined);
  const reasons = [
    ...new Set(
      missing.map(
        (r) => adapterProblem(w.unavailable[r], r, w.keyStore !== false) ?? `No ${r} adapter.`,
      ),
    ),
  ];
  const keyed = missing.every((r) => w.unavailable[r] instanceof MissingCredentialError);
  throw new Refusal(
    `Saving needs the ${missing.join(', ')} adapter(s), so ${what} saved nothing.\n${reasons.join('\n')}\n${SAVING_NEEDS}`,
    keyed ? { code: 'needs-key', fix: fixForRoles(missing, w.keyStore !== false) } : {},
  );
}

/**
 * The command that supplies the first missing role's model or key: `oort models pull` for embed
 * and rerank, else `oort keys set <vendor>`; undefined where no key can be stored (the fix is an
 * environment variable, not a command).
 */
export function fixForRoles(roles: readonly AdapterRole[], keyStore = true): string | undefined {
  if (roles.some((r) => r === 'embed' || r === 'rerank')) return 'oort models pull';
  const first = roles[0];
  if (first === undefined || !keyStore) return undefined;
  return `oort keys set ${ROLE_VENDOR[first]}`;
}

/**
 * One stderr hint when recall runs without its dense or rerank stage, also recorded as a warning
 * (`lexical-only`, `recall-degraded`) for `--json`. In cloud mode the server embeds and reranks,
 * so no local adapter is expected: only what the server reports counts.
 */
export function degradedHint(
  ctx: Pick<Ctx, 'io' | 'output'>,
  w: Wired,
  degraded: string[] | undefined,
): void {
  const reported = degraded !== undefined && degraded.length > 0;
  if (w.mode === 'cloud') {
    if (reported) warn(ctx, 'recall-degraded', `recall degraded (${degraded.join(', ')}).`);
    return;
  }
  // A relay refusal (Oort Pro) is the reason, and it has its own fix.
  const refused = w.relayErrors?.at(-1);
  if (refused !== undefined) {
    warn(ctx, 'recall-degraded', `recall degraded. ${refused.message}`);
  } else if (w.embed === undefined || w.rerank === undefined) {
    const role: AdapterRole = w.unavailable.embed !== undefined ? 'embed' : 'rerank';
    const why = adapterProblem(w.unavailable[role], role, w.keyStore !== false);
    warn(ctx, 'lexical-only', `lexical-only recall.${why === undefined ? '' : ` ${why}`}`);
  } else if (reported) {
    warn(ctx, 'recall-degraded', `recall degraded (${degraded.join(', ')}).`);
  }
}

/** `p` with the home directory shown as `~`, for human-facing output. */
export function tilde(p: string, home: string): string {
  if (home === '' || home === path.sep) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Compact age: 45s, 12m, 3h, 5d, 7mo, 2y. */
export function age(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return '?';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d`;
  if (s < 86_400 * 365) return `${Math.floor(s / (86_400 * 30))}mo`;
  return `${Math.floor(s / (86_400 * 365))}y`;
}

/**
 * A time for human output: the local date and time, and how long ago (`2026-11-06 14:03 (3h
 * ago)`), or how long until (`in 5d`). `short` gives the local date and time only, for tables.
 * Anything that is not a time is returned as it is.
 */
export function when(iso: string, now: Date, opts: { short?: boolean } = {}): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (opts.short === true) return local;
  const rel = t <= now.getTime() ? `${age(iso, now)} ago` : `in ${age(now.toISOString(), d)}`;
  return `${local} (${rel})`;
}

/**
 * Characters `shown` makes visible: C0 and C1 controls (ESC, CSI \u009b, newlines), DEL, ALM, the
 * zero-width and direction marks U+200B-U+200F, the bidi embeddings and overrides, the invisible
 * operators U+2060-U+2064, the isolates and the BOM. The same set as Oort Cloud's CONTROL_CHARS
 * and the site's displayText; DISPLAY_UNSAFE_SAMPLES is the shared test vector.
 */
// The character class lives in core (DISPLAY_UNSAFE_SOURCE), shared with judgment memory's
// input checks.
const DISPLAY_UNSAFE = new RegExp(DISPLAY_UNSAFE_SOURCE, 'g');

/** One code point from each range of DISPLAY_UNSAFE and its edges (the same list in each repo). */
export const DISPLAY_UNSAFE_SAMPLES = [
  0x00, 0x1b, 0x1f, 0x7f, 0x9b, 0x9f, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e,
  0x2060, 0x2064, 0x2066, 0x2069, 0xfeff,
] as const;

/**
 * A string from Oort Cloud (another member's email hint, an agent or Constellation name, an API
 * message) as it may be printed: every character in DISPLAY_UNSAFE becomes a visible `\u{…}`
 * escape, so nobody can plant terminal escape sequences or invisible text that rewrites or hides
 * output. Never truncates.
 */
export function shown(s: unknown, opts: { newlines?: boolean } = {}): string {
  return String(s).replace(DISPLAY_UNSAFE, (c) =>
    opts.newlines === true && c === '\n' ? c : `\\u{${c.charCodeAt(0).toString(16)}}`,
  );
}

/**
 * DISPLAY_UNSAFE without C0: what JSON.stringify leaves raw inside strings (it escapes C0
 * itself, and pretty-printing puts newlines between tokens, which must stay).
 */
const JSON_UNSAFE = new RegExp(DISPLAY_UNSAFE.source.replace('\\u0000-\\u001f', ''), 'g');

/**
 * `--json` output that may carry other people's strings (memory text, names, email hints): JSON
 * with every DISPLAY_UNSAFE character `\uXXXX`-escaped, so it is still valid JSON (and parses to
 * the same values) but plants no C1 control, bidi override or invisible character in a terminal.
 */
export function safeJson(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(
    JSON_UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** One line, at most `n` characters. */
export function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

export const short = (id: string): string => id.slice(0, 8);

export const fixed = (x: number | undefined, digits = 2): string =>
  x === undefined ? '-' : x.toFixed(digits);

/** A memory as JSON-safe data: the embedding becomes base64 of its int8 bytes. */
export function toJson(m: Memory): Record<string, unknown> {
  const { embedding, ...rest } = m;
  return embedding === undefined
    ? rest
    : {
        ...rest,
        embedding: Buffer.from(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength,
        ).toString('base64'),
      };
}

/** Set when a link was nulled because it points outside the reader's scope. */
export interface HiddenLinkFlags {
  supersedesHidden?: true;
  supersededByHidden?: true;
}

/**
 * `m` shaped for output from `readable`'s point of view (a filter, read with its local grant, or a
 * grant): a `supersedes` or `supersededBy` pointing at a memory it cannot read becomes null and is
 * flagged, and a `level`/`contradicts` decision naming such a memory (another agent's Star) is
 * dropped, so output never names another scope's memory. The store answers an unknown id and an
 * out-of-scope id the same way, so a link to a memory that no longer exists is hidden too. Storage
 * is untouched (recall still ranks by the full record).
 */
export async function shapeLinks<T extends Memory>(
  store: MemoryStore,
  readable: ScopeFilter | Grant,
  m: T,
): Promise<T & HiddenLinkFlags> {
  const grant = Grant.is(readable) ? readable : localGrant(readable);
  const hidden = async (id: string | null): Promise<boolean> =>
    id !== null && (await store.get(grant, id)) === null;
  const out: T & HiddenLinkFlags = { ...m };
  if (await hidden(m.supersedes)) {
    out.supersedes = null;
    out.supersedesHidden = true;
  }
  if (await hidden(m.supersededBy)) {
    out.supersededBy = null;
    out.supersededByHidden = true;
  }
  const decisions = [];
  for (const d of m.source.decisions) {
    const link = d.stage === CONTRADICTS.stage && d.question === CONTRADICTS.question;
    if (!link || !(await hidden(d.answer))) decisions.push(d);
  }
  if (decisions.length !== m.source.decisions.length) {
    out.source = { ...m.source, decisions };
  }
  return out;
}

/** A memory without its embedding, for human-facing JSON. */
export function withoutEmbedding<T extends Memory>(m: T): Omit<T, 'embedding'> {
  const { embedding: _e, ...rest } = m;
  return rest;
}

/**
 * The memory `ref` names, if it is visible from `filter`: an exact id, or a
 * unique prefix of one. The store scopes the lookup, so a memory of another
 * scope is refused exactly like a missing one and ids from other projects
 * reveal nothing.
 */
export async function findMemory(
  store: MemoryStore,
  filter: ScopeFilter,
  ref: string,
): Promise<Memory> {
  const grant = localGrant(filter);
  const exact = await store.get(grant, ref);
  if (exact !== null) return exact;
  const matches = (await store.list(grant, { validOnly: false })).filter((m) =>
    m.id.startsWith(ref),
  );
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) {
    throw new Refusal(`${echo(ref)} matches ${matches.length} memories; give more of the id.`, {
      code: 'ambiguous-id',
    });
  }
  throw new Refusal(`No such memory in this project: ${echo(ref)}.`, { code: 'not-found' });
}

/**
 * Asks y/N, the question on stderr (never stdout, so a piped stdout such as `| tee log` still gets
 * only output). Never prompts where no person can answer or where the answer would be data: when
 * stdin is not a terminal, or with `--json`, it refuses (exit 2) and names `--yes`. A declined
 * question is not an error: callers exit 0.
 */
export async function confirm(
  io: Io,
  question: string,
  yes: boolean,
  flagHint: string,
  opts: { json?: boolean } = {},
): Promise<boolean> {
  if (yes) return true;
  const why =
    opts.json === true
      ? '--json never asks'
      : !io.stdinIsTTY
        ? 'stdin is not a terminal'
        : undefined;
  if (why !== undefined) {
    throw new Refusal(`This needs a confirmation, but ${why}; re-run with --yes to ${flagHint}.`, {
      code: 'needs-confirmation',
    });
  }
  const answer = (await io.ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Writes `data` to a new file, owner-only (0600). An existing file is refused
 * unless `force`, and a symlink is never followed (even with `force`).
 */
export function writeOwnerOnly(file: string, data: string, force = false): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(file);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink() === true) {
    throw new Refusal(`${echo(file)} is a symlink; refusing to write through it.`);
  }
  if (st !== undefined && !force) {
    throw new Refusal(`${echo(file)} already exists; pass --force to overwrite it.`);
  }
  const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC } = fs.constants;
  const flags = O_WRONLY | O_CREAT | NOFOLLOW | (force ? O_TRUNC : O_EXCL);
  let fd: number;
  try {
    fd = fs.openSync(file, flags, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Created or swapped for a symlink since the lstat.
    if (code === 'EEXIST' || code === 'ELOOP') {
      throw new Refusal(`${echo(file)} changed while writing; not written.`);
    }
    throw e;
  }
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}
