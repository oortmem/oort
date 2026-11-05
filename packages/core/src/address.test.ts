import { describe, expect, it } from 'vitest';
import {
  addressed,
  addressOf,
  assertAddress,
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
import { canRead, Grant, localGrant, nodeGrant, principalGrant } from './grant.js';
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

describe('node grants', () => {
  const p = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };

  it('grant.pre-level-grants-are-one-author-restricted-planet-pattern', () => {
    const g = localGrant({ ...p, projectIds: ['pa', null] });
    expect(g.readNodes).toEqual([
      {
        node: { level: 'user', orgId: 'local', customerId: 'self' },
        projectIds: ['pa', null],
        authorAgentId: 'claude-code',
      },
    ]);
    expect(principalGrant(p).writeNodes[0]?.projectIds).toBe('all');
    expect(canRead(g, localScope('pa'))).toBe(true);
    expect(canRead(g, { ...localScope('pa'), agentId: 'cursor' })).toBe(false);
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
