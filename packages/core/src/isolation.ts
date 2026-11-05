/**
 * Isolation checks for `MemoryStore` implementations (CON-60). Plain
 * functions that return the violations they find, so the conformance suite
 * can require an empty list and a test can prove a broken store is caught.
 * No vitest here; `store-conformance.ts` wires these into `it` blocks.
 */
import {
  addressed,
  addressOf,
  authorOf,
  GALAXY_ROOT,
  nodeOf,
  type Address,
  type Author,
} from './address.js';
import type { MemoryStore, ScopeFilter } from './adapters.js';
import { GrantError, localGrant, nodeGrant, type Grant, type NodePattern } from './grant.js';
import type { Memory, Scope } from './model.js';

const NOW = '2026-11-04T12:00:00.000Z';

/** A memory for the isolation checks: text, stub and entities all carry `marker`. */
export function isoMemory(id: string, scope: Scope, marker: string, embedding?: Int8Array): Memory {
  return {
    id,
    scope,
    type: 'semantic',
    text: `${marker} lives in the text of ${id}`,
    stub: `${marker} stub`,
    entities: [marker],
    salience: 0.5,
    pinned: false,
    tier: 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: NOW,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'isolation', decisions: [] },
    createdAt: NOW,
    updatedAt: NOW,
    ...(embedding !== undefined && { embedding }),
  };
}

const principal = (s: Scope) => ({ orgId: s.orgId, customerId: s.customerId, agentId: s.agentId });

/** The narrowest grant for one scope (its principal and its one project or global). */
export function soleGrant(s: Scope): Grant {
  return localGrant({ ...principal(s), projectIds: [s.projectId ?? null] });
}

/** The narrowest grant for one memory at any level: its node, its one project, its author. */
export function soleGrantFor(m: Pick<Memory, 'scope' | 'address' | 'author'>): Grant {
  const address = addressOf(m);
  const author = authorOf(m);
  const pattern: NodePattern = {
    node: nodeOf(address),
    projectIds: [address.projectId ?? null],
    authorAgentId: author.agentId,
  };
  return nodeGrant({ principal: ISO_PRINCIPAL, read: [pattern] });
}

/** `m` moved to `scope`: its address and author dropped, so the scope's Planet is the address. */
export function movedTo(m: Memory, scope: Scope): Memory {
  const { address: _a, author: _w, provenance: _p, ...rest } = m;
  return { ...rest, scope };
}

/** A memory at `address`, written by `author`, for the isolation checks. */
export function isoAt(
  id: string,
  address: Address,
  author: Author,
  marker: string,
  embedding?: Int8Array,
): Memory {
  const at = addressed(address, author);
  return { ...isoMemory(id, at.scope, marker, embedding), ...at };
}

/** A stable rendering of a record (embedding as plain numbers) for before/after comparison. */
function render(m: Memory | null): string {
  if (m === null) return 'null';
  return JSON.stringify({ ...m, embedding: m.embedding === undefined ? null : [...m.embedding] });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  try {
    return { ok: await p };
  } catch (err) {
    return { err };
  }
}

/** The scopes the checks use: the caller, and victims that differ from it in one coordinate each. */
export const ISO_SCOPES = {
  mine: { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectId: 'pa' },
  otherProject: { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectId: 'pa2' },
  global: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
  otherCustomer: {
    orgId: 'local',
    customerId: 'someone-else',
    agentId: 'claude-code',
    projectId: 'pa',
  },
  otherAgent: { orgId: 'local', customerId: 'self', agentId: 'another-agent', projectId: 'pa' },
  otherOrg: { orgId: 'another-org', customerId: 'self', agentId: 'claude-code', projectId: 'pa' },
} satisfies Record<string, Scope>;

/** Who the level checks act as: the caller of `ISO_SCOPES.mine`. */
const ISO_PRINCIPAL = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };

