import {
  addressOf,
  assertNode,
  authorOf,
  nodeKey,
  nodeOf,
  planetOf,
  sameAddress,
  sameAuthor,
  type Address,
  type Author,
  type NodeRef,
} from './address.js';
import type { ScopeFilter } from './adapters.js';
import type { Memory, Scope } from './model.js';

/**
 * Who a grant acts for: an account (`orgId`, `customerId`) and the agent
 * acting for it. Cursors belong to the principal.
 */
export interface Principal {
  orgId: string;
  customerId: string;
  agentId: string;
}

/**
 * The projects one side of a grant covers: a list (`null` is global memories,
 * no project) or `'all'`, every project of the principal plus global.
 */
export type GrantProjects = readonly (string | null)[] | 'all';

/**
 * One side (read or write) of a pre-level grant: the principal's Planet,
 * written by the principal's agent, in `projectIds`.
 * @deprecated Stores read `Grant.readNodes` and `Grant.writeNodes`.
 */
export interface GrantFilter extends Readonly<Principal> {
  readonly projectIds: GrantProjects;
}

/**
 * One node a grant covers (CON-61): the node, the project bindings inside it,
 * and optionally one author. Matching is structural and exact on every field
 * (never a prefix). `authorAgentId` restricts the pattern to memories that
 * agent wrote. The local constructors (`localGrant`, `principalGrant`) name
 * the principal's Planet with no author restriction (a person's agents share
 * their Planet, CON-62) and the principal's agent's own Star.
 */
export interface NodePattern {
  readonly node: NodeRef;
  readonly projectIds: GrantProjects;
  readonly authorAgentId?: string;
}

/**
 * Where an agent's new memories land by default (its home node, spec 5.1):
 * the person's Planet, or the agent's own Star when it is configured as one.
 */
export type Home = 'planet' | 'star';

/**
 * The permission every `MemoryStore` method takes. Opaque: built only by
 * `localGrant`, `principalGrant` or `nodeGrant`, frozen, and nominal, so a raw
 * `ScopeFilter` (or any look-alike object) is rejected by the type checker
 * and, for JavaScript callers, by `assertGrant` inside every store.
 *
 * `readNodes` bounds what can be seen (`get`, `lexical`, `dense`, `list`,
 * `coldGet`, `recordAccess`); `writeNodes` bounds what can change (`upsert`,
 * `forget`, `setTier`, `expireMany`, `coldPut`). A memory is covered when
 * any pattern of the side covers its address and author. Cursors belong to
 * the principal. Anything outside a grant behaves exactly like something that
 * does not exist.
 */
export class Grant {
  readonly #issued = true;
  readonly principal: Readonly<Principal>;
  /** @deprecated The pre-level view of `readNodes`; see `GrantFilter`. */
  readonly read: GrantFilter;
  /** @deprecated The pre-level view of `writeNodes`; see `GrantFilter`. */
  readonly write: GrantFilter;
  readonly readNodes: readonly NodePattern[];
  readonly writeNodes: readonly NodePattern[];
  /**
   * The node new memories are written to (the home node): the principal's
   * Planet unless the agent keeps a Star. Engine code that creates a memory
   * (observe, remember) addresses it here; edits of existing memories keep
   * their own address. Covered by `writeNodes` whenever they are not empty.
   */
  readonly home: NodeRef;

  private constructor(
    principal: Principal,
    readNodes: readonly NodePattern[],
    writeNodes: readonly NodePattern[],
    home: NodeRef | undefined,
  ) {
    this.principal = Object.freeze({ ...principal });
    this.readNodes = Object.freeze(readNodes.map(freezePattern));
    this.writeNodes = Object.freeze(writeNodes.map(freezePattern));
    this.home = Object.freeze(homeNode(principal, this.writeNodes, home));
    this.read = Object.freeze({
      ...principal,
      projectIds: legacyProjects(principal, this.readNodes),
    });
    this.write = Object.freeze({
      ...principal,
      projectIds: legacyProjects(principal, this.writeNodes),
    });
    Object.freeze(this);
  }

  /** @internal Use `localGrant` or `principalGrant`. */
  static issue(
    principal: Principal,
    read: GrantProjects,
    write: GrantProjects,
    home: Home = 'planet',
  ): Grant {
    checkPrincipal(principal);
    return new Grant(
      principal,
      [ownPlanet(principal, read), ownStar(principal, read)],
      [ownPlanet(principal, write), ownStar(principal, write)],
      home === 'star' ? starNode(principal) : planetNode(principal),
    );
  }

