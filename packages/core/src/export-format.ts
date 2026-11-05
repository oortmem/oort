/**
 * The Oort export format (docs/export-format.md): JSON Lines, a manifest line,
 * then one memory per line. Version 2 (written by default) adds `address`,
 * `author` and `provenance` to every line and keeps `scope` on Planet
 * memories; version 1 has `scope` only and can hold Planet memories only.
 * Readers accept both, version 1 forever.
 */
import {
  addressOf,
  authorOf,
  canonicalMemory,
  planetOf,
  resolveAddressing,
  scopeOf,
  type Address,
  type Author,
} from './address.js';
import type { Memory, Scope } from './model.js';

/** The version `oort export` writes. */
export const EXPORT_FORMAT_VERSION = 2;

export type ExportVersion = 1 | 2;

export interface ExportManifestV1 {
  oort: 'export';
  version: 1;
  exportedAt: string;
  memories: number;
  /** The distinct scopes of the exported memories. */
  scopes: Scope[];
}

export interface ExportManifestV2 {
  oort: 'export';
  version: 2;
  exportedAt: string;
  memories: number;
  /** The distinct scopes of the exported Planet memories. */
  scopes: Scope[];
  /** The distinct addresses of every exported memory. */
  addresses: Address[];
}

export type ExportManifest = ExportManifestV1 | ExportManifestV2;

/** Output-only flags a line may carry (see the format's Limitations). */
export interface HiddenLinkFlags {
  supersedesHidden?: true;
  supersededByHidden?: true;
}

/** Raised for a memory a format version cannot hold, or a file that is not a readable export. */
export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFormatError';
  }
}

const base64 = (v: Int8Array): string =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');

/** True when version 1 can hold `m`: a Planet memory whose author is its scope's agent. */
export function fitsVersion1(m: Memory): boolean {
  const author = authorOf(m);
  return (
    addressOf(m).level === 'user' &&
    author.accountRef === undefined &&
    author.agentId === m.scope.agentId &&
    (m.provenance === undefined || m.provenance === null)
  );
}

/**
 * One memory as an export line of `version`: the embedding as base64 of its
 * int8 bytes. Version 2 always writes `address`, `author` and `provenance`
 * (null when none), and `scope` for Planet memories only.
 */
export function exportLine(
  m: Memory & HiddenLinkFlags,
  version: ExportVersion,
): Record<string, unknown> {
  const { embedding, address: _a, author: _w, provenance, scope, id, ...rest } = m;
  const tail = embedding === undefined ? {} : { embedding: base64(embedding) };
  if (version === 1) {
    if (!fitsVersion1(m)) {
      throw new ExportFormatError(`memory ${id} is not a Planet memory; version 1 cannot hold it`);
    }
    return { id, scope, ...rest, ...tail };
  }
  const address = addressOf(m);
  return {
    id,
    ...(address.level === 'user' && { scope }),
    address,
    author: authorOf(m),
    provenance: provenance ?? null,
    ...rest,
    ...tail,
  };
}

const keyOf = (x: object): string => JSON.stringify(Object.entries(x).sort());

/** The manifest for `memories` written as `version`. */
export function exportManifest(
  memories: Memory[],
  version: ExportVersion,
  exportedAt: Date = new Date(),
): ExportManifest {
  const scopes = new Map<string, Scope>();
  const addresses = new Map<string, Address>();
  for (const m of memories) {
    const a = addressOf(m);
    if (a.level === 'user') scopes.set(keyOf(m.scope), m.scope);
    addresses.set(keyOf(a), a);
  }
  const base = {
    oort: 'export' as const,
    exportedAt: exportedAt.toISOString(),
    memories: memories.length,
    scopes: [...scopes.values()],
  };
  return version === 1
    ? { ...base, version: 1 }
    : { ...base, version: 2, addresses: [...addresses.values()] };
}

/** A whole export: the manifest line, then one line per memory, each ending in `\n`. */
export function formatExport(
  memories: (Memory & HiddenLinkFlags)[],
  version: ExportVersion = EXPORT_FORMAT_VERSION,
  exportedAt: Date = new Date(),
): string {
  return [
    exportManifest(memories, version, exportedAt),
    ...memories.map((m) => exportLine(m, version)),
  ]
    .map((x) => `${JSON.stringify(x)}\n`)
    .join('');
}

