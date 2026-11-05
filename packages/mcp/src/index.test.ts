import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FACT_MAX_CHARS,
  INSTRUCTIONS,
  MemoryToolError,
  REMEMBER_MAX_FACTS,
  TOOLS,
  ALL_TOOL_NAMES,
  TOOL_NAMES,
  createMcpServer,
  toolJsonSchemas,
  type MemoryBackend,
  type ToolSpaces,
} from './index.js';

// A synthetic AWS key, assembled at runtime so no credential-shaped literal sits in the repo.
const AWS_KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';

type Era = 'legacy' | 'modern';
const calls: { method: string; input: unknown }[] = [];

function fakeBackend(over: Partial<MemoryBackend> = {}): MemoryBackend {
  const log =
    <T>(method: string, out: T) =>
    async (input: unknown): Promise<T> => {
      calls.push({ method, input });
      return out;
    };
  return {
    recall: log('recall', {
      memories: [
        {
          id: 'm1',
          text: `deploys use the key ${AWS_KEY}`,
          type: 'semantic',
          tier: 'warm',
          valid_from: '2026-11-01T00:00:00.000Z',
          why: 'lexical #1',
        },
      ],
    }),
    remember: log('remember', { results: [{ fact: 0, outcome: 'added' as const, id: 'm2' }] }),
    forget: log('forget', { forgotten: 'm1' }),
    pin: log('pin', { id: 'm1', pinned: true, changed: true }),
    explain: log('explain', { memory: { id: 'm1', text: 'x' } }),
    listRecent: log('listRecent', { memories: [] }),
    whoami: log('whoami', { mode: 'test' }),
    ...over,
  };
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  calls.length = 0;
  for (const close of open.splice(0)) await close();
});

