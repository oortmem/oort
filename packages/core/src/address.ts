import type { Memory, Scope } from './model.js';

/**
 * Levels: whose memory it is (CON-61). The code keeps plain names; the space
 * names are the product's:
 *
 * | level        | space         | what it is                                         |
 * | ------------ | ------------- | -------------------------------------------------- |
 * | `user`       | Planet        | one person's own memory                            |
 * | `agent`      | Star          | one agent's own private memory                     |
 * | `agent-user` | Orbit         | what one agent knows about one person              |
 * | `run`        | Flyby         | one run or session, short-lived                    |
 * | `hive`       | Constellation | a group sharing memory (`hiveId` names it)         |
 * | `hive`       | Galaxy        | an organisation's own node (`hiveId` is `root`)    |
 *
 * Levels say whose a memory is; tiers (hot, warm, cold) say how warm it is.
 * The two are independent.
 */
export type Level = 'user' | 'agent' | 'agent-user' | 'run' | 'hive';

export const LEVELS: readonly Level[] = Object.freeze([
  'user',
  'agent',
  'agent-user',
  'run',
  'hive',
]);

/** The `hiveId` of a Galaxy's own node (the hive tree is two deep: a Galaxy holds Constellations). */
export const GALAXY_ROOT = 'root';

/**
 * In every address, `orgId` is the **owner**: the storage, key and deletion
 * boundary (`local` on a laptop, an account, or an organisation). `projectId`
 * binds a memory to a project inside its node; absent means unbound (global).
 */
export interface PlanetAddress {
  level: 'user';
  orgId: string;
  customerId: string;
  projectId?: string;
  agentId?: never;
  hiveId?: never;
  runId?: never;
}

export interface StarAddress {
  level: 'agent';
  orgId: string;
  agentId: string;
  projectId?: string;
  customerId?: never;
  hiveId?: never;
  runId?: never;
}

export interface OrbitAddress {
  level: 'agent-user';
  orgId: string;
  agentId: string;
  customerId: string;
  projectId?: string;
  hiveId?: never;
  runId?: never;
}

export interface FlybyAddress {
  level: 'run';
  orgId: string;
  agentId: string;
  runId: string;
  customerId?: string;
  projectId?: string;
  hiveId?: never;
}

/** A Constellation, or the Galaxy's own node when `hiveId` is `GALAXY_ROOT`. Subject-free: no `customerId`. */
export interface HiveAddress {
  level: 'hive';
  orgId: string;
  hiveId: string;
  projectId?: string;
  customerId?: never;
  agentId?: never;
  runId?: never;
}

/** Where a memory lives. Every memory has exactly one; the level decides which fields exist. */
export type Address = PlanetAddress | StarAddress | OrbitAddress | FlybyAddress | HiveAddress;

type WithoutProject<T> = T extends unknown ? Omit<T, 'projectId'> : never;

/** A node: an address without its project binding. Grants name nodes. */
export type NodeRef = WithoutProject<Address>;

/** Who wrote a memory. Not part of the address: a person's agents share their Planet. */
export interface Author {
  agentId: string;
  /** The account that ran the agent, where the store knows it. */
  accountRef?: string;
}

/**
 * Where a shared copy came from (filled by sharing, a later feature). Absent on
 * ordinary memories. Stores keep it as given; nothing in the engine reads it yet.
 */
export interface Provenance {
  derivedFrom: { vault: string; memoryId: string; subjectRef?: string }[];
  contributors: {
    memberRef: string;
    agentId: string;
    at: string;
    action: 'asserted' | 'confirmed' | 'contradicted';
  }[];
  support: { members: number; agents: number };
  gate: { policyVersion: string; mode: 'confirmed' | 'open' | 'approval'; approvedBy?: string };
}

/** The fields each level requires (besides `level` and `orgId`) and allows. */
const SHAPE: Record<Level, { required: readonly string[]; optional: readonly string[] }> = {
  user: { required: ['customerId'], optional: [] },
  agent: { required: ['agentId'], optional: [] },
  'agent-user': { required: ['agentId', 'customerId'], optional: [] },
  run: { required: ['agentId', 'runId'], optional: ['customerId'] },
  hive: { required: ['hiveId'], optional: [] },
};

const NODE_FIELDS = ['customerId', 'agentId', 'hiveId', 'runId'] as const;

const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';

