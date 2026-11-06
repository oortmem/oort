# Oort SDK examples

One small, runnable file per scenario, each shown in full in [docs/sdk.md](../docs/sdk.md). A
private workspace package: never published.

| File                                               | Scenario                                                   | In CI                                  |
| -------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| [`local-quick-start.ts`](src/local-quick-start.ts) | Local quick start                                          | typecheck, run                         |
| [`cloud-quick-start.ts`](src/cloud-quick-start.ts) | Cloud quick start (`OORT_API_KEY`)                         | typecheck, run (fake Oort Cloud)       |
| [`multi-user.ts`](src/multi-user.ts)               | A multi-user app: `scoped({ user })` and an explicit `org` | typecheck, run                         |
| [`judgments.ts`](src/judgments.ts)                 | Judgments: record, confirm in the expert role, apply       | typecheck, run                         |
| [`errors.ts`](src/errors.ts)                       | Errors: `OortError.code`, `retryable`, `retryAfter`        | typecheck, run (fake Oort Cloud)       |
| [`serverless.ts`](src/serverless.ts)               | Serverless: cloud mode, a handler and `await using`        | typecheck, run (fake Oort Cloud)       |
| [`ai-sdk.ts`](src/ai-sdk.ts)                       | Vercel AI SDK through `oortmem/ai-sdk`                     | typecheck, run (`MockLanguageModelV4`) |
| [`langgraph.ts`](src/langgraph.ts)                 | LangGraph.js: an Oort `BaseStore` and a node               | typecheck, run (`FakeListChatModel`)   |
| [`openai-agents.ts`](src/openai-agents.ts)         | OpenAI Agents SDK: an observing `Session`                  | typecheck, run (`ScriptedModel`)       |

`pnpm verify` typechecks every file against the built `oortmem` and the pinned framework versions
(`package.json`), and [test/examples.test.ts](test/examples.test.ts) runs each one: local mode on
a temporary home with the SDK's deterministic model fakes, cloud mode against the shared fake
Oort Cloud, and every framework with its own fake model. The tests make no network call.
[test/docs.test.ts](test/docs.test.ts) fails when docs/sdk.md and a file here differ, or when the
docs name an API the built declarations lack. After editing an example, run `pnpm docs:examples`.

To run one for real (Node 24 or newer runs TypeScript directly), build first, then pass your keys:

```sh
pnpm install && pnpm build
OORT_API_KEY=… node examples/src/cloud-quick-start.ts
node examples/src/local-quick-start.ts          # uses what `oort setup` chose
ANTHROPIC_API_KEY=… node examples/src/langgraph.ts
```