/**
 * Victims at the other levels, each next to the caller's own Planet: a Planet
 * memory another of the caller's agents wrote, the caller's agent's own Star,
 * an Orbit, a Flyby, a Constellation and a Galaxy root of an organisation, and
 * one of the caller's own owner. A pre-level grant sees none of them.
 */
export const ISO_LEVELS: Record<string, { address: Address; author: Author }> = {
  planetOtherAuthor: {
    address: { level: 'user', orgId: 'local', customerId: 'self', projectId: 'pa' },
    author: { agentId: 'cursor' },
  },
  star: {
    address: { level: 'agent', orgId: 'local', agentId: 'claude-code', projectId: 'pa' },
    author: { agentId: 'claude-code' },
  },
  orbit: {
    address: { level: 'agent-user', orgId: 'local', agentId: 'claude-code', customerId: 'self' },
    author: { agentId: 'claude-code' },
  },
  flyby: {
    address: {
      level: 'run',
      orgId: 'local',
      agentId: 'claude-code',
      runId: 'r1',
      customerId: 'self',
      projectId: 'pa',
    },
    author: { agentId: 'claude-code' },
  },
  ownHive: {
    address: { level: 'hive', orgId: 'local', hiveId: 'self', projectId: 'pa' },
    author: { agentId: 'claude-code' },
  },
  constellation: {
    address: { level: 'hive', orgId: 'org:acme', hiveId: 'checkout', projectId: 'pa' },
    author: { agentId: 'claude-code', accountRef: 'acct:member' },
  },
  galaxy: {
    address: { level: 'hive', orgId: 'org:acme', hiveId: GALAXY_ROOT },
    author: { agentId: 'claude-code' },
  },
};

/**
 * Every `MemoryStore` method, called with a grant for `ISO_SCOPES.mine`
 * against memories (warm and cold) in each other scope: nothing is seen,
 * nothing changes, and nothing in a return value or error tells the cases
 * apart. Also the write-side rules (`GrantError` for an out-of-grant scope
 * and for an id that exists elsewhere, atomic batches, address changes),
 * read/write splits, cursor namespaces and rejection of non-grants.
 */