function checkNode(a: Record<string, unknown>, what: string, allowProject: boolean): void {
  const level = a['level'];
  if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) {
    throw new RangeError(`${what}: unknown level ${JSON.stringify(level)}`);
  }
  const shape = SHAPE[level as Level];
  if (!isText(a['orgId'])) throw new RangeError(`${what}: orgId must be a non-empty string`);
  for (const f of shape.required) {
    if (!isText(a[f])) throw new RangeError(`${what}: a ${level} address needs ${f}`);
  }
  for (const f of NODE_FIELDS) {
    if (a[f] === undefined || shape.required.includes(f)) continue;
    if (!shape.optional.includes(f))
      throw new RangeError(`${what}: a ${level} address has no ${f}`);
    if (!isText(a[f])) throw new RangeError(`${what}: ${f} must be a non-empty string`);
  }
  if (a['projectId'] !== undefined) {
    if (!allowProject) throw new RangeError(`${what}: a node has no projectId`);
    if (typeof a['projectId'] !== 'string') {
      throw new RangeError(`${what}: projectId must be a string`);
    }
  }
  const known = new Set(['level', 'orgId', 'projectId', ...NODE_FIELDS]);
  for (const k of Object.keys(a)) {
    // The name comes from input (an export line): quoted and escaped, never raw on a terminal.
    if (!known.has(k)) throw new RangeError(`${what}: unknown field ${JSON.stringify(k)}`);
  }
}

/** Throws a `RangeError` naming the problem unless `a` is a legal `Address`. */
export function assertAddress(a: unknown): asserts a is Address {
  if (typeof a !== 'object' || a === null) throw new RangeError('address must be an object');
  checkNode(a as Record<string, unknown>, 'address', true);
}

/** Throws a `RangeError` unless `n` is a legal `NodeRef`. */
export function assertNode(n: unknown): asserts n is NodeRef {
  if (typeof n !== 'object' || n === null) throw new RangeError('node must be an object');
  checkNode(n as Record<string, unknown>, 'node', false);
}

/** Throws a `RangeError` unless `a` is a legal `Author`. */
export function assertAuthor(a: unknown): asserts a is Author {
  if (typeof a !== 'object' || a === null) throw new RangeError('author must be an object');
  const o = a as Record<string, unknown>;
  if (!isText(o['agentId'])) throw new RangeError('author: agentId must be a non-empty string');
  if (o['accountRef'] !== undefined && !isText(o['accountRef'])) {
    throw new RangeError('author: accountRef must be a non-empty string');
  }
  for (const k of Object.keys(o)) {
    if (k !== 'agentId' && k !== 'accountRef') {
      throw new RangeError(`author: unknown field ${JSON.stringify(k)}`);
    }
  }
}

/** The Planet a scope names: today's (org, customer, project), without the agent. */
export function planetOf(scope: Scope): PlanetAddress {
  return {
    level: 'user',
    orgId: scope.orgId,
    customerId: scope.customerId,
    ...(scope.projectId !== undefined && { projectId: scope.projectId }),
  };
}

/** A copy of `a` with only its own level's fields, in a fixed order. */
function clean(a: Address): Address {
  const out: Record<string, string> = { level: a.level, orgId: a.orgId };
  for (const f of NODE_FIELDS) {
    const v = (a as unknown as Record<string, unknown>)[f];
    if (typeof v === 'string') out[f] = v;
  }
  if (a.projectId !== undefined) out['projectId'] = a.projectId;
  return out as unknown as Address;
}

/** Where `m` lives: its `address`, or the Planet its `scope` names (every memory written before levels). */
export function addressOf(m: Pick<Memory, 'scope' | 'address'>): Address {
  return m.address === undefined ? planetOf(m.scope) : clean(m.address);
}

/** Who wrote `m`: its `author`, or the agent its `scope` names. */
export function authorOf(m: Pick<Memory, 'scope' | 'author'>): Author {
  if (m.author === undefined) return { agentId: m.scope.agentId };
  const { agentId, accountRef } = m.author;
  return accountRef === undefined ? { agentId } : { agentId, accountRef };
}

/**
 * The `scope` a memory at `address` written by `author` carries: the
 * pre-level view, kept so existing readers work. The agent is the address's
 * own agent where it has one (Star, Orbit, Flyby), else the author. A level
 * without a customer (Star, Constellation, Galaxy) has `customerId: ''`.
 * Authorisation never reads it.
 */