export interface ParsedExport {
  version: ExportVersion;
  manifest: ExportManifest;
  /** In the shape stores return (see `canonicalMemory`), embeddings decoded. */
  memories: Memory[];
}

export interface ParseExportOptions {
  /**
   * The importing person's account: Planet memories move to this owner and
   * customer (agent, project and everything else kept), the way an import
   * into another account rewrites the principal. Other levels keep their
   * addresses. Unset: addresses are kept as written.
   */
  planet?: { orgId: string; customerId: string };
}

/**
 * Reads an export of version 1 or 2. A version 1 line's `scope` names the
 * memory's Planet and its agent the author. Throws `ExportFormatError` for an
 * unknown version, a count that does not match, or a line that is not a
 * memory (with its line number, never its content).
 */
export function parseExport(text: string, opts: ParseExportOptions = {}): ParsedExport {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = parseJson(lines[0], 1) as Partial<ExportManifest> | null;
  if (head?.oort !== 'export') throw new ExportFormatError('line 1 is not an Oort export manifest');
  if (head.version !== 1 && head.version !== 2) {
    throw new ExportFormatError(`export version ${String(head.version)} is not supported`);
  }
  const version = head.version;
  if (head.memories !== lines.length - 1) {
    throw new ExportFormatError(
      `the manifest counts ${String(head.memories)} memories, the file has ${lines.length - 1}`,
    );
  }
  const memories = lines.slice(1).map((l, i) => {
    const n = i + 2;
    const raw = parseJson(l, n);
    if (typeof raw !== 'object' || raw === null || typeof raw['id'] !== 'string') {
      throw new ExportFormatError(`line ${n} is not a memory`);
    }
    try {
      return readLine(raw, version, opts);
    } catch (e) {
      if (e instanceof RangeError || e instanceof TypeError) {
        throw new ExportFormatError(`line ${n}: ${e.message}`);
      }
      throw e;
    }
  });
  return { version, manifest: head as ExportManifest, memories };
}

function parseJson(line: string | undefined, n: number): Record<string, unknown> | null {
  try {
    return JSON.parse(line ?? '') as Record<string, unknown> | null;
  } catch {
    throw new ExportFormatError(`line ${n} is not JSON`);
  }
}

function readLine(
  raw: Record<string, unknown>,
  version: ExportVersion,
  opts: ParseExportOptions,
): Memory {
  const {
    embedding,
    address: rawAddress,
    author: rawAuthor,
    provenance,
    scope: rawScope,
    supersedesHidden: _sh,
    supersededByHidden: _bh,
    ...rest
  } = raw;
  let address: Address;
  let author: Author;
  if (version === 1) {
    const scope = rawScope as Scope | undefined;
    if (typeof scope !== 'object' || scope === null)
      throw new RangeError('a version 1 line needs scope');
    address = planetOf(scope);
    author = { agentId: scope.agentId };
  } else {
    ({ address, author } = checked(rawAddress, rawAuthor, rawScope));
  }
  if (opts.planet !== undefined && address.level === 'user') {
    address = { ...address, orgId: opts.planet.orgId, customerId: opts.planet.customerId };
  }
  const m = {
    ...(rest as unknown as Omit<Memory, 'scope'>),
    scope: scopeOf(address, author),
    address,
    author,
    ...(provenance !== undefined && provenance !== null && { provenance }),
    ...(typeof embedding === 'string' && {
      embedding: Int8Array.from(Buffer.from(embedding, 'base64')),
    }),
  } as Memory;
  return canonicalMemory(m);
}

/** A version 2 line's address and author, checked, with its scope (when present) matching them. */
function checked(rawAddress: unknown, rawAuthor: unknown, rawScope: unknown) {
  if (rawAddress === undefined || rawAuthor === undefined) {
    throw new RangeError('a version 2 line needs address and author');
  }
  const probe = { address: rawAddress as Address, author: rawAuthor as Author };
  const want = scopeOf(probe.address, probe.author);
  const { address, author } = resolveAddressing({
    ...probe,
    scope: rawScope === undefined ? want : (rawScope as Scope),
  });
  return { address, author };
}
