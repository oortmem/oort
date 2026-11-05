import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { AWS_KEY, harness, memory, type Harness } from '../test/helpers.js';
import { ALL_TOOL_NAMES } from '@oortmem/mcp';
import { INSTRUCTIONS, createOortServer, localBackend } from './mcp.js';
import type { CloudClient } from './cloud.js';
import { TG } from '@oortmem/core/store-conformance';

type Era = 'legacy' | 'modern';

interface Connected {
  h: Harness;
  client: Client;
  close(): Promise<void>;
}

const open: Connected[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

/** The server as `oort mcp` serves it (serveStdio picks the era), over an in-memory pipe. */
async function connect(era: Era, opts: { adapters?: boolean } = {}): Promise<Connected> {
  const h = harness(opts);
  const w = await h.wire(h.cwd);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
  const client = new Client(
    { name: 'oort-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(clientSide);
  const c: Connected = {
    h,
    client,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
  open.push(c);
  return c;
}

const text = (r: { content?: unknown }): string => {
  const content = (r.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('');
};
const json = <T>(r: { content?: unknown }): T => JSON.parse(text(r)) as T;

const ANNOTATIONS: Record<string, Record<string, boolean>> = {
  recall: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  remember: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  pin: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  explain: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_recent: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  whoami: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  record_judgment: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  judge: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

describe.each<Era>(['legacy', 'modern'])('oort mcp (%s era)', (era) => {
  it('mcp.lists-tools-with-annotations-and-instructions', async () => {
    const { client } = await connect(era);
    expect(client.getProtocolEra()).toBe(era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ALL_TOOL_NAMES.filter((n) => n !== 'share').sort(),
    );
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ ...ANNOTATIONS[t.name], openWorldHint: false });
      expect(t.annotations?.title, t.name).toBeTruthy();
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(10);
      expect(t.description?.length ?? 999, t.name).toBeLessThan(200);
    }
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toBe(INSTRUCTIONS);
    expect(instructions.split('\n\n')[0]?.length).toBeLessThan(512);
    expect(instructions.length).toBeLessThan(4096);
  });

  it('mcp.remember-then-recall', async () => {
    const { client, h } = await connect(era);
    const saved = await client.callTool({
      name: 'remember',
      arguments: { facts: ['The auth service listens on port 5582.'] },
    });
    expect(saved.isError).not.toBe(true);
    const outcome = json<{ results: { outcome: string; id?: string }[] }>(saved);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.outcome).toBe('added');
    const id = outcome.results[0]?.id ?? '';
    const stored = await h.store.get(TG, id);
    expect(stored?.source.harness).toBe('mcp');
    expect(stored?.text).toContain('port 5582');

    const found = await client.callTool({
      name: 'recall',
      arguments: { query: 'which port does the auth service listen on' },
    });
    const r = json<{ memories: { id: string; text: string; tier: string; why: string }[] }>(found);
    expect(r.memories[0]).toMatchObject({ id, tier: 'warm' });
    expect(r.memories[0]?.text).toContain('port 5582');
    expect(r.memories[0]?.why).toMatch(/lexical/);
  });

  it('mcp.recall-says-plainly-when-nothing-is-relevant', async () => {
    // Lexical-only: the harness's fake embedder gives every text the same vector.
    const { client, h } = await connect(era, { adapters: false });
    await h.store.upsert(TG, memory());
    // "auth" matches, but nothing stored is about a rollback plan or a budget.
    const found = await client.callTool({
      name: 'recall',
      arguments: { query: 'what is the rollback plan for the auth migration budget' },
    });
    expect(found.isError).not.toBe(true);
    const r = json<{ memories: unknown[]; abstained?: boolean; note?: string }>(found);
    expect(r.memories).toEqual([]);
    expect(r.abstained).toBe(true);
    expect(r.note).toMatch(/no relevant memories/i);
  });

  it('mcp.recall-takes-a-temporal-mode', async () => {
    const { client, h } = await connect(era, { adapters: false });
    await h.store.upsertMany(TG, [
      memory({
        id: 'v1',
        createdAt: '2026-03-01T00:00:00.000Z',
        validTo: '2026-05-01T00:00:00.000Z',
        expiredAt: '2026-05-01T00:00:00.000Z',
        endReason: 'superseded',
        supersededBy: 'v2',
      }),
      memory({
        id: 'v2',
        text: 'The auth service listens on port 6000.',
        createdAt: '2026-05-01T00:00:00.000Z',
        supersedes: 'v1',
      }),
    ]);
    type Out = { memories: { id: string; valid_to?: string | null }[]; mode: string };
    const call = async (args: Record<string, unknown>) =>
      json<Out>(
        await client.callTool({
          name: 'recall',
          arguments: { query: 'auth service port', ...args },
        }),
      );
    expect(await call({})).toMatchObject({ mode: 'current', memories: [{ id: 'v2' }] });
    const history = await call({ mode: 'history' });
    expect(history.mode).toBe('history');
    expect(history.memories.map((m) => m.id)).toEqual(['v1', 'v2']);
    expect(history.memories[0]?.valid_to).toBe('2026-05-01T00:00:00.000Z');
    expect(await call({ known_at: '2026-04-01' })).toMatchObject({
      mode: 'known-at 2026-04-01',
      memories: [{ id: 'v1' }],
    });
    const both = await client.callTool({
      name: 'recall',
      arguments: { query: 'auth service port', mode: 'history', as_of: '2026-04-01' },
    });
    expect(both.isError).toBe(true);
  });

  it('mcp.recall-mode-needs-its-own-date (review 12)', async () => {
    const { client } = await connect(era, { adapters: false });
    for (const args of [
      { mode: 'as-of' },
      { mode: 'known-at' },
      { mode: 'as-of', known_at: '2026-04-01' },
      { mode: 'known-at', as_of: '2026-04-01' },
      { as_of: '2026-04-01', known_at: '2026-04-01' },
    ]) {
      const r = await client.callTool({
        name: 'recall',
        arguments: { query: 'auth service port', ...args },
      });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    const ok = await client.callTool({
      name: 'recall',
      arguments: { query: 'auth service port', mode: 'as-of', as_of: '2026-04-01' },
    });
    expect(ok.isError).not.toBe(true);
  });

  it('mcp.forget-requires-an-id', async () => {
    const { client, h } = await connect(era);
    const { tools } = await client.listTools();
    const forget = tools.find((t) => t.name === 'forget');
    expect(forget?.inputSchema.required).toEqual(['id']);
    const m = memory();
    await h.store.upsert(TG, m);
    const missing = await client
      .callTool({ name: 'forget', arguments: {} })
      .then((r) => r.isError === true)
      .catch(() => true);
    expect(missing).toBe(true);
    expect(await h.store.get(TG, m.id)).not.toBeNull();
    const done = await client.callTool({ name: 'forget', arguments: { id: m.id } });
    expect(done.isError).not.toBe(true);
    expect(await h.store.get(TG, m.id)).toBeNull();
    // A second forget of the same id changes nothing and says so.
    const again = await client.callTool({ name: 'forget', arguments: { id: m.id } });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/no such memory/i);
  });
});

describe('oort mcp tools', () => {
  it('mcp.remember-takes-one-to-five-one-line-facts', async () => {
    const { client } = await connect('legacy');
    const refused = async (facts: unknown): Promise<boolean> =>
      client
        .callTool({ name: 'remember', arguments: { facts } })
        .then((r) => r.isError === true)
        .catch(() => true);
    expect(await refused([])).toBe(true);
    expect(await refused(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(true);
    expect(await refused(['x'.repeat(501)])).toBe(true);
    expect(await refused(['user: hi\nassistant: hello'])).toBe(true);
    expect(await refused('one fact')).toBe(true);
  });

  it('mcp.remember-skips-secrets-and-never-echoes-them', async () => {
    const { client } = await connect('legacy');
    const r = await client.callTool({ name: 'remember', arguments: { facts: [AWS_KEY] } });
    expect(json<{ results: { outcome: string; reason?: string }[] }>(r).results[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'secret',
    });
    expect(text(r)).not.toContain(AWS_KEY);
  });

  it('mcp.remember-without-keys-names-the-fix', async () => {
    const { client } = await connect('legacy', { adapters: false });
    const r = await client.callTool({
      name: 'remember',
      arguments: { facts: ['A durable fact.'] },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('oort keys set');
    // Recall still works, lexical-only, and says so.
    const found = await client.callTool({ name: 'recall', arguments: { query: 'durable' } });
    expect(found.isError).not.toBe(true);
    expect(json<{ note?: string }>(found).note).toMatch(/lexical-only/);
  });

  it('mcp.pin-explain-list-recent-whoami', async () => {
    const { client, h } = await connect('legacy');
    const old = memory({ text: 'The auth service listens on port 4000.' });
    const m = memory({ supersedes: old.id });
    await h.store.upsertMany(TG, [
      {
        ...old,
        validTo: m.validFrom,
        expiredAt: m.validFrom,
        endReason: 'superseded',
        supersededBy: m.id,
      },
      m,
    ]);

    const pinned = await client.callTool({ name: 'pin', arguments: { id: m.id, pinned: true } });
    expect(pinned.isError).not.toBe(true);
    expect((await h.store.get(TG, m.id))?.pinned).toBe(true);
    const again = await client.callTool({ name: 'pin', arguments: { id: m.id, pinned: true } });
    expect(json<{ changed: boolean }>(again).changed).toBe(false);

    const explained = json<{ memory: { id: string }; chain: { id: string }[] }>(
      await client.callTool({ name: 'explain', arguments: { id: m.id } }),
    );
    expect(explained.memory.id).toBe(m.id);
    expect(explained.chain.map((c) => c.id)).toEqual([old.id, m.id]);

    const recent = json<{ memories: { id: string; status: string }[] }>(
      await client.callTool({ name: 'list_recent', arguments: {} }),
    );
    expect(recent.memories.map((x) => x.id)).toContain(m.id);
    expect(recent.memories.find((x) => x.id === old.id)?.status).toBe('superseded');

    const me = json<{ mode: string; project: string | null }>(
      await client.callTool({ name: 'whoami', arguments: {} }),
    );
    expect(me).toMatchObject({ mode: 'local', project: null });
    expect(JSON.stringify(me)).not.toMatch(/@/);
  });

  it('mcp.ids-from-another-scope-are-not-found', async () => {
    const { client, h } = await connect('legacy');
    const other = memory({
      text: 'another project fact',
      scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectId: 'p' },
    });
    await h.store.upsert(TG, other);
    for (const name of ['forget', 'explain', 'pin']) {
      const args = name === 'pin' ? { id: other.id, pinned: true } : { id: other.id };
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).not.toContain('another project fact');
    }
    expect(await h.store.get(TG, other.id)).not.toBeNull();
  });
});

describe('oort mcp over a cloud that does not report the time mode (review 12)', () => {
  it('mcp.recall-says-when-a-requested-mode-was-not-applied', async () => {
    const h = harness({ adapters: false });
    const w = await h.wire(h.cwd);
    const m = memory();
    const cloud = {
      recall: async () => ({ memories: [{ ...m, explanation: {} }], timings: {} }),
    } as unknown as CloudClient;
    const backend = localBackend({ wired: { ...w, mode: 'cloud', cloud } });
    const asked = await backend.recall({ query: 'auth service port', mode: 'history', limit: 5 });
    expect(asked).toMatchObject({ mode_unsupported: true, mode: 'not reported' });
    const plain = await backend.recall({ query: 'auth service port', limit: 5 });
    expect(plain.mode_unsupported).toBeUndefined();
    await w.store.close();
  });
});
