import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTRADICTS,
  Grant,
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
import type { Io } from './io.js';
import type { Keychain } from './keychain.js';
import type { CloudClient } from './cloud.js';
import type { WireFn, Wired } from './wire.js';

/**
 * A user argument as echoed in a message: scrubbed, clipped to 24 characters,
 * quoted and escaped, so a pasted secret or memory text never comes back
 * (a 20-character AWS key would fit the clip, hence the scrub).
 */
export function echo(arg: string): string {
  const clean = scrub(arg).text;
  // JSON escapes C0 controls; `shown` also catches C1 (\u009b CSI) and bidi overrides.
  return shown(JSON.stringify(clean.length > 24 ? `${clean.slice(0, 23)}…` : clean));
}

/** A refusal or usage problem: the message is printed and the CLI exits 2. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
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
    throw new Refusal(starInCloudMessage(w.agent.id));
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
export function cloudOf(w: Wired): CloudClient | undefined {
  if (w.mode !== 'cloud') return undefined;
  if (w.cloud === undefined) throw new Refusal(w.cloudProblem ?? 'Oort Cloud is not set up.');
  return w.cloud;
}

/**
 * Wires for the cwd, runs `fn`, and always closes the store. `opts.agent` fixes the agent (a
 * Claude Code transcript import is always Claude Code); otherwise `--agent` decides.
 */
export async function withWired<T>(
  ctx: Ctx,
  fn: (w: Wired) => Promise<T>,
  opts: { agent?: string } = {},
): Promise<T> {
  const agent = opts.agent ?? ctx.agent;
  const w = await ctx.wire(ctx.io.cwd, {
    env: ctx.io.env,
    ...(agent !== undefined && { agent }),
  });
  for (const warning of w.warnings) ctx.io.err(`oort: ${warning.message}\n`);
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

/**
 * The adapters the write path needs (embed, decide, write). Refuses (exit 2)
 * when any is missing, with each missing adapter's fix (the env var to export).
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
  const reasons = [...new Set(missing.map((r) => w.unavailable[r]?.message ?? `No ${r} adapter.`))];
  throw new Refusal(`${what} needs the ${missing.join(', ')} adapter(s).\n${reasons.join('\n')}`);
}

/**
 * One stderr hint when recall runs without its dense or rerank stage. In cloud mode the server
 * embeds and reranks, so no local adapter is expected: only what the server reports counts.
 */
export function degradedHint(io: Io, w: Wired, degraded: string[] | undefined): void {
  const reported = degraded !== undefined && degraded.length > 0;
  if (w.mode === 'cloud') {
    if (reported) io.err(`oort: recall degraded (${degraded.join(', ')}).\n`);
    return;
  }
  // A relay refusal (Oort Pro) is the reason, and it has its own fix.
  const refused = w.relayErrors?.at(-1);
  if (refused !== undefined) {
    io.err(`oort: recall degraded. ${refused.message}\n`);
  } else if (w.embed === undefined || w.rerank === undefined) {
    const why = w.unavailable.embed ?? w.unavailable.rerank;
    io.err(`oort: lexical-only recall.${why === undefined ? '' : ` ${why.message}`}\n`);
  } else if (reported) {
    io.err(`oort: recall degraded (${degraded.join(', ')}).\n`);
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
 * A string from Oort Cloud (another member's email hint, an agent or Constellation name, an API
 * message) as it may be printed: every C0 and C1 control character (ESC, CSI \u009b, newlines,
 * DEL) and bidi override becomes a visible `\u{…}` escape, so nobody can plant terminal escape
 * sequences that rewrite or hide output. Never truncates.
 */
export function shown(s: unknown, opts: { newlines?: boolean } = {}): string {
  return String(s).replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => (opts.newlines === true && c === '\n' ? c : `\\u{${c.charCodeAt(0).toString(16)}}`),
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
    throw new Refusal(`${echo(ref)} matches ${matches.length} memories; give more of the id.`);
  }
  throw new Refusal(`No such memory in this project: ${echo(ref)}.`);
}

/** Asks y/N on a terminal; refuses when stdin is not a terminal and `--yes` was not given. */
export async function confirm(
  io: Io,
  question: string,
  yes: boolean,
  flagHint: string,
): Promise<boolean> {
  if (yes) return true;
  if (!io.stdinIsTTY)
    throw new Refusal(`stdin is not a terminal; re-run with --yes to ${flagHint}.`);
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
