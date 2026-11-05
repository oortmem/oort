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
 * agent wrote; the pre-level constructors (`localGrant`, `principalGrant`)
 * set it to the principal's agent, so they see exactly what they saw before
 * levels existed.
 */
export interface NodePattern {
  readonly node: NodeRef;
  readonly projectIds: GrantProjects;
  readonly authorAgentId?: string;
}

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

  private constructor(
    principal: Principal,
    readNodes: readonly NodePattern[],
    writeNodes: readonly NodePattern[],
  ) {
    this.principal = Object.freeze({ ...principal });
    this.readNodes = Object.freeze(readNodes.map(freezePattern));
    this.writeNodes = Object.freeze(writeNodes.map(freezePattern));
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
  static issue(principal: Principal, read: GrantProjects, write: GrantProjects): Grant {
    checkPrincipal(principal);
    return new Grant(principal, [ownPlanet(principal, read)], [ownPlanet(principal, write)]);
  }

  /** @internal Use `nodeGrant`. */
  static issueNodes(
    principal: Principal,
    read: readonly NodePattern[],
    write: readonly NodePattern[],
  ): Grant {
    checkPrincipal(principal);
    return new Grant(principal, read, write);
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

/** The pre-level grant side: the principal's own Planet, written by its own agent. */
function ownPlanet(p: Principal, projectIds: GrantProjects): NodePattern {
  return {
    node: { level: 'user', orgId: p.orgId, customerId: p.customerId },
    projectIds,
    authorAgentId: p.agentId,
  };
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
 * patterns naming exactly the principal's Planet, restricted to its agent.
 * Never wider than the patterns themselves.
 */
function legacyProjects(p: Principal, patterns: readonly NodePattern[]): GrantProjects {
  const own = nodeKey({ level: 'user', orgId: p.orgId, customerId: p.customerId });
  const mine = patterns.filter((x) => x.authorAgentId === p.agentId && nodeKey(x.node) === own);
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
 * The grant for today's single-principal callers: read exactly what `read`
 * names (a one-node grant), and write the same unless `opts.write` narrows it.
 * `write` must name the same principal as `read`.
 */
export function localGrant(read: ScopeFilter, opts: { write?: ScopeFilter } = {}): Grant {
  const write = opts.write ?? read;
  // Only principalGrant widens to every project; a list is required here.
  if (!Array.isArray(read.projectIds) || !Array.isArray(write.projectIds)) {
    throw new TypeError('localGrant: projectIds must be an array (use principalGrant for all)');
  }
  if (!samePrincipal(read, write)) {
    throw new RangeError('localGrant: read and write must name the same org, customer and agent');
  }
  return Grant.issue(read, read.projectIds, write.projectIds);
}

/** Every project of `p` (and its global memories), for read and write: maintenance such as export. */
export function principalGrant(p: Principal): Grant {
  return Grant.issue(p, 'all', 'all');
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
}): Grant {
  if (!Array.isArray(opts.read) || (opts.write !== undefined && !Array.isArray(opts.write))) {
    throw new TypeError('nodeGrant: read and write must be arrays of node patterns');
  }
  return Grant.issueNodes(opts.principal, opts.read, opts.write ?? opts.read);
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