export function scopeOf(address: Address, author: Author): Scope {
  const a = address as Partial<Record<(typeof NODE_FIELDS)[number], string>>;
  return {
    orgId: address.orgId,
    customerId: a.customerId ?? '',
    agentId: a.agentId ?? author.agentId,
    ...(address.projectId !== undefined && { projectId: address.projectId }),
  };
}

/** `address`, `author` and the matching `scope`, to spread into a new memory at a level. */
export function addressed(
  address: Address,
  author: Author,
): Pick<Memory, 'scope' | 'address' | 'author'> {
  assertAddress(address);
  assertAuthor(author);
  const a = clean(address);
  const w: Author =
    author.accountRef === undefined
      ? { agentId: author.agentId }
      : { agentId: author.agentId, accountRef: author.accountRef };
  return { scope: scopeOf(a, w), address: a, author: w };
}

/** The node `address` sits in (the address without its project binding). */
export function nodeOf(address: Address): NodeRef {
  const { projectId: _p, ...node } = clean(address);
  return node as NodeRef;
}

/**
 * A node as a JSON tuple: `["user", orgId, customerId]`, `["hive", orgId, hiveId]`
 * and so on, with `null` for an absent optional field. Structured and compared
 * whole, never as a prefix.
 */
export function nodeKey(n: NodeRef): string {
  const x = n as Partial<Record<(typeof NODE_FIELDS)[number], string>>;
  switch (n.level) {
    case 'user':
      return JSON.stringify([n.level, n.orgId, x.customerId]);
    case 'agent':
      return JSON.stringify([n.level, n.orgId, x.agentId]);
    case 'agent-user':
      return JSON.stringify([n.level, n.orgId, x.agentId, x.customerId]);
    case 'run':
      return JSON.stringify([n.level, n.orgId, x.agentId, x.runId, x.customerId ?? null]);
    case 'hive':
      return JSON.stringify([n.level, n.orgId, x.hiveId]);
  }
}

/** Two addresses name the same node and the same project binding. */
export function sameAddress(a: Address, b: Address): boolean {
  return (
    nodeKey(nodeOf(a)) === nodeKey(nodeOf(b)) && (a.projectId ?? null) === (b.projectId ?? null)
  );
}

export function sameAuthor(a: Author, b: Author): boolean {
  return a.agentId === b.agentId && (a.accountRef ?? null) === (b.accountRef ?? null);
}

/** The space name of `address`'s level, for people: Planet, Star, Orbit, Flyby, Constellation or Galaxy. */
export function spaceName(address: Address | NodeRef): string {
  switch (address.level) {
    case 'user':
      return 'Planet';
    case 'agent':
      return 'Star';
    case 'agent-user':
      return 'Orbit';
    case 'run':
      return 'Flyby';
    case 'hive':
      return address.hiveId === GALAXY_ROOT ? 'Galaxy' : 'Constellation';
  }
}

/**
 * `m`'s address, author and scope checked against each other: the address and
 * author are legal, and `scope` is exactly the view `scopeOf` gives (extra
 * scope fields aside). Throws a `RangeError` otherwise. Every store runs this
 * on each memory it writes.
 */
export function resolveAddressing(m: Pick<Memory, 'scope' | 'address' | 'author'>): {
  address: Address;
  author: Author;
} {
  if (m.address !== undefined) assertAddress(m.address);
  if (m.author !== undefined) assertAuthor(m.author);
  const address = addressOf(m);
  const author = authorOf(m);
  const want = scopeOf(address, author);
  const s = m.scope;
  if (
    s.orgId !== want.orgId ||
    s.customerId !== want.customerId ||
    s.agentId !== want.agentId ||
    (s.projectId ?? null) !== (want.projectId ?? null)
  ) {
    throw new RangeError('memory scope does not match its address and author (use addressed())');
  }
  return { address, author };
}

/**
 * `m` in the shape stores return: `address` only when it is not the Planet
 * `scope` names, `author` only when it is not `scope.agentId`, `provenance`
 * only when set. A memory written before levels comes back exactly as it was.
 */
export function canonicalMemory<M extends Memory>(m: M): M {
  const { address, author } = resolveAddressing(m);
  const { address: _a, author: _w, provenance, ...rest } = m;
  const out = { ...rest } as M;
  if (address.level !== 'user') out.address = address;
  if (author.accountRef !== undefined || author.agentId !== m.scope.agentId) out.author = author;
  if (provenance !== undefined && provenance !== null) out.provenance = provenance;
  return out;
}