export async function isolationViolations(make: () => Promise<MemoryStore>): Promise<string[]> {
  const out: string[] = [];
  const store = await make();
  try {
    const mine = soleGrant(ISO_SCOPES.mine);
    const vec = (n: number) => Int8Array.from([n, 1, 1, 1]);
    await store.upsert(mine, isoMemory('mine-1', ISO_SCOPES.mine, 'shared', vec(1)));

    const victims: { name: string; m: Memory; g: Grant; cold: boolean }[] = [];
    let n = 2;
    const targets: [string, (id: string, marker: string, v: Int8Array) => Memory][] = [
      ...Object.entries(ISO_SCOPES)
        .filter(([name]) => name !== 'mine')
        .map(([name, scope]): [string, (id: string, marker: string, v: Int8Array) => Memory] => [
          name,
          (id, marker, v) => isoMemory(id, scope, marker, v),
        ]),
      ...Object.entries(ISO_LEVELS).map(
        ([name, at]): [string, (id: string, marker: string, v: Int8Array) => Memory] => [
          name,
          (id, marker, v) => isoAt(id, at.address, at.author, marker, v),
        ],
      ),
    ];
    for (const [name, build] of targets) {
      for (const cold of [false, true]) {
        const id = `victim-${name}-${cold ? 'cold' : 'warm'}`;
        const m = build(id, `shared canary${name}`, vec(n++));
        const g = soleGrantFor(m);
        await store.upsert(g, m);
        if (cold) {
          const { skipped } = await store.coldPut(g, m);
          if (skipped.length > 0) out.push(`${id}: seeding coldPut was skipped`);
        }
        victims.push({ name: id, m: (await store.get(g, id)) ?? m, g, cold });
      }
    }
    const snapshot = async () =>
      Promise.all(
        victims.map(
          async (v) =>
            `${render(await store.get(v.g, v.m.id))}|${render(await store.coldGet(v.g, v.m.id))}`,
        ),
      );
    const before = await snapshot();

    for (const v of victims) {
      const id = v.m.id;
      const fail = (what: string) => out.push(`${v.name}: ${what}`);
      if ((await store.get(mine, id)) !== null) fail('get returned it');
      if ((await store.coldGet(mine, id)) !== null) fail('coldGet returned it');
      const lex = await store.lexical(mine, 'shared canary', 50);
      if (lex.some((h) => h.id === id)) fail('lexical returned it');
      const den = await store.dense(mine, v.m.embedding ?? vec(1), 50);
      if (den.some((h) => h.id === id)) fail('dense returned it');
      for (const validOnly of [true, false]) {
        if ((await store.list(mine, { validOnly })).some((m) => m.id === id))
          fail('list returned it');
      }
      await store.recordAccess(mine, [id], new Date(NOW));
      if ((await store.setTier(mine, id, 'hot')) !== false) fail('setTier reported a write');
      if ((await store.setTier(mine, id, 'hot', v.m)) !== false)
        fail('guarded setTier reported a write');
      const exp = await store.expireMany(mine, [v.m], new Date(NOW));
      if (!exp.skipped.includes(id)) fail('expireMany did not skip it');
      for (const r of [await store.coldPut(mine, v.m), await store.coldPutMany(mine, [v.m])]) {
        if (!r.skipped.includes(id)) fail('coldPut did not skip it');
      }
      await store.forget(mine, id);
      const direct = await settle(store.upsert(mine, v.m));
      if (!('err' in direct) || !(direct.err instanceof GrantError)) {
        fail('upsert of its own scope was not refused with GrantError');
      }
      const moved = await settle(store.upsert(mine, movedTo(v.m, ISO_SCOPES.mine)));
      if (!('err' in moved) || !(moved.err instanceof GrantError)) {
        fail('upsert moving its id into my scope was not refused with GrantError');
      } else if (
        'err' in direct &&
        (direct.err as Error).message !== (moved.err as Error).message
      ) {
        fail('the two refusals have different messages');
      }
      const batch = await settle(
        store.upsertMany(mine, [
          isoMemory(`batch-${id}`, ISO_SCOPES.mine, 'batch'),
          movedTo(v.m, ISO_SCOPES.mine),
        ]),
      );
      if (!('err' in batch)) fail('a batch reaching it was not refused');
      if ((await store.get(mine, `batch-${id}`)) !== null)
        fail('a refused batch wrote part of itself');
    }
    const after = await snapshot();
    for (const [i, v] of victims.entries()) {
      if (before[i] !== after[i]) out.push(`${v.name}: changed through a grant that cannot see it`);
    }

    // An address change of my own record is refused too, and leaves it as it was.
    const own = await store.get(mine, 'mine-1');
    const wide = localGrant({ ...principal(ISO_SCOPES.mine), projectIds: ['pa', null] });
    const shift = await settle(
      store.upsert(wide, { ...isoMemory('mine-1', ISO_SCOPES.global, 'x') }),
    );
    if (!('err' in shift) || !(shift.err instanceof GrantError))
      out.push('mine-1: address change accepted');
    if (render(await store.get(mine, 'mine-1')) !== render(own))
      out.push('mine-1: changed by a refused move');

    // Read and write can differ: reading global does not allow changing it.
    const readGlobal = localGrant(
      { ...principal(ISO_SCOPES.mine), projectIds: ['pa', null] },
      { write: { ...principal(ISO_SCOPES.mine), projectIds: ['pa'] } },
    );
    const g = victims.find((v) => v.name === 'victim-global-warm');
    if (g !== undefined) {
      if ((await store.get(readGlobal, g.m.id)) === null)
        out.push('read side: global not readable');
      if (await store.setTier(readGlobal, g.m.id, 'hot'))
        out.push('write side: setTier on read-only global');
      await store.forget(readGlobal, g.m.id);
      if ((await store.get(g.g, g.m.id)) === null)
        out.push('write side: forget removed read-only global');
      const up = await settle(store.upsert(readGlobal, { ...g.m, text: 'rewritten' }));
      if (!('err' in up)) out.push('write side: upsert to read-only global accepted');
    }

    // Project ids that look like a store's own encodings stay distinct, and an
    // empty project list sees nothing at all.
    const tricky = ['p:pa', 'g', 'null', '["local","self"]', 'pa\u0000x', 'pa ', 'PA'];
    for (const projectId of tricky) {
      const scope = { ...principal(ISO_SCOPES.mine), projectId };
      await store.upsert(
        soleGrant(scope),
        isoMemory(`alias-${projectId}`, scope, 'aliasprobe', vec(9)),
      );
    }
    for (const projectId of tricky) {
      const g2 = soleGrant({ ...principal(ISO_SCOPES.mine), projectId });
      const ids = (await store.lexical(g2, 'aliasprobe', 50)).map((h) => h.id);
      const dense = (await store.dense(g2, vec(9), 50)).map((h) => h.id);
      const listed = (await store.list(g2, { validOnly: false })).map((m) => m.id);
      for (const [what, got] of [
        ['lexical', ids],
        ['dense', dense],
        ['list', listed],
      ] as const) {
        if (got.length !== 1 || got[0] !== `alias-${projectId}`) {
          out.push(`alias ${JSON.stringify(projectId)}: ${what} saw ${JSON.stringify(got)}`);
        }
      }
    }
    const nothing = localGrant({ ...principal(ISO_SCOPES.mine), projectIds: [] });
    if ((await store.list(nothing, { validOnly: false })).length > 0)
      out.push('empty grant: list saw records');
    if ((await store.lexical(nothing, 'shared aliasprobe', 50)).length > 0)
      out.push('empty grant: lexical saw records');
    if ((await store.dense(nothing, vec(1), 50)).length > 0)
      out.push('empty grant: dense saw records');
    if ((await store.get(nothing, 'mine-1')) !== null) out.push('empty grant: get saw a record');

    // Cursors belong to the principal.
    const other = soleGrant(ISO_SCOPES.otherCustomer);
    await store.setCursor(other, 'import:s1', 'theirs');
    if ((await store.getCursor(mine, 'import:s1')) !== null)
      out.push('cursor: read another principal');
    await store.setCursor(mine, 'import:s1', 'mine');
    if ((await store.getCursor(other, 'import:s1')) !== 'theirs')
      out.push('cursor: overwrote another principal');
    if ((await store.getCursor(soleGrant(ISO_SCOPES.otherProject), 'import:s1')) !== 'mine') {
      out.push('cursor: not shared across one principal’s projects');
    }

    // Only a real Grant is accepted, even from untyped callers.
    const raw: ScopeFilter = { ...principal(ISO_SCOPES.mine), projectIds: ['pa'] };
    const fake = Object.freeze({ principal: principal(ISO_SCOPES.mine), read: raw, write: raw });
    for (const g2 of [raw, fake, null, undefined]) {
      const r = await settle(store.get(g2 as unknown as Grant, 'mine-1'));
      if (!('err' in r) || !(r.err instanceof TypeError))
        out.push(`non-grant ${JSON.stringify(g2)} accepted`);
    }
  } finally {
    await store.close();
  }
  return out;
}

