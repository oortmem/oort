import { describe, expect, it } from 'vitest';
import {
  addressed,
  addressOf,
  assertAddress,
  assertAuthor,
  authorOf,
  canonicalMemory,
  GALAXY_ROOT,
  nodeKey,
  nodeOf,
  planetOf,
  resolveAddressing,
  spaceName,
  type Address,
} from './address.js';
import {
  canRead,
  Grant,
  grantReads,
  grantWrites,
  homeAddress,
  localGrant,
  narrowGrant,
  nodeGrant,
  principalGrant,
  readableNodes,
} from './grant.js';
import { localScope } from './scope.js';
import { makeMemory } from './store-conformance.js';

describe('addresses', () => {
  it('address.legacy-scope-is-the-owners-planet', () => {
    const m = makeMemory({ id: 'a', scope: localScope('oort-1a2b3c4d') });
    expect(addressOf(m)).toEqual({
      level: 'user',
      orgId: 'local',
      customerId: 'self',
      projectId: 'oort-1a2b3c4d',
    });
    expect(authorOf(m)).toEqual({ agentId: 'claude-code' });
    expect(planetOf({ orgId: 'acct:1', customerId: 'self', agentId: 'default' })).toEqual({
      level: 'user',
      orgId: 'acct:1',
      customerId: 'self',
    });
    // Unchanged in shape: no address, author or provenance appear.
    expect(canonicalMemory(m)).toEqual(m);
    expect(Object.keys(canonicalMemory(m))).toEqual(Object.keys(m));
  });

  it('address.each-level-allows-only-its-fields', () => {
    const legal: Address[] = [
      { level: 'user', orgId: 'o', customerId: 'c' },
      { level: 'agent', orgId: 'o', agentId: 'a', projectId: 'p' },
      { level: 'agent-user', orgId: 'o', agentId: 'a', customerId: 'c' },
      { level: 'run', orgId: 'o', agentId: 'a', runId: 'r' },
      { level: 'run', orgId: 'o', agentId: 'a', runId: 'r', customerId: 'c' },
      { level: 'hive', orgId: 'o', hiveId: GALAXY_ROOT },
    ];
    for (const a of legal) expect(() => assertAddress(a)).not.toThrow();
    const illegal: unknown[] = [
      null,
      { level: 'user', orgId: 'o' },
      { level: 'user', orgId: 'o', customerId: 'c', agentId: 'a' },
      { level: 'agent', orgId: 'o', agentId: 'a', customerId: 'c' },
      { level: 'agent-user', orgId: 'o', agentId: 'a' },
      { level: 'run', orgId: 'o', runId: 'r' },
      { level: 'hive', orgId: 'o', hiveId: 'h', customerId: 'c' },
      { level: 'hive', orgId: 'o', hiveId: '' },
      { level: 'hive', orgId: 'o', hiveId: 'h', projectId: 3 },
      { level: 'galaxy', orgId: 'o' },
      { level: 'hive', orgId: 'o', hiveId: 'h', team: 'x' },
    ];
    for (const a of illegal) expect(() => assertAddress(a), JSON.stringify(a)).toThrow(RangeError);
  });

  it('address.node-keys-never-collide-across-levels', () => {
    const nodes = [
      nodeOf({ level: 'user', orgId: 'local', customerId: 'self' }),
      nodeOf({ level: 'agent', orgId: 'local', agentId: 'self' }),
      nodeOf({ level: 'hive', orgId: 'local', hiveId: 'self' }),
      nodeOf({ level: 'agent-user', orgId: 'local', agentId: 'self', customerId: 'self' }),
      nodeOf({ level: 'run', orgId: 'local', agentId: 'self', runId: 'self' }),
      nodeOf({ level: 'run', orgId: 'local', agentId: 'self', runId: 'self', customerId: 'self' }),
      nodeOf({ level: 'user', orgId: 'local","self', customerId: 'x' }),
    ];
    expect(new Set(nodes.map(nodeKey)).size).toBe(nodes.length);
    expect(nodeKey(nodes[0]!)).toBe('["user","local","self"]');
  });

  it('address.space-names', () => {
    expect(spaceName({ level: 'user', orgId: 'o', customerId: 'c' })).toBe('Planet');
    expect(spaceName({ level: 'agent', orgId: 'o', agentId: 'a' })).toBe('Star');
    expect(spaceName({ level: 'agent-user', orgId: 'o', agentId: 'a', customerId: 'c' })).toBe(
      'Orbit',
    );
    expect(spaceName({ level: 'run', orgId: 'o', agentId: 'a', runId: 'r' })).toBe('Flyby');
    expect(spaceName({ level: 'hive', orgId: 'o', hiveId: 'checkout' })).toBe('Constellation');
    expect(spaceName({ level: 'hive', orgId: 'o', hiveId: GALAXY_ROOT })).toBe('Galaxy');
  });

  it('address.scope-must-match-the-address', () => {
    const at = addressed(
      { level: 'hive', orgId: 'org:acme', hiveId: 'checkout' },
      {
        agentId: 'cursor',
      },
    );
    expect(at.scope).toEqual({ orgId: 'org:acme', customerId: '', agentId: 'cursor' });
    const m = makeMemory({ id: 'h', ...at });
    expect(resolveAddressing(m).address).toEqual(at.address);
    expect(() => resolveAddressing({ ...m, scope: localScope() })).toThrow(RangeError);
    expect(canonicalMemory(m).address).toEqual(at.address);
    expect(canonicalMemory(m).author).toBeUndefined(); // scope.agentId already says cursor
    expect(canonicalMemory({ ...m, provenance: null })).not.toHaveProperty('provenance');
  });
});

