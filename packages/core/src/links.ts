/**
 * Memory relationships (CON-145; design `docs/design/2026-11-12-memory-relationships.md`): the
 * types a store with `links: true` takes and returns, and the rules every such store applies the
 * same way (which memories the entity index holds, and how an entity becomes its key).
 *
 * Links carry no content: ids, a kind, who asserted it and when. Both ends are in one node, never
 * at level `hive`, and a link is removed with either end (`forget`).
 */
import { addressOf } from './address.js';
import type { Memory } from './model.js';

/** The link kinds a store keeps as rows. `about` and `episode` are indexes, never rows. */
export type StoredLinkKind = 'explicit' | 'distilledFrom' | 'recalledWith';

/** The kinds `linksOf` lists, as stored. */
export const STORED_LINK_KINDS: readonly StoredLinkKind[] = [
  'explicit',
  'distilledFrom',
  'recalledWith',
];

/**
 * Who asserted an explicit link or a block. `user` means it was confirmed at a terminal
 * (`oort link`, answered on the controlling terminal); `agent` is everything else: MCP, the SDK,
 * `oort serve`, an import, and `oort link` without a terminal or a confirmation.
 *
 * `user` is a record of how the link was made, not proof that a person made it: a program with a
 * shell can drive a terminal. Nothing may give a `user` link more access than an `agent` link.
 * Its one effect is that an `agent` call cannot remove or weaken it.
 */
export type AssertedBy = 'user' | 'agent';

/** One stored link of a memory, as `linksOf` lists it. */
export interface StoredLink {
  kind: StoredLinkKind;
  /** The memory at the other end. */
  id: string;
  /**
   * `both` for an undirected kind (`explicit`, `recalledWith`); for `distilledFrom`, `out` on
   * the distilled memory (its evidence is the other end) and `in` on a piece of evidence.
   */
  direction: 'both' | 'out' | 'in';
  /** `explicit` only. */
  assertedBy?: AssertedBy;
  createdAt: string;
}

/** What `MemoryStore.linksOf` returns for a memory the grant reads. */
export interface LinksOf {
  /** Links whose other end the grant reads, oldest first. */
  links: StoredLink[];
  /** Pairs a person or agent unlinked (blocks) whose other end the grant reads. */
  blocked: string[];
  /** Stored link rows (`explicit`, `distilledFrom`, `recalledWith`) whose other end it cannot read. */
  hidden: number;
}

/** Options of `MemoryStore.link` and `unlink`. */
export interface LinkOptions {
  assertedBy: AssertedBy;
  /** When the row is written; default now. */
  at?: Date;
}

/** What `MemoryStore.link` did. */
export interface LinkResult {
  /** False when an explicit link already held, asserted at least as strongly. */
  linked: boolean;
  /** A block on the pair was removed. */
  unblocked: boolean;
  /** Who the stored link is asserted by now (a person's assertion is never weakened). */
  assertedBy: AssertedBy;
  /**
   * Set when nothing was changed because the pair is blocked by a `user` unlink and this call is
   * asserted by `agent`: only a `user` link removes a `user` block.
   */
  refused?: 'asserted-by-user';
}

/** What `MemoryStore.unlink` did. */
export interface UnlinkResult {
  /** An `explicit` or `recalledWith` row between the two was deleted. */
  removed: boolean;
  /** A block on the pair exists now. */
  blocked: boolean;
  /**
   * Set when nothing was changed because the pair's explicit link is asserted by `user` and this
   * call is asserted by `agent`: only a `user` unlink removes a `user` link.
   */
  refused?: 'asserted-by-user';
}

/** Entity keys shorter than this, or longer than `ENTITY_KEY_MAX`, are not indexed. */
export const ENTITY_KEY_MIN = 2;
export const ENTITY_KEY_MAX = 128;
/** At most this many entity keys per memory. */
export const ENTITY_KEYS_PER_MEMORY = 16;

/**
 * An entity as the index keys it: NFKC, lower case (locale-free), trimmed, inner whitespace
 * collapsed to one space. Undefined when the key is shorter than `ENTITY_KEY_MIN` or longer than
 * `ENTITY_KEY_MAX` characters.
 */
export function entityKey(entity: string): string | undefined {
  const k = entity.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
  const n = [...k].length;
  return n < ENTITY_KEY_MIN || n > ENTITY_KEY_MAX ? undefined : k;
}

/** A memory's distinct entity keys, in order, at most `ENTITY_KEYS_PER_MEMORY`. */
export function entityKeys(entities: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of entities) {
    const k = typeof e === 'string' ? entityKey(e) : undefined;
    if (k === undefined) continue;
    out.add(k);
    if (out.size === ENTITY_KEYS_PER_MEMORY) break;
  }
  return [...out];
}

/**
 * Whether a memory belongs in the entity index (`about`) and has an episode position: it is
 * current in transaction time (not expired, not superseded) and not at level `hive` (no link of
 * any kind lives in a Constellation or Galaxy, decision 4). A cold memory that is still current
 * keeps its place.
 */
export function inLinkIndexes(
  m: Pick<Memory, 'expiredAt' | 'supersededBy' | 'scope' | 'address'>,
): boolean {
  return m.expiredAt === null && m.supersededBy === null && addressOf(m).level !== 'hive';
}

/**
 * Whether `m` gets an episode position: it has a session (`source.sessionId`, a string) and is
 * not at level `hive`. It keeps the position when it later expires or is superseded.
 */
export function episodeSession(
  m: Pick<Memory, 'source' | 'scope' | 'address'>,
): string | undefined {
  const s = m.source.sessionId;
  return typeof s === 'string' && s !== '' && addressOf(m).level !== 'hive' ? s : undefined;
}

/** The two ends of an undirected pair in the order a store keeps them (`a < b`). */
export function orderedPair<T extends string | number>(a: T, b: T): [T, T] {
  return a < b ? [a, b] : [b, a];
}

/**
 * What `linksConformance` reads below the seam, to prove that nothing of a memory survives in
 * the store's own rows. Every store with `links: true` provides one for its conformance run
 * (`memoryStoreProbe` for the in-memory store).
 */
export interface LinksProbe {
  /** Every entity index row, by memory id. */
  entities(): Promise<{ id: string; entity: string }[]>;
  /** Every link and block row, by memory id (`a < b` for undirected kinds). */
  links(): Promise<{ kind: string; a: string; b: string; assertedBy: AssertedBy | null }[]>;
  /** Every memory's episode position. */
  episodes(): Promise<{ id: string; session: string; seq: number }[]>;
  /** Entity, link or block rows whose memory no longer exists: always 0. */
  orphans(): Promise<number>;
}
