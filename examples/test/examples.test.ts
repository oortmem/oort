import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { setDefaultModelProvider, setTracingDisabled, type ModelRequest } from '@openai/agents';
import { ScriptedModel, assistantMessage, modelResponder } from '@openai/agents/testing';
import { customProvider } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOortWith } from '../../packages/cli/src/sdk/create.js';
import { OortNotFoundError } from '../../packages/cli/src/sdk/errors.js';
import type { Oort, OortOptions } from '../../packages/cli/src/sdk/types.js';
import { newHarness, runExample, type Harness } from './harness.js';

/**
 * Runs every example in examples/src against the real SDK (local engine on a temporary home, or
 * the shared fake Oort Cloud) with each framework's own fake model. Only `createOort` is swapped,
 * for one that adds the test home, the fake cloud and the SDK's deterministic model fakes. The
 * examples' code is exactly what docs/sdk.md shows (docs.test.ts checks that).
 */

const state = vi.hoisted(() => ({
  h: undefined as Harness | undefined,
  /** What the LangGraph example's model was sent. */
  langchainCalls: [] as string[][],
}));

vi.mock('oortmem', async () => {
  const sdk = await import('../../packages/cli/src/sdk/index.js');
  const { createOortWith: createWith } = await import('../../packages/cli/src/sdk/create.js');
  return {
    ...sdk,
    createOort: (options?: OortOptions) => state.h!.create(options, createWith),
  };
});

// The LangGraph example's ChatAnthropic, as LangChain's own fake chat model.
vi.mock('@langchain/anthropic', async () => {
  const { FakeListChatModel: Fake } = await import('@langchain/core/utils/testing');
  class ChatAnthropic extends Fake {
    constructor(_fields: unknown) {
      super({ responses: ['Your order number is 1042.'] });
    }
    override _generate(...args: Parameters<FakeListChatModel['_generate']>) {
      state.langchainCalls.push(args[0].map((m) => `${m.type}: ${m.text}`));
      return super._generate(...args);
    }
    override _streamResponseChunks(
      ...args: Parameters<FakeListChatModel['_streamResponseChunks']>
    ) {
      state.langchainCalls.push(args[0].map((m) => `${m.type}: ${m.text}`));
      return super._streamResponseChunks(...args);
    }
  }
  return { ChatAnthropic };
});

let h: Harness;
beforeEach(() => {
  h = newHarness();
  state.h = h;
});
afterEach(() => {
  delete globalThis.AI_SDK_DEFAULT_PROVIDER;
});

const open = (options: OortOptions = {}): Promise<Oort> => h.open(options, createOortWith);
const texts = async (oort: Oort, query: string) =>
  (await oort.recall(query, { speed: 'lexical' })).memories.map((m) => m.text);

