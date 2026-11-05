import {
  addressOf,
  authorOf,
  GALAXY_ROOT,
  nodeKey,
  nodeOf,
  spaceName,
  type Level,
  type NodeRef,
} from './address.js';
import { readableNodes, type Grant } from './grant.js';
import type { Memory } from './model.js';

/**
 * The levels a recall can name in `include` (spec 7.1): `self` is the
 * caller's home node, `planet` the person's Planet, `star` the calling agent's
 * own Star, `constellation` and `galaxy` the hive nodes. Always intersected
 * with the grant.
 */
export type IncludeLevel = 'self' | 'planet' | 'star' | 'constellation' | 'galaxy';

export const INCLUDE_LEVELS: readonly IncludeLevel[] = Object.freeze([
  'self',
  'planet',
  'star',
  'constellation',
  'galaxy',
]);

export const isIncludeLevel = (s: string): s is IncludeLevel =>
  (INCLUDE_LEVELS as readonly string[]).includes(s);

/** At most this many hive nodes are read by default (spec 7.1: one recall, a bounded fan-out). */
export const DEFAULT_HIVE_NODES = 4;

/**
 * A recall asked for a level its grant does not cover. Typed, so callers tell
 * "you may not read that" apart from "nothing matched" (spec 7.1).
 */
export class ScopeDeniedError extends Error {
  readonly code = 'scope_denied' as const;
  readonly levels: IncludeLevel[];

  constructor(levels: IncludeLevel[]) {
    super(`scope_denied: this grant cannot read ${levels.join(', ')}`);
    this.name = 'ScopeDeniedError';
    this.levels = levels;
  }
}

/** True when `node` is what `level` names for a caller whose grant is `g`. */
function names(level: IncludeLevel, node: NodeRef, g: Grant): boolean {
  switch (level) {
    case 'self':
      return nodeKey(node) === nodeKey(g.home);
    case 'planet':
      return node.level === 'user';
    case 'star':
      return (
        node.level === 'agent' &&
        node.orgId === g.principal.orgId &&
        node.agentId === g.principal.agentId
      );
    case 'constellation':
      return node.level === 'hive' && node.hiveId !== GALAXY_ROOT;
    case 'galaxy':
      return node.level === 'hive' && node.hiveId === GALAXY_ROOT;
  }
}

/**
 * The nodes one recall reads: with `include`, every readable node a named
 * level covers (a level that covers none rejects with `ScopeDeniedError`);
 * without it, every readable node, hive nodes capped at `DEFAULT_HIVE_NODES`
 * in grant order. Never a node outside `g`.
 */
export function nodesToRead(g: Grant, include?: readonly IncludeLevel[]): NodeRef[] {
  const readable = readableNodes(g);
  if (include === undefined || include.length === 0) {
    let hives = 0;
    return readable.filter((n) => n.level !== 'hive' || ++hives <= DEFAULT_HIVE_NODES);
  }
  for (const l of include) {
    if (!isIncludeLevel(l)) throw new RangeError(`unknown level ${JSON.stringify(l)}`);
  }
  const denied = [...new Set(include)].filter((l) => !readable.some((n) => names(l, n, g)));
  if (denied.length > 0) throw new ScopeDeniedError(denied);
  return readable.filter((n) => include.some((l) => names(l, n, g)));
}

/**
 * How specific a node is, for the specificity prior and the conflict rule:
 * an agent's own memory (Star, Orbit, Flyby) 3, the person's Planet 2, a
 * Constellation 1, a Galaxy 0. Narrower is higher.
 */
export function specificity(node: Pick<NodeRef, 'level'> & { hiveId?: string }): number {
  switch (node.level) {
    case 'agent':
    case 'agent-user':
    case 'run':
      return 3;
    case 'user':
      return 2;
    case 'hive':
      return node.hiveId === GALAXY_ROOT ? 0 : 1;
  }
}

/**
 * The specificity prior's factor for a node: `1 + ε × specificity / 3`, so
 * with `ε` the narrowest level gains `ε` and a Galaxy nothing. `ε = 0` (the
 * default) leaves every score as it was.
 */
export function specificityFactor(node: NodeRef, epsilon: number): number {
  return 1 + (epsilon * specificity(node)) / 3;
}

/** Brackets in memory text, escaped so the text cannot pass for a code-built label. */
export function escapeLabelText(text: string): string {
  return text.replace(/[[\]]/g, (c) => `\\${c}`);
}

/** An id shown inside a label: control characters dropped, brackets escaped, clipped. */
function labelId(id: string): string {
  // oxlint-disable-next-line no-control-regex
  const clean = escapeLabelText(id.replace(/[\u0000-\u001f\u007f]/g, ''));
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

/** Where a recalled memory came from, built by code from its address and author. */
export interface MemoryOrigin {
  level: Level;
  /** The space name: Planet, Star, Orbit, Flyby, Constellation or Galaxy. */
  space: string;
  /** The node, as a label shows it: `your Planet`, `Star cursor`, `Constellation checkout`. */
  node: string;
  /** For people: `from your Planet`, `from this agent's Star`, `from Star cursor`. */
  from: string;
  /** The memory lives in the caller's home node. */
  home: boolean;
  /** The agent that wrote it. */
  author: string;
  /**
   * A narrower memory in this result contradicts this one (spec 7.2): it ranks
   * first, and this one stays, labelled.
   */
  overriddenBy?: { id: string; node: string };
}

/** The node part of a label for `node`, as the caller of grant `g` sees it. */
export function nodeLabel(node: NodeRef, g: Grant): string {
  switch (node.level) {
    case 'user':
      return node.orgId === g.principal.orgId && node.customerId === g.principal.customerId
        ? 'your Planet'
        : 'a Planet';
    case 'agent':
      return `Star ${labelId(node.agentId)}`;
    case 'agent-user':
      return `Orbit ${labelId(node.agentId)}`;
    case 'run':
      return `Flyby ${labelId(node.runId)}`;
    case 'hive':
      return node.hiveId === GALAXY_ROOT ? 'Galaxy' : `Constellation ${labelId(node.hiveId)}`;
  }
}

/** The origin of `m` for the caller of grant `g`. */
export function originOf(m: Pick<Memory, 'scope' | 'address' | 'author'>, g: Grant): MemoryOrigin {
  const node = nodeOf(addressOf(m));
  const label = nodeLabel(node, g);
  const ownStar =
    node.level === 'agent' &&
    node.orgId === g.principal.orgId &&
    node.agentId === g.principal.agentId;
  return {
    level: node.level,
    space: spaceName(node),
    node: label,
    from: ownStar ? "from this agent's Star" : `from ${label}`,
    home: nodeKey(node) === nodeKey(g.home),
    author: authorOf(m).agentId,
  };
}

/** The decision `observe` records on a memory written instead of editing one in another node. */
export const CONTRADICTS = { stage: 'level', question: 'contradicts' } as const;

/** The ids of memories in other nodes that `m` contradicts (recorded by `observe`). */
export function contradicted(m: Pick<Memory, 'source'>): string[] {
  return m.source.decisions
    .filter((d) => d.stage === CONTRADICTS.stage && d.question === CONTRADICTS.question)
    .map((d) => d.answer);
}
