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