  /** @internal Use `nodeGrant` or `narrowGrant`. */
  static issueNodes(
    principal: Principal,
    read: readonly NodePattern[],
    write: readonly NodePattern[],
    home?: NodeRef,
  ): Grant {
    checkPrincipal(principal);
    return new Grant(principal, read, write, home);
  }

  /** True for a real grant (not a copy, not a look-alike). */
  static is(x: unknown): x is Grant {
    return typeof x === 'object' && x !== null && #issued in x;
  }
}

function checkPrincipal(principal: Principal): void {
  for (const k of ['orgId', 'customerId', 'agentId'] as const) {
    if (typeof principal[k] !== 'string' || principal[k] === '') {
      throw new RangeError(`grant: ${k} must be a non-empty string`);
    }
  }
}

/**
 * The local grant side's Planet: the principal's own Planet, whichever of the
 * person's agents wrote the memory (CON-62; before it, the pattern was
 * restricted to the principal's own agent).
 */
function ownPlanet(p: Principal, projectIds: GrantProjects): NodePattern {
  return { node: planetNode(p), projectIds };
}

/** The principal's agent's own Star: private to that agent, never another's. */
function ownStar(p: Principal, projectIds: GrantProjects): NodePattern {
  return { node: starNode(p), projectIds };
}

/** The Star of a principal's agent (owned by the principal's owner). */
export function starNode(p: Pick<Principal, 'orgId' | 'agentId'>): NodeRef {
  return { level: 'agent', orgId: p.orgId, agentId: p.agentId };
}

/**
 * `home` checked against the write side, or the default: the principal's
 * Planet when the write side names it, else the first node written, else the
 * Planet (a read-only grant writes nothing anyway).
 */
function homeNode(p: Principal, write: readonly NodePattern[], home: NodeRef | undefined): NodeRef {
  if (home !== undefined) {
    assertNode(home);
    const { level: _l, ...rest } = home;
    const node = { level: home.level, ...rest } as NodeRef;
    if (write.length > 0 && !write.some((w) => nodeKey(w.node) === nodeKey(node))) {
      throw new RangeError('grant: home must be a node the grant writes');
    }
    return node;
  }
  const planet = planetNode(p);
  if (write.length === 0 || write.some((w) => nodeKey(w.node) === nodeKey(planet))) return planet;
  return write[0]!.node;
}

function freezePattern(p: NodePattern): NodePattern {
  if (typeof p !== 'object' || p === null)
    throw new TypeError('grant: a node pattern must be an object');
  assertNode(p.node);
  const { level: _l, ...rest } = p.node;
  const node = Object.freeze({ level: p.node.level, ...rest }) as NodeRef;
  if (
    p.authorAgentId !== undefined &&
    (typeof p.authorAgentId !== 'string' || p.authorAgentId === '')
  ) {
    throw new RangeError('grant: authorAgentId must be a non-empty string');
  }
  return Object.freeze({
    node,
    projectIds: freezeProjects(p.projectIds),
    ...(p.authorAgentId !== undefined && { authorAgentId: p.authorAgentId }),
  });
}

/**
 * The projects of `patterns` that a pre-level reader may assume: those of
 * patterns naming exactly the principal's Planet and covering its agent's
 * writing (no author restriction, or that agent). Never wider than the
 * patterns themselves.
 */
function legacyProjects(p: Principal, patterns: readonly NodePattern[]): GrantProjects {
  const own = nodeKey({ level: 'user', orgId: p.orgId, customerId: p.customerId });
  const mine = patterns.filter(
    (x) =>
      (x.authorAgentId === undefined || x.authorAgentId === p.agentId) && nodeKey(x.node) === own,
  );
  if (mine.some((x) => x.projectIds === 'all')) return 'all';
  return Object.freeze([
    ...new Set(mine.flatMap((x) => x.projectIds as readonly (string | null)[])),
  ]);
}

function freezeProjects(p: GrantProjects): GrantProjects {
  if (p === 'all') return 'all';
  if (!Array.isArray(p)) throw new TypeError('grant: projectIds must be an array or "all"');
  for (const id of p) {
    if (id !== null && (typeof id !== 'string' || id === '')) {
      throw new RangeError('grant: a project id must be a non-empty string or null');
    }
  }
  return Object.freeze([...new Set(p)]);
}

