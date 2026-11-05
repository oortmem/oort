import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  addressed,
  localGrant,
  nodeGrant,
  type Grant,
  type Memory,
  type Scope,
} from '@oortmem/core';
import { describe, expect, it } from 'vitest';
import { harness, memory } from '../test/helpers.js';
import { createOortServer } from './mcp.js';

/**
 * Canaries (CON-60): memories in every scope the CLI's own scope must not
 * reach, matching the user's queries in text, stub, entities and embedding
 * (the fake embedder's own vector), warm and cold. No output channel the CLI
 * or MCP server has (stdout, stderr, errors, exports, the hook log) may ever
 * carry a canary's marker or id.
 */
const SELF = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
const CANARY_SCOPES: Record<string, Scope> = {
  otherProject: { ...SELF, projectId: 'canary-project' },
  otherCustomer: { ...SELF, customerId: 'canary-customer' },
  // Another agent's Star (CON-62): the person's Planet is shared by their agents, a Star is not.
  otherAgent: { ...SELF, agentId: 'canary-agent' },
  otherOrg: { ...SELF, orgId: 'canary-org' },
};
const MARK = 'zqxcanary';
const CANARY_STAR = { level: 'agent', orgId: 'local', agentId: 'canary-agent' } as const;

/** Exactly the node a canary group lives in (its Planet project, or the canary agent's Star). */
function canaryGrant(name: string, scope: Scope): Grant {
  if (name === 'otherAgent') {
    return nodeGrant({ principal: scope, read: [{ node: CANARY_STAR, projectIds: [null] }] });
  }
  return localGrant({
    orgId: scope.orgId,
    customerId: scope.customerId,
    agentId: scope.agentId,
    projectIds: [scope.projectId ?? null],
  });
}

async function plantCanaries(store: Harness['store']): Promise<string[]> {
  const leaks: string[] = [MARK];
  for (const [name, scope] of Object.entries(CANARY_SCOPES)) {
    for (const cold of [false, true]) {
      const g = canaryGrant(name, scope);
      const m: Memory = memory({
        ...(name === 'otherAgent'
          ? addressed(CANARY_STAR, { agentId: 'canary-agent' })
          : { scope }),
        text: `The auth service port ${MARK} ${name} is secret.`,
        stub: `auth service port ${MARK}`,
        entities: ['auth-service', `${MARK}-${name}`],
        embedding: Int8Array.from([10, 20, 30, 40]),
      });
      await store.upsert(g, m);
      if (cold) await store.coldPut(g, m);
      leaks.push(m.id);
    }
  }
  return leaks;
}

type Harness = ReturnType<typeof harness>;

function assertClean(where: string, output: string, leaks: string[]): void {
  for (const leak of leaks) {
    expect(output.includes(leak), `${where} carried ${leak}`).toBe(false);
  }
}

describe('canaries never reach any output channel', () => {
  it('canary.cli-commands', async () => {
    const h = harness();
    const mine = memory({ embedding: Int8Array.from([10, 20, 30, 40]) });
    await h.store.upsert(localGrant({ ...SELF, projectIds: [null] }), mine);
    const leaks = await plantCanaries(h.store);
    const exportFile = path.join(h.root, 'export.json');
    const runs: string[][] = [
      ['recall', 'auth service port', '--json'],
      ['recall', MARK],
      ['explain', 'auth service port'],
      ['explain', MARK, '--json'],
      ['inspect'],
      ['inspect', '--json'],
      ['inspect', mine.id, '--json'],
      ['stats', '--json'],
      ['export', '--out', exportFile],
      ['export'],
      ['consolidate'],
      // Asking by a canary's id or id prefix is refused exactly like an unknown id.
      ...leaks.slice(1).flatMap((id) => [
        ['inspect', id],
        ['inspect', id.slice(0, 8)],
        ['forget', id, '--yes'],
        ['pin', id],
      ]),
    ];
    for (const args of runs) {
      const { io } = await h.run(args);
      assertClean(`oort ${args.join(' ')}`, io.stdout + io.stderr, leaks);
    }
    // Not vacuous: the same commands do show the user's own memory.
    expect((await h.run(['recall', 'auth service port', '--json'])).io.stdout).toContain(mine.id);
    expect(fs.readFileSync(exportFile, 'utf8')).toContain(mine.id);
    assertClean('export file', fs.readFileSync(exportFile, 'utf8'), leaks);
    const log = path.join(h.home, 'logs', 'hooks.log');
    if (fs.existsSync(log)) assertClean('hook log', fs.readFileSync(log, 'utf8'), leaks);
    // The canaries are all still there: the refused forgets and pins changed nothing.
    for (const [name, scope] of Object.entries(CANARY_SCOPES)) {
      const g = canaryGrant(name, scope);
      const left = await h.store.list(g, { validOnly: false });
      expect(left).toHaveLength(2);
      expect(left.every((m) => !m.pinned)).toBe(true);
    }
  });

  it('canary.mcp-tools', async () => {
    const h = harness();
    await h.store.upsert(localGrant({ ...SELF, projectIds: [null] }), memory());
    const leaks = await plantCanaries(h.store);
    const w = await h.wire(h.cwd);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
    const client = new Client({ name: 'canary', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const calls: { name: string; arguments: Record<string, unknown> }[] = [
        { name: 'recall', arguments: { query: 'auth service port' } },
        { name: 'recall', arguments: { query: MARK } },
        { name: 'explain', arguments: { query: 'auth service port' } },
        { name: 'list_recent', arguments: {} },
        { name: 'whoami', arguments: {} },
        ...leaks.slice(1).flatMap((id) => [
          { name: 'forget', arguments: { id } },
          { name: 'pin', arguments: { id } },
        ]),
      ];
      for (const call of calls) {
        const r = await client.callTool(call).catch((e: unknown) => ({ error: String(e) }));
        assertClean(`mcp ${call.name}`, JSON.stringify(r), leaks);
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
