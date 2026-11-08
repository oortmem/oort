# Frameworks

The pattern is the same everywhere: recall before the model call and inject
`formatForPrompt(result)` into the system prompt (or instructions), observe the turn after the
answer, and give the model a handle already scoped to one user. Only the Vercel AI SDK has a
shipped adapter (`oortmem/ai-sdk`); LangGraph.js and OpenAI Agents JS are tested examples you
copy into your app. Any MCP-capable framework can also run `oort mcp` with no code.

For Python, the same pattern has tested examples for LangGraph (an Oort `BaseStore` with the
semantics of the LangGraph.js one below), the OpenAI Agents SDK and CrewAI, in
[docs/python.md](https://github.com/oortmem/oort/blob/main/docs/python.md#frameworks), with the
framework versions they are tested with.

## Vercel AI SDK: `oortmem/ai-sdk` (`@experimental`)

Tested with `ai` 7.0.162. `ai` 7 is an optional peer dependency; the adapter does not import it.

<!-- example: examples/src/ai-sdk.ts -->

```ts
import { generateText, isStepCount } from 'ai';
import { createOort } from 'oortmem';
import { oortInstructions, oortObserve, oortTools } from 'oortmem/ai-sdk';

await using oort = await createOort();

const prompt = 'When do we deploy billing?';
const { text } = await generateText({
  model: 'anthropic/claude-sonnet-5.5', // any AI SDK model; a string goes through the AI Gateway
  instructions: await oortInstructions(oort, prompt), // `system` before AI SDK 7
  tools: oortTools(oort), // recall, remember, forget; { judge: true } adds judge and record_judgment
  stopWhen: isStepCount(5),
  prompt,
  onEnd: oortObserve(oort, prompt), // `onFinish` before AI SDK 7
});
console.log(text);
```

- `oortInstructions(oort, query, opts?)` returns the `<oort-memory>` block for `instructions`
  (`system` before AI SDK 7), empty when nothing relevant is remembered. `opts` takes `limit`,
  `speed` and `budgetChars`.
- `oortTools(oort, opts?)` returns `{ recall, remember, forget }` for `tools`; `{ judge: true }`
  adds `judge` and `record_judgment`. `OortToolsOptions` also take `recallLimit` (1 to 50,
  default 8) and `budgetChars`. The tools always run in the agent role, return memory only as a
  `formatForPrompt` block, and never offer `includeAgentRecorded` or `includeImported`. A refusal
  comes back to the model as `{ error: { code, message } }`.
- `oortObserve(oort, prompt, { turnRef?, onError? })` returns the `onEnd` callback (`onFinish`
  before AI SDK 7) that saves the turn. A failed save never fails the generation; `onError` hears
  about it. In a serverless function, await the generation so the save finishes first.
- With `oortmem` 0.6.0, write `tools: { ...oortTools(oort) }`; 0.6.1 accepts `oortTools(oort)`
  as it is.
- In a multi-user app pass a scoped handle: `oortTools(oort.scoped({ user: userId }))`.

## LangGraph.js (example, not a shipped adapter)

Tested with `@langchain/langgraph` 1.7.0 and `@langchain/core` 1.3.4. `OortStore` is a LangGraph
`BaseStore` over a scoped handle, passed with `compile({ store })`: `search` with a query is
`recall`, `put` of `{ text }` is `remember`, `delete` is `forget` and `get` is `explain`. Oort
assigns memory ids, so a put's key is not kept, and `get` and `delete` take Oort ids. Your own
`scopeOf` decides which namespace is which end user. A node prompts with `formatForPrompt` on
that user's handle, never with raw store values, and observes the turn.

<!-- example: examples/src/langgraph.ts -->

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import {
  BaseStore,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
  type GraphNode,
  type Item,
  type Operation,
  type OperationResults,
} from '@langchain/langgraph';
import {
  createOort,
  formatForPrompt,
  OortNotFoundError,
  type Oort,
  type ScopedOptions,
} from 'oortmem';
import { z } from 'zod';

/**
 * A LangGraph `BaseStore` over Oort: `search` with a query recalls, `put` remembers `{ text }`,
 * a `null` put (`delete`) forgets, and `get` explains. Oort assigns the ids, so a put's key is not
 * kept: `get` and `delete` take Oort ids. `scopeOf` (your code) maps a namespace to a scope.
 */
export class OortStore extends BaseStore {
  readonly oort: Oort;
  readonly scopeOf: (namespace: string[]) => ScopedOptions;

  constructor(oort: Oort, scopeOf: (namespace: string[]) => ScopedOptions) {
    super();
    this.oort = oort;
    this.scopeOf = scopeOf;
  }

  handle(namespace: string[]): Oort {
    return this.oort.scoped({ ...this.scopeOf(namespace), judgeRole: 'agent' });
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results = await Promise.all(operations.map((op) => this.run(op)));
    return results as OperationResults<Op>;
  }

  private async run(op: Operation): Promise<Item | Item[] | string[][] | null | void> {
    if ('namespacePrefix' in op) {
      if (op.query === undefined) return []; // Oort lists by relevance only
      const r = await this.handle(op.namespacePrefix).recall(op.query, { limit: op.limit ?? 10 });
      return r.memories.map((m) => ({ ...item(op.namespacePrefix, m), score: m.score }));
    }
    if ('value' in op) {
      const mem = this.handle(op.namespace);
      const text: unknown = op.value?.['text'];
      if (op.value === null) await mem.forget(op.key);
      else if (typeof text === 'string') await mem.remember(text);
      else throw new TypeError('OortStore stores values of the form { text: string }');
      return;
    }
    if ('key' in op) {
      try {
        return item(op.namespace, (await this.handle(op.namespace).explain(op.key)).memory);
      } catch (e) {
        if (e instanceof OortNotFoundError) return null;
        throw e;
      }
    }
    return []; // listNamespaces: users are your app's, not Oort's
  }
}

const item = (
  namespace: string[],
  m: { id: string; text: string; recordedAt: string; updatedAt: string },
): Item => ({
  namespace,
  key: m.id,
  value: { text: m.text },
  createdAt: new Date(m.recordedAt),
  updatedAt: new Date(m.updatedAt),
});

const oort = await createOort({ mode: 'local', org: 'acme', project: null, projectConfig: false });
// The first namespace part is the end user. A missing one throws (`user-missing`), never
// falling back to the tenant's own memory.
const store = new OortStore(oort, ([user]) => ({ user: user ?? '' }));
const model = new ChatAnthropic({ model: 'claude-haiku-5-5' });

const State = new StateSchema({ messages: MessagesValue });
const Context = z.object({ userId: z.string() });
const answer: GraphNode<typeof State, z.infer<typeof Context>> = async (state, runtime) => {
  const userId = runtime.context?.userId ?? '';
  const question = state.messages.at(-1)?.text ?? '';
  const mem = store.handle([userId]);
  const memory = formatForPrompt(await mem.recall(question));
  const reply = await model.invoke([
    { role: 'system', content: `You help customers.\n${memory}` },
    ...state.messages,
  ]);
  await mem.observe({ user: question, assistant: reply.text });
  return { messages: [reply] };
};

const graph = new StateGraph(State, Context)
  .addNode('answer', answer)
  .addEdge(START, 'answer')
  .compile({ store });

await store.put(['user-ada'], 'order', { text: 'My order number is 1042.' });
const out = await graph.invoke(
  { messages: [{ role: 'user', content: 'What is my order number?' }] },
  { context: { userId: 'user-ada' } },
);
console.log(out.messages.at(-1)?.text);
await oort.close();
```

## OpenAI Agents JS (example, not a shipped adapter)

Tested with `@openai/agents` 0.21.0. `oortSession` wraps any `Session` (here the SDK's
`MemorySession`): storage stays where it is, and each user and assistant pair is observed.
Recall goes through dynamic `instructions`, never by rewriting history.

<!-- example: examples/src/openai-agents.ts -->

```ts
import { Agent, MemorySession, run, type AgentInputItem, type Session } from '@openai/agents';
import { createOort, formatForPrompt, type Oort } from 'oortmem';

/** Wraps any `Session`: storage stays where it is, and each user and assistant pair is observed. */
export function oortSession(inner: Session, oort: Oort): Session {
  let pending: string | undefined;
  return {
    getSessionId: () => inner.getSessionId(),
    getItems: (limit) => inner.getItems(limit),
    popItem: () => inner.popItem(),
    clearSession: () => inner.clearSession(),
    async addItems(items) {
      await inner.addItems(items);
      for (const i of items) {
        if (!('role' in i)) continue;
        if (i.role === 'user') pending = textOf(i);
        else if (i.role === 'assistant' && pending !== undefined) {
          await oort.observe({ user: pending, assistant: textOf(i) });
          pending = undefined;
        }
      }
    },
  };
}

function textOf(i: AgentInputItem): string {
  if (!('content' in i)) return '';
  if (typeof i.content === 'string') return i.content;
  return i.content.map((c) => ('text' in c ? c.text : '')).join('');
}

await using root = await createOort();
const oort = root.scoped({ agent: 'support-bot', judgeRole: 'agent' });

// Recall goes through dynamic instructions, never by rewriting the history.
const agent = new Agent<{ question: string }>({
  name: 'support',
  instructions: async (ctx) =>
    `You help customers.\n${formatForPrompt(await oort.recall(ctx.context.question))}`,
});

const question = 'When do we deploy billing?';
const result = await run(agent, question, {
  session: oortSession(new MemorySession(), oort),
  context: { question },
});
console.log(result.finalOutput);
```
