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
  TOOL_NAMES,
  createMcpServer,
  toolJsonSchemas,
  type MemoryBackend,
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

async function connect(era: Era, backend: MemoryBackend, isRefusal?: (e: unknown) => boolean) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createMcpServer({ backend, ...(isRefusal !== undefined && { isRefusal }) }),
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
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
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
    expect(calls).toEqual([{ method: 'remember', input: { facts: ['a', 'b'] } }]);
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

describe('@oortmem/mcp definitions', () => {
  it('mcp.json-schemas-cover-every-tool', () => {
    const schemas = toolJsonSchemas();
    expect(Object.keys(schemas)).toEqual([...TOOL_NAMES]);
    expect(schemas.remember).toMatchObject({
      type: 'object',
      properties: { facts: { type: 'array', maxItems: REMEMBER_MAX_FACTS } },
    });
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