async function connect(
  era: Era,
  backend: MemoryBackend,
  isRefusal?: (e: unknown) => boolean,
  spaces?: ToolSpaces,
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () =>
      createMcpServer({
        backend,
        ...(isRefusal !== undefined && { isRefusal }),
        ...(spaces !== undefined && { spaces }),
      }),
    { transport: serverSide },
  );
  const client = new Client(
    { name: 'mcp-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(clientSide);
  open.push(async () => {
    await client.close();
    await handle.close();
  });
  return client;
}

const text = (r: { content?: unknown }): string =>
  ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('');

describe.each<Era>(['legacy', 'modern'])('@oortmem/mcp (%s era)', (era) => {
  it('mcp.serves-the-seven-tools-with-their-annotations-and-instructions', async () => {
    const client = await connect(era, fakeBackend());
    const { tools } = await client.listTools();
    // `share` is offered only to a connection whose spaces allow it (CON-64).
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES.filter((n) => n !== 'share'));
    for (const t of tools) {
      const def = TOOLS.find((d) => d.name === t.name);
      expect(t.annotations, t.name).toMatchObject(def?.annotations ?? {});
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
      expect(t.name.length, t.name).toBeLessThanOrEqual(64);
    }
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it('mcp.remember-rejects-transcript-shaped-input', async () => {
    const client = await connect(era, fakeBackend());
    const tooMany = await client.callTool({
      name: 'remember',
      arguments: { facts: Array.from({ length: REMEMBER_MAX_FACTS + 1 }, (_, i) => `fact ${i}`) },
    });
    expect(tooMany.isError).toBe(true);
    const tooLong = await client.callTool({
      name: 'remember',
      arguments: { facts: ['x'.repeat(FACT_MAX_CHARS + 1)] },
    });
    expect(tooLong.isError).toBe(true);
    const multiLine = await client.callTool({
      name: 'remember',
      arguments: { facts: ['user: hi\nassistant: hello'] },
    });
    expect(multiLine.isError).toBe(true);
    expect(calls.filter((c) => c.method === 'remember')).toHaveLength(0);
  });

  it('mcp.remember-dedupes-facts-before-the-backend', async () => {
    const client = await connect(era, fakeBackend());
    await client.callTool({ name: 'remember', arguments: { facts: ['a', 'a', 'b'] } });
    expect(calls).toEqual([
      { method: 'remember', input: { facts: ['a', 'b'], visibility: 'private' } },
    ]);
  });

  it('mcp.scrubs-text-fields-before-they-reach-the-host', async () => {
    const client = await connect(era, fakeBackend());
    const r = await client.callTool({ name: 'recall', arguments: { query: 'deploy key' } });
    expect(text(r)).not.toContain(AWS_KEY);
    expect(text(r)).toContain('[REDACTED');
    expect(calls[0]).toEqual({ method: 'recall', input: { query: 'deploy key', limit: 5 } });
  });

  it('mcp.refusals-show-their-message-and-other-errors-are-prefixed', async () => {
    class Refusal extends Error {}
    const client = await connect(
      era,
      fakeBackend({
        forget: async () => {
          throw new MemoryToolError('No memory matches that id.');
        },
        pin: async () => {
          throw new Refusal('Pin needs a store you can write.');
        },
        explain: async () => {
          throw new Error('disk on fire');
        },
      }),
      (e) => e instanceof Refusal,
    );
    const forgot = await client.callTool({ name: 'forget', arguments: { id: 'zz' } });
    expect([forgot.isError, text(forgot)]).toEqual([true, 'No memory matches that id.']);
    const pinned = await client.callTool({ name: 'pin', arguments: { id: 'zz', pinned: true } });
    expect([pinned.isError, text(pinned)]).toEqual([true, 'Pin needs a store you can write.']);
    const explained = await client.callTool({ name: 'explain', arguments: { id: 'zz' } });
    expect([explained.isError, text(explained)]).toEqual([true, 'oort: disk on fire']);
  });
});

const TEAM: ToolSpaces = {
  include: ['planet', 'constellation'],
  visibility: ['oort-core'],
  share: ['oort-core'],
};
const share = async (input: unknown) => {
  calls.push({ method: 'share', input });
  return { shared: true, constellation: 'oort-core', id: 'c1', text: 'x' };
};

describe.each<Era>(['legacy', 'modern'])('@oortmem/mcp spaces (%s era, CON-64)', (era) => {
  it('mcp.spaces.share-is-listed-only-when-the-spaces-and-backend-allow-it', async () => {
    const names = async (backend: MemoryBackend, spaces?: ToolSpaces) =>
      (await (await connect(era, backend, undefined, spaces)).listTools()).tools.map((t) => t.name);
    expect(await names(fakeBackend({ share }))).not.toContain('share');
    expect(await names(fakeBackend({ share }), { ...TEAM, share: [] })).not.toContain('share');
    expect(await names(fakeBackend(), TEAM)).not.toContain('share');
    expect(await names(fakeBackend({ share }), TEAM)).toEqual([...TOOL_NAMES]);
    const client = await connect(era, fakeBackend({ share }), undefined, TEAM);
    const listed = (await client.listTools()).tools.find((t) => t.name === 'share');
    expect(listed?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('mcp.spaces.a-model-supplied-scope-argument-never-reaches-the-backend', async () => {
    const client = await connect(era, fakeBackend(), undefined, TEAM);
    await client.callTool({
      name: 'recall',
      arguments: {
        query: 'deploy',
        scope: { orgId: 'acct:someone-else', customerId: 'self' },
        project: 'other-project',
        agent: 'cursor',
        orgId: 'org:evil',
      },
    });
    await client.callTool({
      name: 'remember',
      arguments: {
        facts: ['a fact'],
        scope: { orgId: 'acct:x' },
        project: 'p',
        visibility: 'private',
      },
    });
    expect(calls).toEqual([
      { method: 'recall', input: { query: 'deploy', limit: 5 } },
      { method: 'remember', input: { facts: ['a fact'], visibility: 'private' } },
    ]);
  });

  it('mcp.spaces.include-is-limited-to-the-levels-the-connection-reads', async () => {
    const planet = await connect(era, fakeBackend());
    const refused = await planet.callTool({
      name: 'recall',
      arguments: { query: 'q', include: ['constellation'] },
    });
    expect(refused.isError).toBe(true);
    const team = await connect(era, fakeBackend(), undefined, TEAM);
    const galaxy = await team.callTool({
      name: 'recall',
      arguments: { query: 'q', include: ['galaxy'] },
    });
    expect(galaxy.isError).toBe(true);
    const ok = await team.callTool({
      name: 'recall',
      arguments: { query: 'q', include: ['constellation'] },
    });
    expect(ok.isError).toBeUndefined();
    expect(calls).toEqual([
      { method: 'recall', input: { query: 'q', limit: 5, include: ['constellation'] } },
    ]);
  });

  it('mcp.spaces.remember-visibility-and-share-target-only-granted-constellations', async () => {
    const client = await connect(era, fakeBackend({ share }), undefined, TEAM);
    const elsewhere = await client.callTool({
      name: 'remember',
      arguments: { facts: ['f'], visibility: 'someone-elses-team' },
    });
    expect(elsewhere.isError).toBe(true);
    await client.callTool({
      name: 'remember',
      arguments: { facts: ['f'], visibility: 'oort-core' },
    });
    const out = await client.callTool({ name: 'share', arguments: { id: 'm1', to: 'other-team' } });
    expect(out.isError).toBe(true);
    await client.callTool({ name: 'share', arguments: { id: 'm1', to: 'oort-core', extra: 1 } });
    expect(calls).toEqual([
      { method: 'remember', input: { facts: ['f'], visibility: 'oort-core' } },
      { method: 'share', input: { id: 'm1', to: 'oort-core' } },
    ]);
    const planet = await connect(era, fakeBackend());
    const r = await planet.callTool({
      name: 'remember',
      arguments: { facts: ['g'], visibility: 'oort-core' },
    });
    expect(r.isError).toBe(true);
  });
});

describe('@oortmem/mcp definitions', () => {
  it('mcp.json-schemas-follow-the-spaces', () => {
    const team = toolJsonSchemas(TEAM) as Record<string, any>;
    expect(team.recall.properties.include.items.enum).toEqual(['planet', 'constellation']);
    expect(team.remember.properties.visibility.enum).toEqual(['private', 'oort-core']);
    expect(team.share.properties.to.enum).toEqual(['oort-core']);
    const planet = toolJsonSchemas() as Record<string, any>;
    expect(planet.recall.properties.include.items.enum).toEqual(['planet']);
    expect(planet.remember.properties.visibility.enum).toEqual(['private']);
    for (const s of Object.values(team)) expect(JSON.stringify(s)).not.toMatch(/"scope"/);
  });

  it('mcp.json-schemas-cover-every-tool', () => {
    const schemas = toolJsonSchemas();
    expect(Object.keys(schemas)).toEqual([...ALL_TOOL_NAMES]);
    expect(schemas.remember).toMatchObject({
      type: 'object',
      properties: { facts: { type: 'array', maxItems: REMEMBER_MAX_FACTS } },
    });
  });

  // What the Claude and ChatGPT directory reviews check on every tool: a title, explicit boolean
  // hints, a short name and a narrow description that says what the tool does, not how the model
  // should behave or which other tools or products to use.
  it('mcp.tools-meet-the-directory-review-rules', () => {
    const hints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z_]{0,63}$/);
      expect(t.annotations.title, t.name).toBe(t.title);
      expect(t.title.length, t.name).toBeGreaterThan(0);
      for (const h of hints) expect(typeof t.annotations[h], `${t.name}.${h}`).toBe('boolean');
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.description.length, t.name).toBeLessThanOrEqual(200);
      expect(t.description, t.name).not.toMatch(
        /\b(always (call|use)|you must|never call|ignore|instead of|prefer|claude|chatgpt|openai|anthropic)\b/i,
      );
    }
    expect(INSTRUCTIONS).not.toMatch(/\b(ignore|system prompt|instead of|prefer oort)\b/i);
  });

  it('mcp.write-and-destructive-tools-are-marked', () => {
    const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]));
    expect(by['forget']).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(by['remember']).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const n of ['recall', 'explain', 'list_recent', 'whoami'] as const) {
      expect(by[n], n).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });
});