/** A small seeded PRNG (mulberry32), so a failing seed replays exactly. */
export function seededRng(seed: number): { int(n: number): number; pick<T>(xs: readonly T[]): T } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)] as (typeof xs)[number],
  };
}

type Op = { who: 'A' | 'B'; run: (s: MemoryStore) => Promise<unknown> };

const WORDS = ['orbit', 'comet', 'nebula', 'pulsar', 'quasar', 'photon', 'kuiper', 'aurora'];

/**
 * Builds one random operation sequence over two tenants. A's operations use
 * its own grant (two projects plus global, so cross-project behaviour inside
 * a principal is exercised). B's operations use B's grant and also target A's
 * ids, with every method. Ids are disjoint by construction: ids are global
 * keys (callers use UUIDs), so a tenant that reuses another tenant's id is
 * refused, which is a collision, not a leak of content.
 */
function opSequence(seed: number, steps: number, multiNode: boolean): Op[] {
  const rng = seededRng(seed);
  const planetA = ['pa', 'pa2', null].map(
    (projectId) => (id: string, t: string, e: Int8Array) =>
      isoMemory(
        id,
        projectId === null ? ISO_SCOPES.global : { ...ISO_SCOPES.mine, projectId },
        t,
        e,
      ),
  );
  // With multiNode, A also reads and writes a Constellation of another owner and its
  // agent's own Star; B (another person) its own Planet and a sibling Constellation.
  const aBuild: ((id: string, t: string, e: Int8Array) => Memory)[] = multiNode
    ? [
        ...planetA,
        (id, t, e) =>
          isoAt(id, ISO_LEVELS['constellation']!.address, { agentId: 'claude-code' }, t, e),
        (id, t, e) => isoAt(id, ISO_LEVELS['star']!.address, { agentId: 'claude-code' }, t, e),
      ]
    : planetA;
  const aGrant = multiNode
    ? nodeGrant({
        principal: ISO_PRINCIPAL,
        read: [
          {
            node: { level: 'user', orgId: 'local', customerId: 'self' },
            projectIds: ['pa', 'pa2', null],
            authorAgentId: 'claude-code',
          },
          { node: { level: 'hive', orgId: 'org:acme', hiveId: 'checkout' }, projectIds: 'all' },
          { node: { level: 'agent', orgId: 'local', agentId: 'claude-code' }, projectIds: 'all' },
        ],
      })
    : localGrant({ ...principal(ISO_SCOPES.mine), projectIds: ['pa', 'pa2', null] });
  const bScope = ISO_SCOPES.otherCustomer;
  const payments: Address = { level: 'hive', orgId: 'org:acme', hiveId: 'payments' };
  const bBuild: ((id: string, t: string, e: Int8Array) => Memory)[] = multiNode
    ? [
        (id, t, e) => isoMemory(id, bScope, t, e),
        (id, t, e) => isoAt(id, payments, { agentId: 'claude-code' }, t, e),
      ]
    : [(id, t, e) => isoMemory(id, bScope, t, e)];
  const bGrant = multiNode
    ? nodeGrant({
        principal: principal(bScope),
        read: [
          {
            node: { level: 'user', orgId: 'local', customerId: 'someone-else' },
            projectIds: ['pa'],
            authorAgentId: 'claude-code',
          },
          { node: nodeOf(payments), projectIds: 'all' },
        ],
      })
    : soleGrant(bScope);
  const ops: Op[] = [];
  const aIds: string[] = [];
  const bIds: string[] = [];
  const text = () => `${rng.pick(WORDS)} ${rng.pick(WORDS)} ${rng.pick(WORDS)}`;
  const emb = () => Int8Array.from([rng.int(9) - 4, rng.int(9) - 4, rng.int(9) - 4, 1]);
  for (let i = 0; i < steps; i++) {
    const who = rng.int(2) === 0 ? 'A' : 'B';
    const grant = who === 'A' ? aGrant : bGrant;
    const own = who === 'A' ? aIds : bIds;
    // B aims at A's ids half the time; A only ever aims at its own.
    const target = () =>
      who === 'B' && aIds.length > 0 && rng.int(2) === 0
        ? rng.pick(aIds)
        : own.length > 0
          ? rng.pick(own)
          : 'none';
    const kind = rng.int(12);
    if (kind <= 2 || own.length === 0) {
      const id = `${who}-${i}`;
      own.push(id);
      const builds = who === 'A' ? aBuild : bBuild;
      // One builder draws no number, so the pre-level sequences replay exactly.
      const build = builds.length === 1 ? builds[0]! : builds[rng.int(builds.length)]!;
      const m = { ...build(id, text(), emb()), salience: rng.int(10) / 10 };
      ops.push({ who, run: (s) => s.upsert(grant, m) });
    } else if (kind === 3) {
      const id = target();
      ops.push({ who, run: async (s) => render(await s.get(grant, id)) });
    } else if (kind === 4) {
      const q = text();
      ops.push({ who, run: async (s) => (await s.lexical(grant, q, 100)).map((h) => h.id).sort() });
    } else if (kind === 5) {
      const v = emb();
      ops.push({ who, run: async (s) => s.dense(grant, v, 5) });
    } else if (kind === 6) {
      ops.push({ who, run: async (s) => (await s.list(grant, { validOnly: false })).map(render) });
    } else if (kind === 7) {
      const id = target();
      ops.push({
        who,
        run: async (s) => {
          const m = await s.get(grant, id);
          return m === null ? 'none' : s.coldPut(grant, m);
        },
      });
    } else if (kind === 8) {
      const id = target();
      ops.push({ who, run: async (s) => render(await s.coldGet(grant, id)) });
    } else if (kind === 9) {
      const id = target();
      const tier = rng.pick(['hot', 'warm'] as const);
      ops.push({ who, run: (s) => s.setTier(grant, id, tier) });
    } else if (kind === 10) {
      const ids = [target(), target()];
      ops.push({ who, run: (s) => s.recordAccess(grant, ids, new Date(NOW)) });
    } else {
      const id = target();
      ops.push({ who, run: (s) => s.forget(grant, id) });
    }
  }
  return ops;
}

