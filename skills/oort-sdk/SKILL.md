---
name: oort-sdk
description: Integrate Oort, open-source long-term memory for AI agents, into an app, service or agent framework with the oortmem TypeScript SDK (createOort, recall, observe, remember, formatForPrompt, scoped, judgments, OortError) or the oort CLI's oort.v1 JSON. Use when adding memory to a Node.js or TypeScript agent, a Vercel AI SDK, LangGraph.js or OpenAI Agents JS app, a multi-user or serverless backend, or a Python program that calls the oort CLI, and when choosing between Oort's hooks, MCP server, SDK and CLI.
license: Apache-2.0
compatibility: Written for oortmem 0.6.3. The SDK needs Node.js 22.15 or newer and is ESM. The CLI is `npm i -g oortmem`, or `pipx install oortmem`, which still runs Node.
metadata:
  oortmem-version: '0.6.3'
---

# Building with Oort

Oort is long-term memory for agents: it distils conversation turns into short facts, closes out
facts that change instead of overwriting them, and recalls what is true now. The npm package
`oortmem` is both the `oort` command line and, since 0.6.0, a TypeScript library:
`createOort()` gives code the same memory the CLI, the Claude Code hooks and the MCP server use.

This skill describes `oortmem` 0.6.3. Use only the names it and its references give. When
something is not covered, read the installed package's declarations
(`node_modules/oortmem/dist/sdk/index.d.ts` and `node_modules/oortmem/dist/sdk/adapters/ai-sdk.d.ts`) or
the generated reference at https://github.com/oortmem/oort/blob/main/docs/sdk-reference.md. Do
not guess a method, option or flag: an unknown option throws `OortUsageError`.

## 1. Pick the integration

| The user wants                                                                                          | Use                                             | Code to write |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| Memory in their own Claude Code sessions: recall before each prompt, save after each turn               | The hooks: `oort setup`, or the plugin          | none          |
| A model in an MCP host (Cursor, Codex, Gemini CLI, Claude Desktop, any MCP client) to recall on its own | The MCP server: `oort connect <host>`           | none          |
| Memory inside their own TypeScript or Node.js app, agent, framework or backend                          | The SDK: `import { createOort } from 'oortmem'` | yes           |
| Memory from a script, CI job or another language (Python today)                                         | The CLI with `--json` (`oort.v1`)               | a wrapper     |

Details, install commands and how they share one store: [references/integrations.md](references/integrations.md).

## 2. The agent loop

One handle per process. Before the model call, `recall` and put `formatForPrompt(result)` in the
system prompt. After answering, `observe` the turn. Use `remember` only for facts the user stated
or confirmed.

<!-- example: examples/src/local-quick-start.ts -->

```ts
import { createOort, formatForPrompt } from 'oortmem';

// What `oort setup` chose on this machine (local by default), with its keys.
await using oort = await createOort();

await oort.observe({ user: 'We deploy on Fridays now.', assistant: 'Noted.' });

// Put this block in your model's system prompt: it is escaped, so a memory cannot break out.
const memory = formatForPrompt(await oort.recall('how do we deploy?'));
console.log(memory);
```

- `createOort()` is async and makes no network request. `mode: 'auto'` (the default) uses what
  `oort setup` chose on this machine. Server code passes `mode`, `home` (local), `org`,
  `project`, `projectConfig: false` and `keySources` explicitly.
- `observe` runs the whole write path (scrub, gate, writer, reconcile) and can take seconds: call
  it after the answer is sent, and `await` it before a serverless function returns.
- A degraded recall is not an error: it returns what it found, with `degraded` and `warnings`.
- `await using` (or `close()`) closes the handle; a `scoped()` handle shares its root's engine.

Every method, option, result field and limit: [references/sdk.md](references/sdk.md).

## 3. Rules that are not optional

1. **Memory reaches a prompt only through `formatForPrompt`.** It escapes the block so a stored
   memory cannot close it or forge a label. Never concatenate `memory.text` into a prompt.
2. **Keys come from the environment or a secret manager**, never from source code, a committed
   config, a prompt or a log line. On a server pass `keySources: ['env']` (or `['explicit']` with
   `keys` read from your secret manager) so the process cannot fall back to a person's Keychain.
3. **Multi-user apps** keep one root handle per tenant (`org`, never `'local'`) in trusted host
   code and give the model only `oort.scoped({ user: userId })`. An end user gets a Planet, never
   a Star. A missing user id throws `user-missing`; do not catch it and fall back.
4. **Model-facing code runs in the agent judge role.** Use `judge: { role: 'expert' }` only on a
   code path where a person really decided.
5. **Handle errors by `OortError.code`**, retry only what is `retryable`, waiting `retryAfter`
   seconds when it is set.
6. **Do not send secrets to memory.** Oort scrubs every turn, but scrubbing is a safety net.

## 4. Load the reference you need

| Task                                                                                       | Read                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Modes (`local`, `cloud`, `auto`), every option and method, results, ids, limits, lifecycle | [references/sdk.md](references/sdk.md)                       |
| A multi-user or multi-tenant app: `scoped({ user })`, `org`, what is refused               | [references/multi-user.md](references/multi-user.md)         |
| Expert judgments: `judge.record`, `judge.apply`, `judge.confirm`, agent and expert roles   | [references/judgments.md](references/judgments.md)           |
| Errors: classes, `code`, `reason`, `fix`, `retryable`, `retryAfter`, a retry helper        | [references/errors.md](references/errors.md)                 |
| Vercel AI SDK (`oortmem/ai-sdk`), LangGraph.js, OpenAI Agents JS                           | [references/frameworks.md](references/frameworks.md)         |
| A long-running service, serverless (Lambda, Cloud Functions, Cloud Run), bundling          | [references/deployment.md](references/deployment.md)         |
| Which calls bill a model vendor, the Oort Pro relay or Oort Cloud                          | [references/costs.md](references/costs.md)                   |
| Python, shell scripts, CI: the CLI with `--json`, the `oort.v1` envelope, exit codes       | [references/cli-and-python.md](references/cli-and-python.md) |
| Keys, secret scrubbing, prompt injection, scopes and trust                                 | [references/security.md](references/security.md)             |

Every TypeScript block marked `<!-- example: … -->` in this skill is a file in
[examples/src](https://github.com/oortmem/oort/tree/main/examples/src), typechecked against the
real libraries and run in CI; a test fails when a block and its file differ.

## 5. Before you finish

- The handle is created once (module scope in serverless) and closed, or `await using` is used.
- Prompts get memory only from `formatForPrompt` (or `oortInstructions` with the AI SDK).
- No key literal is in the code; `keySources` is explicit in server code.
- In a multi-user app, every model-facing call uses a handle scoped to one user.
- `observe` is awaited where the runtime freezes after the response.
- Errors branch on `code`, not on `reason` or the message.