describe('address errors name a field safely (CON-137)', () => {
  // A field name comes from a file (an export line) and ends up in a message on a terminal.
  const osc = '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007';
  it('quotes and escapes an unknown field name', () => {
    expect(() => assertAddress({ level: 'user', orgId: 'o', customerId: 'c', [osc]: 1 })).toThrow(
      `address: unknown field ${JSON.stringify(osc)}`,
    );
    expect(() => assertAuthor({ agentId: 'a', [osc]: 1 })).toThrow(
      `author: unknown field ${JSON.stringify(osc)}`,
    );
    for (const f of [
      () => assertAddress({ level: 'user', orgId: 'o', customerId: 'c', [osc]: 1 }),
      () => assertAuthor({ agentId: 'a', [osc]: 1 }),
    ]) {
      try {
        f();
      } catch (e) {
        expect((e as Error).message).not.toContain('\u001b');
        expect((e as Error).message).not.toContain('\u0007');
      }
    }
  });
});

describe('node grants', () => {
  const p = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };

  it('grant.local-grants-read-the-planet-and-own-star', () => {
    // CON-62: the person's Planet, whichever of their agents wrote it, plus this agent's own Star.
    const g = localGrant({ ...p, projectIds: ['pa', null] });
    expect(g.readNodes).toEqual([
      { node: { level: 'user', orgId: 'local', customerId: 'self' }, projectIds: ['pa', null] },
      {
        node: { level: 'agent', orgId: 'local', agentId: 'claude-code' },
        projectIds: ['pa', null],
      },
    ]);
    expect(g.writeNodes).toEqual(g.readNodes);
    expect(g.home).toEqual({ level: 'user', orgId: 'local', customerId: 'self' });
    expect(g.read.projectIds).toEqual(['pa', null]);
    expect(principalGrant(p).writeNodes[0]?.projectIds).toBe('all');
    expect(canRead(g, localScope('pa'))).toBe(true);
    expect(canRead(g, { ...localScope('pa'), agentId: 'cursor' })).toBe(true);
    const star = (agentId: string) =>
      addressed({ level: 'agent', orgId: 'local', agentId, projectId: 'pa' }, { agentId });
    expect(grantReads(g, star('claude-code'))).toBe(true);
    expect(grantReads(g, star('cursor'))).toBe(false);
    expect(grantWrites(g, star('cursor'))).toBe(false);
  });

  it('grant.home-picks-where-new-memories-land', () => {
    const cursor = { ...p, agentId: 'cursor' };
    const g = localGrant({ ...cursor, projectIds: ['pa', null] }, { home: 'star' });
    expect(g.home).toEqual({ level: 'agent', orgId: 'local', agentId: 'cursor' });
    expect(homeAddress(g, 'pa')).toEqual({
      level: 'agent',
      orgId: 'local',
      agentId: 'cursor',
      projectId: 'pa',
    });
    expect(principalGrant(cursor, { home: 'star' }).home).toEqual(g.home);
    const hive = { level: 'hive', orgId: 'org:acme', hiveId: 'checkout' } as const;
    expect(() =>
      nodeGrant({
        principal: p,
        read: [{ node: hive, projectIds: 'all' }],
        home: { level: 'user', orgId: 'local', customerId: 'self' },
      }),
    ).toThrow(RangeError);
    expect(nodeGrant({ principal: p, read: [{ node: hive, projectIds: 'all' }] }).home).toEqual(
      hive,
    );
  });

  it('grant.narrow-keeps-only-named-nodes', () => {
    const g = localGrant({ ...p, projectIds: ['pa'] }, { home: 'star' });
    const [planet, star] = readableNodes(g);
    const onlyPlanet = narrowGrant(g, [planet!]);
    expect(onlyPlanet.readNodes.map((x) => x.node)).toEqual([planet]);
    expect(onlyPlanet.home).toEqual(planet);
    expect(narrowGrant(g, [star!]).home).toEqual(star);
    expect(narrowGrant(g, []).readNodes).toEqual([]);
    expect(Grant.is(onlyPlanet)).toBe(true);
  });

  it('grant.node-grants-validate-and-freeze', () => {
    const hive = { level: 'hive', orgId: 'org:acme', hiveId: 'checkout' } as const;
    const g = nodeGrant({ principal: p, read: [{ node: hive, projectIds: 'all' }] });
    expect(Grant.is(g)).toBe(true);
    expect(Object.isFrozen(g.readNodes) && Object.isFrozen(g.readNodes[0]?.node)).toBe(true);
    expect(g.writeNodes).toEqual(g.readNodes);
    // The pre-level view never widens: no Planet pattern, no projects.
    expect(g.read.projectIds).toEqual([]);
    expect(() =>
      nodeGrant({
        principal: p,
        read: [{ node: { ...hive, customerId: 'c' } as never, projectIds: [] }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      nodeGrant({
        principal: p,
        read: [{ node: { ...hive, projectId: 'x' } as never, projectIds: [] }],
      }),
    ).toThrow(RangeError);
    expect(() => nodeGrant({ principal: p, read: [{ node: hive, projectIds: [''] }] })).toThrow(
      RangeError,
    );
    expect(() =>
      nodeGrant({ principal: p, read: [{ node: hive, projectIds: 'all', authorAgentId: '' }] }),
    ).toThrow(RangeError);
    expect(() => nodeGrant({ principal: { ...p, agentId: '' }, read: [] })).toThrow(RangeError);
  });
});