/**
 * Non-interference: tenant A's observable results (return values, errors,
 * order and scores) are the same whether or not tenant B ran its operations
 * in between, B's attempts on A's ids included. Returns null, or a message
 * naming the seed and the first step that differs.
 *
 * Lexical results are compared as id sets of a large k, not by score or
 * order: SQLite FTS5's bm25 uses table-wide term statistics, so another
 * tenant's text shifts scores (a known side channel; see the PR notes).
 * Every other result is compared exactly, dense scores included.
 *
 * `multiNode`: A's grant spans its Planet, its agent's Star and a
 * Constellation of another owner; B's spans its own Planet and a sibling
 * Constellation. Same property.
 */
export async function nonInterference(
  make: () => Promise<MemoryStore>,
  seed: number,
  steps: number,
  opts: { multiNode?: boolean } = {},
): Promise<string | null> {
  const ops = opSequence(seed, steps, opts.multiNode === true);
  const observe = async (withB: boolean): Promise<string[]> => {
    const s = await make();
    const seen: string[] = [];
    try {
      for (const op of ops) {
        if (op.who === 'B' && !withB) continue;
        const r = await settle(op.run(s));
        if (op.who === 'A') {
          seen.push('err' in r ? `error ${(r.err as Error).name}` : JSON.stringify(r.ok, jsonSafe));
        }
      }
    } finally {
      await s.close();
    }
    return seen;
  };
  const alone = await observe(false);
  const mixed = await observe(true);
  for (let i = 0; i < Math.max(alone.length, mixed.length); i++) {
    if (alone[i] !== mixed[i]) {
      return `seed ${seed}: A's step ${i} differs with B present\n  alone: ${alone[i]}\n  mixed: ${mixed[i]}`;
    }
  }
  return null;
}

function jsonSafe(_k: string, v: unknown): unknown {
  return v instanceof Int8Array ? [...v] : typeof v === 'number' ? Number(v.toFixed(9)) : v;
}
