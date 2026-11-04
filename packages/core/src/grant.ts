import type { ScopeFilter } from './adapters.js';
import type { Scope } from './model.js';

/** Who a grant acts for: one (org, customer, agent). Grants never span principals. */
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

/** One side (read or write) of a grant, as stores apply it. */
export interface GrantFilter extends Readonly<Principal> {
  readonly projectIds: GrantProjects;
}

/**
 * The permission every `MemoryStore` method takes. Opaque: built only by
 * `localGrant` or `principalGrant`, frozen, and nominal, so a raw
 * `ScopeFilter` (or any look-alike object) is rejected by the type checker
 * and, for JavaScript callers, by `assertGrant` inside every store.
 *
 * `read` bounds what can be seen (`get`, `lexical`, `dense`, `list`,
 * `coldGet`, `recordAccess`); `write` bounds what can change (`upsert`,
 * `forget`, `setTier`, `expireMany`, `coldPut`). Cursors belong to the
 * principal. Anything outside a grant behaves exactly like something that
 * does not exist.
 */
export class Grant {
  readonly #issued = true;
  readonly principal: Readonly<Principal>;
  readonly read: GrantFilter;
  readonly write: GrantFilter;

  private constructor(principal: Principal, read: GrantProjects, write: GrantProjects) {
    this.principal = Object.freeze({ ...principal });
    this.read = Object.freeze({ ...principal, projectIds: freezeProjects(read) });
    this.write = Object.freeze({ ...principal, projectIds: freezeProjects(write) });
    Object.freeze(this);
  }

  /** @internal Use `localGrant` or `principalGrant`. */
  static issue(principal: Principal, read: GrantProjects, write: GrantProjects): Grant {
    for (const k of ['orgId', 'customerId', 'agentId'] as const) {
      if (typeof principal[k] !== 'string' || principal[k] === '') {
        throw new RangeError(`grant: ${k} must be a non-empty string`);
      }
    }
    return new Grant(principal, read, write);
  }

  /** True for a real grant (not a copy, not a look-alike). */
  static is(x: unknown): x is Grant {
    return typeof x === 'object' && x !== null && #issued in x;
  }
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

/** Rejects anything that is not a real `Grant`; every store calls it first. */
export function assertGrant(g: unknown): asserts g is Grant {
  if (!Grant.is(g)) {
    throw new TypeError('MemoryStore methods take a Grant (localGrant or principalGrant)');
  }
}

/** True iff a memory with `scope` lies inside `f`. Extra scope fields do not widen or narrow it. */
export function filterCovers(f: GrantFilter, scope: Scope): boolean {
  return (
    scope.orgId === f.orgId &&
    scope.customerId === f.customerId &&
    scope.agentId === f.agentId &&
    (f.projectIds === 'all' || f.projectIds.includes(scope.projectId ?? null))
  );
}

export const canRead = (g: Grant, scope: Scope): boolean => filterCovers(g.read, scope);
export const canWrite = (g: Grant, scope: Scope): boolean => filterCovers(g.write, scope);

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