function samePrincipal(a: Principal, b: Principal): boolean {
  return a.orgId === b.orgId && a.customerId === b.customerId && a.agentId === b.agentId;
}

/**
 * The grant for one agent of one person (CON-62): read and write the
 * person's Planet (memories any of their agents wrote) and this agent's own
 * Star, in the projects `read` names; `opts.write` may narrow the write side.
 * Another agent's Star is never covered. `opts.home` picks where new memories
 * land: the Planet (default) or the agent's Star. `write` must name the same
 * principal as `read`.
 *
 * Before CON-62 the Planet side was restricted to memories the principal's
 * own agent wrote. Every local memory so far was written as `claude-code`,
 * so a local store sees exactly what it saw; nothing is rewritten.
 */
export function localGrant(
  read: ScopeFilter,
  opts: { write?: ScopeFilter; home?: Home } = {},
): Grant {
  const write = opts.write ?? read;
  // Only principalGrant widens to every project; a list is required here.
  if (!Array.isArray(read.projectIds) || !Array.isArray(write.projectIds)) {
    throw new TypeError('localGrant: projectIds must be an array (use principalGrant for all)');
  }
  if (!samePrincipal(read, write)) {
    throw new RangeError('localGrant: read and write must name the same org, customer and agent');
  }
  return Grant.issue(
    { orgId: read.orgId, customerId: read.customerId, agentId: read.agentId },
    read.projectIds,
    write.projectIds,
    opts.home,
  );
}

/**
 * Every project of `p` (and its global memories), for read and write:
 * maintenance such as export. Covers the same nodes as `localGrant`: the
 * person's Planet and this agent's own Star.
 */
export function principalGrant(p: Principal, opts: { home?: Home } = {}): Grant {
  return Grant.issue(
    { orgId: p.orgId, customerId: p.customerId, agentId: p.agentId },
    'all',
    'all',
    opts.home,
  );
}

/**
 * A grant over explicit node patterns, possibly across owners and levels:
 * `read` bounds what is seen, `write` (default: `read`) what may change.
 * Trusted: whoever builds one has already decided the principal may use
 * every node it names (local configuration, or membership checked by a
 * control plane). Nothing in the engine builds one for its own callers yet:
 * the CLI, hooks and MCP server keep the pre-level grants.
 */
export function nodeGrant(opts: {
  principal: Principal;
  read: readonly NodePattern[];
  write?: readonly NodePattern[];
  /** Where new memories land (default: the principal's Planet if written, else the first node written). */
  home?: NodeRef;
}): Grant {
  if (!Array.isArray(opts.read) || (opts.write !== undefined && !Array.isArray(opts.write))) {
    throw new TypeError('nodeGrant: read and write must be arrays of node patterns');
  }
  return Grant.issueNodes(opts.principal, opts.read, opts.write ?? opts.read, opts.home);
}

/**
 * `g` narrowed to the nodes `keep` names (by `nodeKey`), on both sides: the
 * grant recall uses for one node's first stage. Never wider than `g`. The
 * home stays when it is kept, else the default for what remains.
 */
export function narrowGrant(g: Grant, keep: readonly NodeRef[]): Grant {
  assertGrant(g);
  const keys = new Set(keep.map((n) => nodeKey(n)));
  const read = g.readNodes.filter((p) => keys.has(nodeKey(p.node)));
  const write = g.writeNodes.filter((p) => keys.has(nodeKey(p.node)));
  const home = write.some((p) => nodeKey(p.node) === nodeKey(g.home)) ? g.home : undefined;
  return Grant.issueNodes(g.principal, read, write, home);
}

/** The distinct nodes `g` reads, in the order its patterns name them. */
export function readableNodes(g: Grant): NodeRef[] {
  assertGrant(g);
  const seen = new Map<string, NodeRef>();
  for (const p of g.readNodes) if (!seen.has(nodeKey(p.node))) seen.set(nodeKey(p.node), p.node);
  return [...seen.values()];
}

/** The address a new memory gets under `g`: its home node, bound to `projectId` when given. */
export function homeAddress(g: Grant, projectId?: string): Address {
  assertGrant(g);
  return {
    ...g.home,
    ...(projectId !== undefined && { projectId }),
  } as Address;
}

/** Rejects anything that is not a real `Grant`; every store calls it first. */
export function assertGrant(g: unknown): asserts g is Grant {
  if (!Grant.is(g)) {
    throw new TypeError(
      'MemoryStore methods take a Grant (localGrant, principalGrant or nodeGrant)',
    );
  }
}

