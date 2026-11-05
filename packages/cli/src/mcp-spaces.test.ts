import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { addressed, type Memory } from '@oortmem/core';
import { nodesGrant } from '@oortmem/core/store-conformance';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, memory, type Harness } from '../test/helpers.js';
import { createOortServer, localSpaces } from './mcp.js';

/**
 * CON-64: the local MCP server's spaces come from trusted config (the agent it was started as),
 * never from the model. `include` and `visibility` are the only space arguments, both limited to
 * what the connection may reach; a `scope`, `project` or `agent` a model invents is ignored.
 */
const planet = { level: 'user', orgId: 'local', customerId: 'self' } as const;
const star = (agentId: string) => ({ level: 'agent', orgId: 'local', agentId }) as const;

async function household(h: Harness): Promise<Record<string, Memory>> {
  const g = nodesGrant(planet, star('cursor'), star('claude-code'));
  const ms = {
    planet: memory({ text: 'The billing service listens on port 7781.' }),
    cursorStar: memory({
      ...addressed(star('cursor'), { agentId: 'cursor' }),
      text: 'The billing service port notes live in cursor scratch.',
    }),
    ccStar: memory({
      ...addressed(star('claude-code'), { agentId: 'claude-code' }),
      text: 'The billing service port is double-checked by claude code.',
    }),
  };
  await h.store.upsertMany(g, Object.values(ms));
  return ms;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function connect(h: Harness, agent?: string) {
  const w = await h.wire(h.cwd, agent === undefined ? {} : { agent });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
  const client = new Client({ name: 'spaces-test', version: '0.0.0' });
  await client.connect(clientSide);
  open.push(async () => {
    await client.close();
    await handle.close();
  });
  return { client, w };
}

const text = (r: { content?: unknown }): string =>
  ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('');
const ids = (r: { content?: unknown }): string[] =>
  (JSON.parse(text(r)) as { memories: { id: string }[] }).memories.map((m) => m.id);

describe('oort mcp spaces (CON-64)', () => {
  it('mcp.spaces.local-spaces-follow-the-agent', async () => {
    const h = harness();
    expect(localSpaces(await h.wire(h.cwd))).toEqual({
      include: ['planet'],
      visibility: [],
      share: [],
    });
    expect(localSpaces(await h.wire(h.cwd, { agent: 'cursor' })).include).toEqual([
      'planet',
      'star',
    ]);
  });

  it('mcp.spaces.a-model-supplied-scope-argument-is-ignored', async () => {
    const h = harness();
    const ms = await household(h);
    const { client } = await connect(h, 'cursor');
    const plain = await client.callTool({
      name: 'recall',
      arguments: { query: 'billing service port' },
    });
    // The same recall, with every way a model might try to reach claude-code's Star.
    const forged = await client.callTool({
      name: 'recall',
      arguments: {
        query: 'billing service port',
        scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
        agent: 'claude-code',
        agentId: 'claude-code',
        project: 'someone-elses-project',
        grant: { nodes: [star('claude-code')] },
      },
    });
    expect(forged.isError).toBeUndefined();
    expect(ids(forged).sort()).toEqual(ids(plain).sort());
    expect(ids(forged).sort()).toEqual([ms.planet!.id, ms.cursorStar!.id].sort());
    expect(text(forged)).not.toContain(ms.ccStar!.id);
    // remember ignores it too: the fact lands where this agent writes, nowhere else.
    const saved = await client.callTool({
      name: 'remember',
      arguments: {
        facts: ['The billing service owner is the payments team.'],
        scope: { orgId: 'acct:someone-else' },
        visibility: 'private',
      },
    });
    expect(saved.isError).toBeUndefined();
    const id = (JSON.parse(text(saved)) as { results: { id: string }[] }).results[0]!.id;
    const stored = (await h.store.list(nodesGrant(planet), { validOnly: false })).find(
      (m) => m.id === id,
    );
    expect(stored?.scope.orgId).toBe('local');
  });

  it('mcp.spaces.include-is-limited-to-the-grant', async () => {
    const h = harness();
    const ms = await household(h);
    const anon = await connect(h);
    const listed = (await anon.client.listTools()).tools.find((t) => t.name === 'recall');
    const schema = listed?.inputSchema as unknown as {
      properties: { include: { items: { enum: string[] } } };
    };
    expect(schema.properties.include.items.enum).toEqual(['planet']);
    for (const include of [['star'], ['constellation'], ['galaxy']]) {
      const r = await anon.client.callTool({
        name: 'recall',
        arguments: { query: 'billing service port', include },
      });
      expect(r.isError, include.join()).toBe(true);
    }
    const p = await anon.client.callTool({
      name: 'recall',
      arguments: { query: 'billing service port', include: ['planet'] },
    });
    expect(ids(p)).toEqual([ms.planet!.id]);

    const cursor = await connect(h, 'cursor');
    const s = await cursor.client.callTool({
      name: 'recall',
      arguments: { query: 'billing service port', include: ['star'] },
    });
    expect(ids(s)).toEqual([ms.cursorStar!.id]);
    const shareTo = await cursor.client.callTool({
      name: 'remember',
      arguments: { facts: ['A fact for the team.'], visibility: 'oort-core' },
    });
    expect(shareTo.isError).toBe(true);
    expect((await cursor.client.listTools()).tools.map((t) => t.name)).not.toContain('share');
  });

  it('mcp.spaces.whoami-lists-the-spaces', async () => {
    const h = harness();
    const { client } = await connect(h, 'cursor');
    const me = JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} }))) as {
      spaces: string[];
    };
    expect(me.spaces).toEqual(['your Planet', 'Star cursor']);
  });
});
