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
import type { SpatialFilter } from './place.js';

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

/**
 * The kinds recall follows for one hop (CON-149): stored `explicit` links, and the two indexes,
 * `episode` (the same session, a few turns apart) and `about` (a shared, specific entity).
 */
export type NeighbourKind = 'explicit' | 'episode' | 'about';

/** The order a store gathers kinds in; the budget is checked before each. */
export const NEIGHBOUR_KINDS: readonly NeighbourKind[] = ['explicit', 'episode', 'about'];

/** Options of `MemoryStore.neighbours`. */
export interface NeighbourOptions {
  /** The kinds to gather. An empty list gathers nothing. */
  kinds: readonly NeighbourKind[];
  /** `user`: of the explicit links, only those asserted by `user`. Default: any. */
  explicitBy?: 'user';
  /** Only neighbours that are current in transaction time (not expired, not superseded). */
  currentOnly?: boolean;
  /** Only neighbours that pass this filter: a link never brings in a memory outside the place. */
  spatial?: SpatialFilter;
  /** `about`: an entity in this many readable memories, or more, relates nothing. Default 50. */
  fMax?: number;
  /**
   * Milliseconds the gather may take. Checked before each kind and before each entity's scan;
   * once it has passed the store returns what it has, with `skipped: true`. 0: no limit.
   */
  budgetMs?: number;
  /** The clock the budget is measured with, in ms (tests); default `performance.now`. */
  clock?: () => number;
}

/** One memory a link leads to from a seed. Ids only: no text, no entity. */
export interface Neighbour {
  id: string;
  kind: NeighbourKind;
  /** The seed it was reached from. */
  from: string;
  /** In (0, 1]: 1 for `explicit`; see `episodeWeight` and `aboutWeight`. */
  weight: number;
}

/** What `MemoryStore.neighbours` returns. */
export interface NeighboursResult {
  neighbours: Neighbour[];
  /** The budget passed before every kind and entity was read. */
  skipped?: true;
}

/** `about`: the start value of `fMax`, and the caps of one gather (design section 10). */
export const F_MAX_DEFAULT = 50;
export const EXPLICIT_PER_SEED = 16;
export const EPISODE_REACH = 3;
export const EPISODE_PER_SEED = 6;
export const ABOUT_PER_ENTITY = 20;

/** How many index rows an `about` scan may read for one entity: past `4 × fMax`, it is a hub. */
export const hubScanLimit = (fMax: number): number => 4 * fMax + 1;

/**
 * The weight of a shared entity that `fan` readable memories carry (the seed included):
 * `1 − ln(fan) / ln(fMax)`, never below 0. An entity in `fMax` or more spreads nothing.
 */
export function aboutWeight(fan: number, fMax: number): number {
  if (fan < 2 || fMax < 2 || fan >= fMax) return 0;
  return Math.max(0, 1 - Math.log(fan) / Math.log(fMax));
}

/** Several shared entities combine as a noisy-or, so the result stays in [0, 1]. */
export function combineWeights(ws: readonly number[]): number {
  return 1 - ws.reduce((p, w) => p * (1 - w), 1);
}

/**
 * The weight of an episode neighbour `delta` turns after the seed (negative: before it): 1 for
 * another fact of the same turn, `exp(−|delta| / 3)` later, half that earlier, 0 past the reach.
 */
export function episodeWeight(delta: number): number {
  const d = Math.abs(delta);
  if (d === 0) return 1;
  if (d > EPISODE_REACH) return 0;
  const w = Math.exp(-d / EPISODE_REACH);
  return delta > 0 ? w : w / 2;
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