describe('SDK examples (run)', () => {
  it('local-quick-start: observes a turn, then recalls it as a prompt block', async () => {
    const { out } = await runExample('local-quick-start.ts');
    expect(h.calls).toEqual([{}]);
    expect(out.join('\n')).toMatch(
      /^<oort-memory>\n- \[semantic, today\] We deploy on Fridays now\./,
    );
  });

  it('cloud-quick-start: remembers and recalls through Oort Cloud', async () => {
    const { out } = await runExample('cloud-quick-start.ts');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('The user lives in Lund.');
    expect(h.cloud.seen).toContain('POST /v1/observe');
    expect(h.cloud.seen).toContain('POST /v1/recall');
  });

  it('multi-user: each end user gets their own Planet', async () => {
    const { out } = await runExample('multi-user.ts');
    expect(out[0]).toMatch(/^<oort-memory>\n.*My order number is 1042\./);
    expect(out[1]).toBe('0');
    const oort = await open({ mode: 'local', org: 'acme', project: null, projectConfig: false });
    expect(await texts(oort.scoped({ user: 'user-ada' }), 'order number')).toEqual([
      'My order number is 1042.',
    ]);
    expect(await texts(oort.scoped({ user: 'user-bob' }), 'order number')).toEqual([]);
    // The person's own memory (the CLI's) never sees an end user's.
    expect(await texts(oort, 'order number')).toEqual([]);
    await oort.close();
  });

  it('cloud-multi-user: a server key gives each end user their own Planet (CON-132)', async () => {
    h.cloud.endUsers.serverKey = true;
    const { out } = await runExample('cloud-multi-user.ts');
    expect(out[0]).toMatch(/^<oort-memory>\n.*My order number is 1042\./);
    expect(out.slice(1)).toEqual(['0', '1 of 100 end users', 'erased 1 memories']);
    // Every memory request named its end user; the account's own Planet holds nothing.
    expect(h.cloud.memories.size).toBe(0);
    expect(h.cloud.endUsers.users.size).toBe(0);
    const named = h.cloud.seen.map((r, i) => [r, h.cloud.endUsers.headers[i]]);
    expect(named.filter(([r]) => r === 'POST /v1/observe')).toEqual([
      ['POST /v1/observe', 'user-ada'],
    ]);
  });

  it('cloud-data-requests: access, portability, rectification and erasure (CON-137)', async () => {
    h.cloud.endUsers.serverKey = true;
    const file = path.join(os.tmpdir(), 'user-ada-memories.jsonl');
    fs.rmSync(file, { force: true });
    try {
      const { out } = await runExample('cloud-data-requests.ts');
      expect(out).toEqual([
        'exported 1 memories',
        // The fake cloud's writer never ends a fact, so the example forgets the wrong one.
        'forgot the wrong fact',
        'erased 1 memories',
        'left 0',
      ]);
      // The file handed over: owner-only, the export format, the fact as it was then.
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const [head, ...lines] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      expect(JSON.parse(head!)).toMatchObject({ oort: 'export', memories: 1 });
      expect(lines.join('\n')).toContain('Oslo');
      // Export and erasure act as the account; every memory call named the end user.
      const named = h.cloud.seen.map((r, i) => [r, h.cloud.endUsers.headers[i]] as const);
      for (const [route, user] of named) {
        expect([route, user]).toEqual([
          route,
          route.startsWith('GET /v1/whoami') || route.includes('/v1/end-users/')
            ? null
            : 'user-ada',
        ]);
      }
      expect(named.filter(([r]) => r.startsWith('DELETE /v1/memories/'))).toHaveLength(1);
      expect(h.cloud.endUsers.users.size).toBe(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('cloud-multi-user: an Oort Cloud without per-user memory sends nothing', async () => {
    h.cloud.endUsers.server = 'legacy';
    const { out, err } = await runExample('cloud-multi-user.ts').catch((e: unknown) => ({
      out: [],
      err: [String((e as Error).name), String((e as { reason?: string }).reason)],
    }));
    expect(out).toEqual([]);
    expect(err).toEqual(['OortRefusedError', 'end-users-unsupported']);
    expect(h.cloud.seen).toEqual(['GET /v1/whoami']);
    expect(h.cloud.memories.size).toBe(0);
  });

  it('judgments: records as an expert, confirms an agent record, applies', async () => {
    const { out } = await runExample('judgments.ts');
    expect(out[0]).toBe('agent-recorded');
    const [status, verdict, precedents] = out[1]!.split(' ');
    expect(['suggested', 'needs-expert', 'precedents-only']).toContain(status);
    if (status === 'suggested') expect(verdict).toBe('rejected');
    expect(Number(precedents)).toBe(2); // the confirmed agent record counts
    const oort = await open({ mode: 'local' });
    const { judgments } = await oort.judge.list();
    expect(judgments.map((j) => [j.via, j.confirmed]).sort()).toEqual([
      ['mcp', true],
      ['sdk', true],
    ]);
    await oort.close();
  });

  it('spatial: remembers ten things in three rooms, recalls within a room and near a point', async () => {
    const { out } = await runExample('spatial.ts');
    const rows = out.map((l) => l.split(' | '));
    const inB = rows.filter(([at]) => at!.startsWith('site:'));
    const near = rows.filter(([at]) => !at!.startsWith('site:'));
    // Only room B and what is below it; both of its toolboxes; nothing from rooms A or C.
    for (const [at] of inB) expect(`${at}/`).toMatch(/^site:hq\/room:B\//);
    expect(inB.map(([, text]) => text)).toEqual(
      expect.arrayContaining([
        'The blue toolbox is on shelf B3.',
        'The green toolbox sits under the window.',
      ]),
    );
    // Within 1.5 m of (13, 3): the green toolbox, 1 m away.
    for (const [d] of near) expect(Number(d)).toBeLessThanOrEqual(1.5);
    expect(near).toContainEqual(['1.00', 'The green toolbox sits under the window.']);
    const oort = await open({ mode: 'local' });
    const { memories } = await oort.recent({ limit: 20 });
    expect(memories).toHaveLength(10);
    expect(memories.every((m) => m.place?.mapId === 'hq')).toBe(true);
    await oort.close();
  });

  describe('errors', () => {
    it('retries a rate limit after Retry-After, then saves', async () => {
      h.cloud.fail = { 'POST /v1/observe': { status: 429, code: 'rate_limit', retryAfter: '1' } };
      const fetch = h.cloud.fetch;
      h.cloud.fetch = async (input, init) => {
        const res = await fetch(input, init);
        if (res.status === 429) delete h.cloud.fail; // the limit passes
        return res;
      };
      const { out, err } = await runExample('errors.ts');
      expect(err).toEqual([]);
      expect(out).toEqual(['saved: added']);
      expect(h.cloud.seen.filter((s) => s === 'POST /v1/observe')).toHaveLength(2);
    });

    it('reports a refusal by code and reason, without retrying', async () => {
      h.cloud.fail = { 'POST /v1/observe': 402 };
      const { out, err } = await runExample('errors.ts');
      expect(out).toEqual([]);
      expect(err).toEqual([expect.stringMatching(/^Refused \(payment-required\): /)]);
      expect(h.cloud.seen.filter((s) => s === 'POST /v1/observe')).toHaveLength(1);
    });

    it('reports a missing key with its fix', async () => {
      h.withKey = false;
      const { err } = await runExample('errors.ts');
      expect(err).toEqual(['No usable Oort key (no-key). Fix: oort login']);
      expect(h.cloud.seen).toEqual([]);
    });
  });

  it('serverless: a module-scope handle, a handler, and a one-shot job', async () => {
    const { module } = await runExample('serverless.ts');
    const handler = module['handler'] as (e: {
      question: string;
      requestId: string;
    }) => Promise<string>;
    const importFacts = module['importFacts'] as (facts: string[]) => Promise<number>;
    expect(await importFacts(['Refunds take five working days.'])).toBe(1);
    const event = { question: 'How long do refunds take?', requestId: 'req-1' };
    expect(await handler(event)).toMatch(
      /^\(an answer to "How long do refunds take\?", written with \d+ characters/,
    );
    // A retried invocation (the same requestId) is saved once.
    await handler(event);
    expect(h.cloud.turns.has('req-1')).toBe(true);
    expect(h.cloud.recalls.map((r) => r['project'])).toEqual([
      'cfg:support-site',
      'cfg:support-site',
    ]);
    expect([...h.cloud.memories.values()].map((m) => m.text)).toHaveLength(2);
    expect(h.calls.every((o) => o.mode === 'cloud' && o.projectConfig === false)).toBe(true);
  });
});

describe('framework examples (run with each framework’s fake model)', () => {
  it('ai-sdk: memory in the instructions, tools in the loop, the turn saved on onEnd', async () => {
    const seed = await open();
    await seed.remember('We deploy the billing service on Fridays.');
    await seed.close();

    const prompts: string[] = [];
    let step = 0;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return step++ === 0
          ? {
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'c1',
                  toolName: 'recall',
                  input: JSON.stringify({ query: 'billing deploy day' }),
                },
              ],
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage,
              warnings: [],
            }
          : {
              content: [{ type: 'text' as const, text: 'Billing deploys on Fridays.' }],
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage,
              warnings: [],
            };
      },
    });
    // The example names its model by string: the AI SDK's global provider resolves it.
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: { 'anthropic/claude-sonnet-5.5': model },
    });

    const { out } = await runExample('ai-sdk.ts');
    expect(out).toEqual(['Billing deploys on Fridays.']);
    expect(prompts[0]).toContain('<oort-memory>');
    expect(prompts[0]).toContain('We deploy the billing service on Fridays.');
    expect(prompts[1]).toContain('tool-result'); // the recall tool ran
    const oort = await open();
    expect(await texts(oort, 'When do we deploy billing')).toContain('When do we deploy billing?');
    await oort.close();
  });

  it('langgraph: an Oort-backed BaseStore and a node that prompts with formatForPrompt', async () => {
    state.langchainCalls.length = 0;
    const { out, module } = await runExample('langgraph.ts');
    expect(out).toEqual(['Your order number is 1042.']);
    const system = state.langchainCalls[0]![0]!;
    expect(system).toMatch(
      /^system: You help customers\.\n<oort-memory>\n.*My order number is 1042\./,
    );

    // The store itself: search recalls, get explains, a null put forgets.
    const oort = await open({ mode: 'local', org: 'acme', project: null, projectConfig: false });
    const OortStore = module['OortStore'] as new (
      o: Oort,
      scopeOf: (ns: string[]) => { user: string },
    ) => import('@langchain/langgraph').BaseStore;
    const userScope = module['userScope'] as (ns: string[]) => { user: string };
    const store = new OortStore(oort, userScope); // the example's own scope
    const found = await store.search(['user-ada'], { query: 'order number' });
    expect(found.map((i) => i.value['text'])).toContain('My order number is 1042.');
    const id = found.find((i) => i.value['text'] === 'My order number is 1042.')!.key;
    expect((await store.get(['user-ada'], id))?.value).toEqual({
      text: 'My order number is 1042.',
    });
    expect(await store.search(['user-bob'], { query: 'order number' })).toEqual([]);
    await store.delete(['user-ada'], id);
    expect(await store.get(['user-ada'], id)).toBeNull();
    // The node observed the turn for that user only.
    expect(await texts(oort.scoped({ user: 'user-ada' }), 'What is my order number')).toContain(
      'What is my order number?',
    );

    // Two users, one query: each reads, gets and forgets only their own.
    await store.put(['user-fay'], 'code', { text: 'My locker code is 4410.' });
    await store.put(['user-gus'], 'code', { text: 'My locker code is 7782.' });
    const q = { query: 'what is my locker code' };
    const fay = await store.search(['user-fay'], q);
    expect(fay.map((i) => i.value['text'])).toEqual(['My locker code is 4410.']);
    expect((await store.search(['user-gus'], q)).map((i) => i.value['text'])).toEqual([
      'My locker code is 7782.',
    ]);
    const mine = fay[0]!.key;
    expect(await store.get(['user-gus'], mine)).toBeNull(); // another user's id: as unknown
    await expect(store.delete(['user-gus'], mine)).rejects.toBeInstanceOf(OortNotFoundError);
    expect((await store.get(['user-fay'], mine))?.value).toEqual({
      text: 'My locker code is 4410.',
    });

    // Any namespace but [userId] is refused, never read as some user (or as no one).
    for (const bad of [[], ['memories', 'user-fay'], ['user-fay', 'notes']]) {
      await expect(store.search(bad, q), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(store.search([''], q)).rejects.toThrow(); // LangGraph.js refuses it first
    // Relevance only: a filter or an offset is refused, not silently ignored.
    await expect(store.search(['user-fay'], { ...q, filter: { tag: 'x' } })).rejects.toThrow(
      /no filter or offset/,
    );
    await expect(store.search(['user-fay'], { ...q, offset: 5 })).rejects.toThrow(
      /no filter or offset/,
    );
    expect(await store.search(['user-fay'], { ...q, filter: {}, offset: 0 })).toHaveLength(1);
    await expect(
      store.put(['memories', 'user-fay'], 'k', { text: "LangMem's namespace shape" }),
    ).rejects.toBeInstanceOf(TypeError);
    await oort.close();
  });

  it('openai-agents: recall in dynamic instructions, each turn observed through the Session', async () => {
    const seed = await open();
    await seed.remember('We deploy the billing service on Fridays.');
    await seed.close();

    const requests: ModelRequest[] = [];
    const model = new ScriptedModel([
      modelResponder((call) => {
        requests.push(call.request);
        return [assistantMessage('Billing deploys on Fridays.')];
      }),
    ]);
    setTracingDisabled(true);
    setDefaultModelProvider({ getModel: () => model });

    const { out } = await runExample('openai-agents.ts');
    expect(out).toEqual(['Billing deploys on Fridays.']);
    model.assertComplete();
    expect(requests[0]!.systemInstructions).toMatch(
      /^You help customers\.\n<oort-memory>\n.*We deploy the billing service on Fridays\./,
    );
    const oort = await open();
    expect(await texts(oort, 'When do we deploy billing')).toContain('When do we deploy billing?');
    await oort.close();
  });
});