/**
 * True iff a memory with `scope` lies inside `f`. Extra scope fields do not widen or narrow it.
 * @deprecated Use `grantReads` / `grantWrites`.
 */
export function filterCovers(f: GrantFilter, scope: Scope): boolean {
  return (
    scope.orgId === f.orgId &&
    scope.customerId === f.customerId &&
    scope.agentId === f.agentId &&
    (f.projectIds === 'all' || f.projectIds.includes(scope.projectId ?? null))
  );
}

/** True iff `p` covers a memory at `address` written by `author`. */
export function patternCovers(p: NodePattern, address: Address, author: Author): boolean {
  return (
    nodeKey(nodeOf(address)) === nodeKey(p.node) &&
    (p.projectIds === 'all' || p.projectIds.includes(address.projectId ?? null)) &&
    (p.authorAgentId === undefined || p.authorAgentId === author.agentId)
  );
}

function covers(patterns: readonly NodePattern[], m: Pick<Memory, 'scope' | 'address' | 'author'>) {
  const address = addressOf(m);
  const author = authorOf(m);
  return patterns.some((p) => patternCovers(p, address, author));
}

/** True iff `g` may read `m` (by its address and author). */
export const grantReads = (g: Grant, m: Pick<Memory, 'scope' | 'address' | 'author'>): boolean =>
  covers(g.readNodes, m);
/** True iff `g` may change `m` (by its address and author). */
export const grantWrites = (g: Grant, m: Pick<Memory, 'scope' | 'address' | 'author'>): boolean =>
  covers(g.writeNodes, m);

/** True iff `g` may read a Planet memory with `scope` (`scope.agentId` as its author). */
export const canRead = (g: Grant, scope: Scope): boolean => grantReads(g, { scope });
/** True iff `g` may change a Planet memory with `scope` (`scope.agentId` as its author). */
export const canWrite = (g: Grant, scope: Scope): boolean => grantWrites(g, { scope });

/**
 * Two records occupy the same place: the same address, the same author and
 * the same scope (extra scope fields included). A write that would change any
 * of them for an existing id is refused.
 */
export function sameRecordAddress(
  a: Pick<Memory, 'scope' | 'address' | 'author'>,
  b: Pick<Memory, 'scope' | 'address' | 'author'>,
): boolean {
  return (
    sameAddress(addressOf(a), addressOf(b)) &&
    sameAuthor(authorOf(a), authorOf(b)) &&
    sameScope(a.scope, b.scope)
  );
}

/** The Planet node of a principal: what pre-level grants cover. */
export function planetNode(p: Pick<Principal, 'orgId' | 'customerId'>): NodeRef {
  const { projectId: _p, ...node } = planetOf({ ...p, agentId: '-' });
  return node;
}

/**
 * The key a store keeps a cursor under. The local principal (the CLI's own,
 * `local`/`self`/`claude-code`) keeps the bare key, so cursors written before
 * grants existed still apply; every other principal gets its own namespace,
 * separated by a control character no caller key contains.
 */
export function cursorKey(g: Grant, key: string): string {
  if (key.includes('\u001f')) throw new RangeError('cursor key must not contain U+001F');
  const p = g.principal;
  if (p.orgId === 'local' && p.customerId === 'self' && p.agentId === 'claude-code') return key;
  return `\u001f${JSON.stringify([p.orgId, p.customerId, p.agentId])}\u001f${key}`;
}

/** Two scopes name the same address: same principal, project and extra fields. */
export function sameScope(a: Scope, b: Scope): boolean {
  return canonicalScope(a) === canonicalScope(b);
}

function canonicalScope(s: Scope): string {
  const { orgId, customerId, agentId, projectId, ...extra } = s;
  const keys = Object.keys(extra).sort();
  return JSON.stringify([
    orgId,
    customerId,
    agentId,
    projectId ?? null,
    keys.map((k) => [k, (extra as Record<string, unknown>)[k]]),
  ]);
}

/**
 * Raised by `upsert`/`upsertMany` for a memory outside `grant.write`, or an
 * existing id whose address would change. One message for both, so it says
 * nothing about records the caller cannot see. Nothing is written.
 */
export class GrantError extends Error {
  constructor() {
    super('memory is not writable with this grant');
    this.name = 'GrantError';
  }
}
