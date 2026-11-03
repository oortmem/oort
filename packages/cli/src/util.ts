import * as fs from 'node:fs';
import type {
  DecisionController,
  Embedder,
  Memory,
  MemoryStore,
  MemoryWriter,
  ScopeFilter,
} from '@oortmem/core';
import type { Io } from './io.js';
import type { WireFn, Wired } from './wire.js';

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
}

/** Wires for the cwd, runs `fn`, and always closes the store. */
export async function withWired<T>(ctx: Ctx, fn: (w: Wired) => Promise<T>): Promise<T> {
  const w = await ctx.wire(ctx.io.cwd, { env: ctx.io.env });
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

/**
 * The adapters the write path needs (embed, decide, write). Refuses (exit 2)
 * when any is missing, with each missing adapter's fix (env var, config key).
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

/** One stderr hint when recall runs without its dense or rerank stage. */
export function degradedHint(io: Io, w: Wired, degraded: string[] | undefined): void {
  if (w.embed === undefined || w.rerank === undefined) {
    const why = w.unavailable.embed ?? w.unavailable.rerank;
    io.err(`oort: lexical-only recall. ${why?.message ?? ''}\n`);
  } else if (degraded !== undefined && degraded.length > 0) {
    io.err(`oort: recall degraded (${degraded.join(', ')}).\n`);
  }
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

/** One line, at most `n` characters. */
export function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

export const short = (id: string): string => id.slice(0, 8);

export const fixed = (x: number | undefined, digits = 2): string =>
  x === undefined ? '-' : x.toFixed(digits);

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n') + '\n';
}

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

/** A memory without its embedding, for human-facing JSON. */
export function withoutEmbedding<T extends Memory>(m: T): Omit<T, 'embedding'> {
  const { embedding: _e, ...rest } = m;
  return rest;
}

/**
 * The memory `ref` names: an exact id (read unscoped, as ids come from scoped
 * listings), or a unique prefix of one visible from `filter`.
 */
export async function findMemory(
  store: MemoryStore,
  filter: ScopeFilter,
  ref: string,
): Promise<Memory> {
  const exact = await store.get(ref);
  if (exact !== null) return exact;
  const matches = (await store.list(filter, { validOnly: false })).filter((m) =>
    m.id.startsWith(ref),
  );
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1)
    throw new Refusal(`"${ref}" matches ${matches.length} memories; give more of the id.`);
  throw new Refusal(`No memory with id "${ref}".`);
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

/** Writes `data` to `file`, created or truncated, owner-only (0600). */
export function writeOwnerOnly(file: string, data: string): void {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}
