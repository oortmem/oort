# Oort from code: the TypeScript SDK

`oortmem` is the `oort` command line, and since 0.6.0 its root export is also a library:
`createOort()` gives your code the same memory the CLI, the hooks and the MCP server use. It
runs the engine in your process (`local`) or calls Oort Cloud over HTTPS (`cloud`), with the same
methods, results and errors either way.

ESM only, Node 22.15 or newer. `require('oortmem')` works too, through Node's `require(esm)`.
Python (0.7) and a `remote` mode against `oort serve` (0.7) come later; the design is in
[docs/design/2026-11-06-sdk-design.md](design/2026-11-06-sdk-design.md).

```sh
npm i oortmem
```

## Quick start

On a machine where `oort setup` has run (it chose local or cloud, and the keys):

```ts
import { createOort, formatForPrompt } from 'oortmem';

const oort = await createOort();
const memory = formatForPrompt(await oort.recall('how do we deploy?'));
await oort.observe({ user: 'We deploy on Fridays now.', assistant: 'Noted.' });
await oort.close();
```

Against Oort Cloud, with the Oort key from the environment (`OORT_API_KEY`):

```ts
import { createOort } from 'oortmem';

const oort = await createOort({ mode: 'cloud', keySources: ['env'] });
const { memories } = await oort.recall('where does the user live?');
await oort.remember('The user lives in Lund.');
```

Put `formatForPrompt(result)` in your model's system prompt. It builds the `<oort-memory>` block
the hooks inject, and escapes it so a stored memory can neither close the block nor forge a
label. Inject memory into a prompt only through it.

## Options

`createOort(options?)` is async: local mode opens SQLite and reads key sources. It never makes a
network request. Every option object is checked strictly: an unknown key, or an option the mode
does not take (`keys.voyage` with `mode: 'cloud'`), throws `OortUsageError`. It is never silently
ignored.

| Option          | Type                                                 | Modes                       | Default                                                                                              |
| --------------- | ---------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mode`          | `'auto' \| 'local' \| 'cloud'`                       | all                         | `'auto'`: the store `oort setup` chose (`$OORT_HOME/cloud.json`), else `local`                       |
| `home`          | `string`                                             | local, auto                 | `OORT_HOME`, else `~/.oort`                                                                          |
| `cwd`           | `string`                                             | all                         | `process.cwd()`; used only to find the project and its config                                        |
| `project`       | `string \| null`                                     | all                         | derived from `cwd` as the CLI does. A string becomes `cfg:<id>` (as `oort project link`); `null` means global memories only |
| `projectConfig` | `boolean`                                            | local, cloud                | `true`. `false` skips the repository's `oort.config.json` (a server whose cwd is a checkout)         |
| `agent`         | `string`                                             | all                         | `OORT_AGENT`, else anonymous (the Planet only)                                                       |
| `user`          | `string`                                             | local                       | unset: the person (`self`). Setting it requires `org`                                                |
| `org`           | `string`                                             | local                       | `'local'`. Required, and not `'local'`, whenever `user` is set                                       |
| `keys`          | `{ voyage?, typesafe?, anthropic?, oort? }`          | local; cloud (`oort` only)  | none                                                                                                 |
| `keySources`    | `('explicit' \| 'env' \| 'keychain')[]`              | all                         | all three; `keychain` is skipped with `OORT_NO_KEYCHAIN=1`                                           |
| `config`        | a deep partial of the home config                    | local                       | none. Laid over the resolved config; `serve` cannot be set                                           |
| `url`           | `string`                                             | cloud                       | `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`                                                   |
| `timeoutMs`     | `number`                                             | cloud                       | 30 000 per request                                                                                   |
| `migrate`       | `boolean`                                            | local                       | `true`, as every CLI command. `false` refuses an older store (`refused`, `migration-required`)       |
| `env`           | `Record<string, string \| undefined>`                | all                         | `process.env`                                                                                        |
| `fetch`         | `typeof fetch`                                       | cloud                       | a keep-alive connection pool                                                                         |
| `judge`         | `{ role: 'agent' \| 'expert'; operator?: string }`   | local                       | `{ role: 'agent' }` (see [Judgments](#judgments))                                                    |

**Keys.** Each model role (embed, rerank, decide, write) uses the first key found: `keys.<vendor>`,
then `VOYAGE_API_KEY`, `TYPESAFE_API_KEY` or `ANTHROPIC_API_KEY`, then the Keychain (or
`credentials.json` where there is no Keychain), then the Oort key through the Oort Pro relay
(metered). With none, recall degrades to keyword search (warning `lexical-only`) and a write
throws `OortNeedsKeyError`. A local model (`oort models pull`, or `config: { embed: { provider:
'local' } }`) is a config choice, never a fallback. Cloud mode needs only the Oort key; without
one it throws `OortNeedsLoginError`.

Passing `keys` with a `keySources` that leaves out `'explicit'` is a usage error, never a silent
fallback to another source. The Keychain items (`oort.voyage`, `oort.oort`, …) belong to the macOS user, not to an Oort
home: `home` changes where memories live, never which Keychain is read. A server, or any process
that should not use the person's keys, sets `keySources` explicitly (`['env']`, or `['explicit']`).
Keys given in code stay in memory. They are kept out of every enumerable field, so
`console.log(oort)`, `JSON.stringify(oort)` and `util.inspect(oort)` print only
`Oort {"mode":…,"scope":…}`, and an error never carries one.

## Methods

| Method                                         | Returns                                    | Local | Cloud                     |
| ---------------------------------------------- | ------------------------------------------ | ----- | ------------------------- |
| `recall(query, opts?)`                         | `RecallResult`                             | yes   | yes                       |
| `observe(turn, { signal? })`                   | `ObserveResult`                            | yes   | yes                       |
| `remember(facts, { type? })`                   | `RememberResult`                           | yes   | yes                       |
| `forget(id, { everywhere? })`                  | `{ forgotten, withdrawn? }`                | yes   | yes (`everywhere`: cloud only) |
| `pin(id)` / `unpin(id)`                        | `{ id, pinned, changed }`                  | yes   | yes (`changed: null`)     |
| `recent({ since?, limit? })`                   | `{ memories, warnings }`                   | yes   | yes                       |
| `explain(id)`                                  | `Explanation`                              | yes   | yes                       |
| `whoami()`                                     | `Whoami` (mode, agent, project, user, reads, writesTo, routes) | yes | yes        |
| `judge.record(input)`                          | `RecordJudgmentView`                       | yes   | `refused`                 |
| `judge.apply(item, opts?)`                     | `JudgeResult`                              | yes   | `refused`                 |
| `judge.list({ domain?, by?, all?, limit? })`   | `{ judgments }`                            | yes   | `refused`                 |
| `judge.confirm(id)`                            | `{ id, changed }`                          | expert role only | `refused`      |
| `consolidate({ budgetMs?, signal? })`          | `ConsolidateResult`                        | yes   | `refused`                 |
| `scoped({ user?, project?, agent?, judgeRole? })` | a new handle                            | yes   | `project`, `agent` only   |
| `close()`, `[Symbol.asyncDispose]()`           | `void`                                     |       |                           |
| `formatForPrompt(result, { budgetChars? })`    | `string` (a function, not a method)        | both  | both                      |

**`recall` options.** `limit` (1 to 50, default 10), `mode` (`current`, `as-of`, `history`,
`known-at`), `asOf` (valid time), `knownAt` (transaction time), `include` (narrows the levels
read: `self`, `planet`, `star`, `constellation`, `galaxy`), `budgetChars` (the default block size
for `formatForPrompt`), `includeWithdrawn`, `speed` (`full`: embed and rerank; `fast`: no rerank;
`lexical`: no model call), `inferTime` (default true: "on 2 April" picks as-of, as the CLI does)
and `signal`.

The time rules match the MCP server's: `as-of` needs `asOf`, `known-at` needs `knownAt`,
`current` and `history` take neither, `asOf` together with `knownAt` is a usage error, a single
date without `mode` picks its view, and with neither `inferTime` decides.

**Results.** Every memory comes back as a `MemoryView`: `id`, `text` (scrubbed of secrets again
on the way out), `type`, `tier`, `pinned`, `status` (`current`, `superseded`, `corrected`,
`expired`, `not-yet-valid` or `withdrawn`), `validFrom`, `validTo`, `recordedAt`, `updatedAt`,
`entities`, `origin` and, for a judgment, `judgment`. Recalled memories add `score` (comparable
within one result only), `stale` and `why` (`@experimental`). A degraded recall is not an error:
it returns what it found and fills `degraded` and `warnings` (`lexical-only`, `recall-degraded`,
`time-mode-unreported`). Ignore result fields you do not know: new ones may appear in any release.

**Ids.** A full id, or a unique prefix of at least 8 characters. Several matches throw
`OortAmbiguousIdError`. An id outside the handle's scope is `OortNotFoundError`, exactly like an
unknown one.

**`observe` and `remember`.** `observe` runs the full write path (scrub, gate, writer,
reconcile) and can take seconds: call it after answering, or await it before a serverless
function returns. `remember` frames each fact as the user's statement, as the MCP tool does.
`turnRef` is deduplicated by Oort Cloud only (it answers `duplicate: true`); locally a retry may
write twice.

**Abort.** An aborted `signal` stops the SDK waiting and rejects with the signal's reason. Work
already sent (cloud) or started (local) may still land; in cloud mode, retry with the same
`turnRef`.

**Lifecycle.** One handle is safe for concurrent calls. `close()` is idempotent; afterwards every
call throws `OortUsageError` (`closed`). A handle from `scoped()` shares its root's engine:
closing it does nothing, and closing the root closes everything. `await using oort = await
createOort()` closes it for you.

### Limits

| Input              | Limit                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `recall` query     | 2,048 UTF-8 bytes                                                     |
| `recall` `limit`   | 1 to 50                                                               |
| `observe` turn     | 128 KiB in all (the engine keeps 32 KiB of text after scrubbing)      |
| `tools` summaries  | truncated to 16 × 512 bytes, never refused                            |
| `turnRef`          | 128 characters                                                        |
| `remember`         | 5 facts of at most 500 characters                                     |
| Judgment fields    | as `oort judge record` (subject 500, reason 2,000, …)                 |
| `recent` `limit`   | 1 to 100                                                              |

Anything over a limit throws `OortUsageError` before any I/O. The error names the field, never
its value.

## Judgments

The same judgment memory as `oort judge`: record an expert's decisions, then predict how they
would judge a new item from those precedents.

```ts
const oort = await createOort({ config: { judge: { experts: ['ada'] } } });
await oort.judge.record({ subject: 'Post claims a cure', verdict: 'rejected', reason: 'No source.', domain: 'content', by: 'ada' });
const r = await oort.judge.apply({ summary: 'Post claims a miracle cure', domain: 'content' });
// r.status: 'suggested' | 'needs-expert' | 'precedents-only'; r.prediction is never the expert's decision
```

**Your code is an agent by default** (`judge.role: 'agent'`), because the rule protects the
expert's record from the model, not from you:

- It may record only for experts listed in `judge.experts` (the home config, or the `config`
  option). With none listed: `refused`, `experts-not-listed`; another name: `not-an-expert`.
- At most 50 a day per Oort home, shared with the MCP server's `record_judgment` (the same
  counter file, so 0.5.x counts too): `refused`, `daily-limit`.
- What it records is stored exactly as an MCP agent's: `via: 'mcp'`, `source.harness: 'sdk'`.
  Every reader, 0.5.x included, treats it as agent-recorded and unconfirmed, so `judge.apply`
  leaves it out until a person confirms it, and it never corrects a person's judgment.
- `judge.confirm` is refused (`expert-only`).

**Expert role** is one explicit option, for code paths where a person really decided (a review
UI, an import job): `createOort({ judge: { role: 'expert', operator: 'marcus' } })`. It records
anyone's judgments as `via: 'sdk'`, which counts as a person's, and may `confirm` an agent's
record. `scoped({ judgeRole: 'agent' })` narrows a handle back to the agent role; nothing widens
it. Framework tools always run in the agent role.

## Scopes and multi-tenant use

A handle's scope is fixed when it is made: no method takes a scope argument. `scoped()` derives
a cheap handle from trusted host code; hand only that handle to the model's tools.

```ts
const oort = await createOort({
  mode: 'local', home: '/data/oort', org: tenantId, project: null, projectConfig: false, keySources: ['env'],
});
const mem = oort.scoped({ user: req.user.id, agent: 'support-bot' });
```

- **A handle is the whole org.** `scoped()` moves sideways as well as down: from any handle it
  derives any user, project or agent in the same org (only the judge role is one-way). So the
  root handle, and an anonymous one, are as powerful as the org itself: keep them in trusted host
  code and never hand them to untrusted code or a model. Give a model only a handle already
  scoped to one user, through tools that do not expose `scoped` (the `oortmem/ai-sdk` tools
  never do).
- **`org`** is your tenant: the storage and deletion boundary. **`user`** gives each end user
  their own Planet. The agent is still recorded as the author.
- **An end user gets their Planet only, never a Star.** Today an agent's Star is kept per org and
  agent, not per user, so it would leak between users. `include: ['star']` on a user handle is
  `refused`, and an agent configured as a Star together with `user` is refused (`star-with-user`).
  Per-user agent memory comes with CON-92.
- **`user` needs an explicit `org` other than `local`**, and `scoped({ user: 'self' })` is refused
  (`self-not-derivable`).
- **A dropped user id fails loudly.** When the `user` key is present, it must hold a user id:
  `scoped({ user: req.user?.id })` with no user (`undefined`, `null` or an empty string) throws
  `OortUsageError` (`user-missing`). Only an options object without a `user` key at all acts as
  the person, so a server bug can never fall back to the tenant's own Planet and the agent's Star.
- `include` only narrows: a Constellation or Galaxy in local mode is `cloud-only` (`hive-level`),
  any other level the scope lacks is `refused` (`scope-denied`).
- `agent` and `user` are configuration, not authentication. Every process running as the same OS
  user can open the same home as that person, exactly as the CLI and the hooks do.
- **Cloud mode** applies the Oort key's scope: one key is one account, so `user` is a usage error
  there until CON-92. An agent configured as a Star cannot write in cloud mode (`star-in-cloud`).
- **Consolidation** runs per scope. The hooks consolidate only the person's own memories, so a
  multi-tenant host calls `mem.consolidate({ budgetMs: 200 })` at the end of a user's session, or
  from a scheduled job. It calls no model.
- The CLI acts as the person: memories written for a `user` are invisible to `oort recall`.

A separate `home` per tenant gives physical separation (files, backups, deletion) when a contract
needs it.

## Errors

Every error is an `OortError` subclass with `code` (the `oort.v1` code the CLI's `--json` uses),
`reason` (finer and stable), `fix` (a runnable `oort …` command, or `null`), `retryable` and, for
cloud refusals, `status`. Messages name fields, never values, and never carry a key. A vendor's
own error is reported by its class name only.

| Class                          | `code`               | Typical `reason`                                                                    |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `OortUsageError`               | `usage`              | `invalid-argument`, `principal-required`, `self-not-derivable`, `user-missing`, `closed`, `embedder-mismatch` (fix `oort reembed`), `bad-request`, `too-large` |
| `OortNotFoundError`            | `not-found`          |                                                                                     |
| `OortAmbiguousIdError`         | `ambiguous-id`       |                                                                                     |
| `OortNeedsKeyError`            | `needs-key`          | `missing-key`, with `role` and `envVar` (fix `oort models pull` or `oort keys set <vendor>`) |
| `OortNeedsLoginError`          | `needs-login`        | `no-key`, `key-rejected` (fix `oort login`)                                         |
| `OortNeedsConfirmationError`   | `needs-confirmation` | `preview-required`, `findings-unacknowledged` (Oort Cloud 409)                      |
| `OortCloudOnlyError`           | `cloud-only`         | `hive-level`, or `forget({ everywhere })` locally                                   |
| `OortNetworkError`             | `network`            | `unreachable`, `timeout`, `busy` (retryable)                                        |
| `OortRefusedError`             | `refused`            | `scope-denied`, `star-in-cloud`, `star-with-user`, `local-only`, `experts-not-listed`, `not-an-expert`, `daily-limit`, `expert-only`, `payment-required`, `not-enabled`, `hive-not-enabled`, `rate-limit`, `migration-required` (fix `oort doctor`) |
| `OortInternalError`            | `internal`           | `store-busy` (retryable), else none                                                 |

```ts
import { OortError, OortRefusedError } from 'oortmem';
try {
  await mem.observe(turn);
} catch (e) {
  if (e instanceof OortRefusedError && e.reason === 'rate-limit') backOff();
  else if (e instanceof OortError && e.retryable) retry();
  else throw e;
}
```

New `reason` strings may appear in any release; branch on `code` first.

## Which calls cost usage

No model is called at construction, by `whoami`, or by any read of stored records. "Vendor"
means your own key (billed by that vendor) or the Oort key through the Oort Pro relay (metered on
your Oort account); `whoami().routes` says which applies to each role.

| Call | Local, own keys or Oort Pro relay | Local models | Cloud mode |
| --- | --- | --- | --- |
| `recall` | A Voyage embed (skipped on a cache hit or a confident keyword answer) and a Voyage rerank (skipped when confident, or with `speed: 'fast'`). `speed: 'lexical'`: no model call | none | Metered Oort Cloud recall |
| `observe` | A TypeSafe gate, always. If kept: one Anthropic writer call, one batched Voyage embed, and a TypeSafe reconcile per fact | Gate, writer and reconcile still need keys | Metered Oort Cloud observe |
| `remember` | One observe per fact | as above | One metered observe per fact |
| `judge.record` | One Voyage embed | none | `refused` |
| `judge.apply` | One Voyage embed and one TypeSafe judge call | TypeSafe judge only | `refused` |
| `forget`, `pin`, `unpin`, `explain`, `recent`, `judge.list`, `judge.confirm`, `consolidate`, `whoami` | none | none | No model call |

`keySources: ['explicit']` turns off every implicit source, the relay included unless you pass
`keys.oort`.

## In a service, and in serverless

**A long-running service** (ECS, GKE, EKS) embeds the SDK in local mode with the store on a block
volume: one replica per store, because SQLite needs one host. Pass everything explicitly:
`mode`, `home`, `org`, `project` (or `null`), `projectConfig: false` and `keySources: ['env']`,
with keys from your secret manager. Never put the store on a network filesystem (EFS, NFS, GCS
FUSE).

**Serverless** (Lambda, Cloud Functions, Cloud Run) uses cloud mode:

- **No disk writes, no native module.** `mode: 'cloud'` reads `OORT_HOME` only if files exist
  there, and never creates the directory, a store, a log or a cache. `@oortmem/store-sqlite` (and
  with it `better-sqlite3`) is imported only by local mode, so mark `@oortmem/store-sqlite`,
  `better-sqlite3` and `sqlite-vec` as external when you bundle: the native build never has to
  match the Lambda architecture.
- **Keys** from the environment: `keySources: ['explicit', 'env']`, or `OORT_NO_KEYCHAIN=1`.
  There is no Keychain in Lambda.
- **A checkout as the working directory** (a monorepo deploy): pass `projectConfig: false` so the
  handle skips the repository's `oort.config.json` (and a broken one cannot stop it starting).
- **Create the handle at module scope**, so warm invocations reuse its connection. The pool's
  sockets do not keep the process alive, so a function that never calls `close()` still ends.
- **Await `observe` before returning**: the runtime freezes after the response.

```ts
const oort = await createOort({ mode: 'cloud', keySources: ['env'], project: 'support-site' });

export const handler = async (event) => {
  const memory = formatForPrompt(await oort.recall(event.question, { speed: 'fast' }));
  const answer = await answerWith(memory, event.question);
  await oort.observe({ user: event.question, assistant: answer, turnRef: event.requestId });
  return answer;
};
```

## Frameworks

### Vercel AI SDK: `oortmem/ai-sdk` (`@experimental`)

```ts
import { generateText, isStepCount } from 'ai';
import { createOort } from 'oortmem';
import { oortInstructions, oortObserve, oortTools } from 'oortmem/ai-sdk';

const oort = await createOort();
const prompt = 'When do we deploy billing?';
const { text } = await generateText({
  model,
  instructions: await oortInstructions(oort, prompt), // `system` before AI SDK 7
  tools: oortTools(oort), // recall, remember, forget; { judge: true } adds judge and record_judgment
  stopWhen: isStepCount(5),
  prompt,
  onEnd: oortObserve(oort, prompt), // `onFinish` before AI SDK 7
});
```

The tools always run in the agent role, return memory only as a `formatForPrompt` block, and
never offer `includeAgentRecorded` or `includeImported`: a model cannot widen what counts as
precedent. A refusal comes back to the model as `{ error: { code, message } }`. The adapter does
not import `ai` itself; `ai` 7 is an optional peer dependency.

### LangGraph.js (example, not a shipped adapter)

A `BaseStore` that maps LangGraph's store calls onto a scoped handle. Your own
`namespaceToScope` decides which namespace is which user and project.

```ts
import { BaseStore, type Item, type Operation, type SearchItem } from '@langchain/langgraph';
import { createOort, formatForPrompt, type Oort } from 'oortmem';

class OortStore extends BaseStore {
  constructor(
    private oort: Oort,
    private namespaceToScope: (ns: string[]) => { user?: string; project?: string | null },
  ) {
    super();
  }
  private h(ns: string[]) {
    return this.oort.scoped({ ...this.namespaceToScope(ns), judgeRole: 'agent' });
  }
  async batch<Op extends Operation[]>(ops: Op): Promise<unknown[]> {
    return Promise.all(
      ops.map(async (op) => {
        if ('query' in op && 'namespacePrefix' in op) {
          const r = await this.h(op.namespacePrefix).recall(op.query ?? '', { limit: op.limit ?? 10 });
          return r.memories.map(
            (m): SearchItem => ({ namespace: op.namespacePrefix, key: m.id, value: { text: m.text }, score: m.score, createdAt: new Date(m.recordedAt), updatedAt: new Date(m.updatedAt) }),
          );
        }
        if ('value' in op) {
          if (op.value === null) return void (await this.h(op.namespace).forget(op.key));
          return void (await this.h(op.namespace).remember(String(op.value['text'])));
        }
        if ('key' in op) {
          const m = (await this.h(op.namespace).explain(op.key).catch(() => null))?.memory;
          return m === undefined ? null : ({ namespace: op.namespace, key: m.id, value: { text: m.text }, createdAt: new Date(m.recordedAt), updatedAt: new Date(m.updatedAt) } satisfies Item);
        }
        return [];
      }),
    );
  }
}

const graph = workflow.compile({ store: new OortStore(await createOort(), ([user]) => ({ user, project: null })) });
// In a node: const block = formatForPrompt(await oort.scoped({ user }).recall(question));
```

### OpenAI Agents JS (example, not a shipped adapter)

Wrap any `Session` so storage stays where it is, and each user and assistant pair is observed.
Recall goes through dynamic `instructions`, never by rewriting history.

```ts
import { Agent, run, type Session, type AgentInputItem } from '@openai/agents';
import { createOort, formatForPrompt, type Oort } from 'oortmem';

function oortSession(inner: Session, oort: Oort): Session {
  const textOf = (i: AgentInputItem): string =>
    'content' in i && typeof i.content === 'string'
      ? i.content
      : 'content' in i && Array.isArray(i.content)
        ? i.content.map((c) => ('text' in c ? c.text : '')).join('')
        : '';
  let pending: string | undefined;
  return {
    getSessionId: () => inner.getSessionId(),
    getItems: (limit) => inner.getItems(limit),
    popItem: () => inner.popItem(),
    clearSession: () => inner.clearSession(),
    async addItems(items) {
      await inner.addItems(items);
      for (const i of items) {
        if ('role' in i && i.role === 'user') pending = textOf(i);
        else if ('role' in i && i.role === 'assistant' && pending !== undefined) {
          await oort.observe({ user: pending, assistant: textOf(i) });
          pending = undefined;
        }
      }
    },
  };
}

const oort = (await createOort()).scoped({ agent: 'support-bot', judgeRole: 'agent' });
const agent = new Agent({
  name: 'support',
  instructions: async (ctx) => `You help customers.\n${formatForPrompt(await oort.recall(String(ctx.context.question)))}`,
});
await run(agent, question, { session: oortSession(mySession, oort), context: { question } });
```

Any MCP-capable framework can also use `oort mcp` with no code at all.

## Reserved names: spatial memory

`place` (on turns, `remember` and memory views) and `near` and `within` (on recall) are reserved
for spatial memory (CON-84). No other field will use those names. Until then, passing any of
them is a usage error, never a silent drop: a robot must not believe it stored a location.

## Stability

Before 1.0, a breaking change to anything not marked `@experimental` lands only in a minor release
(0.6 to 0.7), listed under "Breaking" in the release notes. A patch release only adds or fixes.
`@experimental`, and free to change in any minor: `oortmem/ai-sdk`, `RecalledMemory.why` and
`JudgeResult.decisions`. New optional options, result fields, `reason` and warning strings, and
higher limits are additive and can arrive in any release. `@oortmem/core` carries no stability
promise: apps should use `oortmem`.

## Migrating to 0.6.0

- **The CLI's `--json` output is now the `oort.v1` envelope** (`{ schema, command, ok, data,
  warnings }`). Scripts that parsed the old arrays and objects read `data` instead.
- **`oortmem` gains a root export.** `import 'oortmem'` used to resolve to nothing useful; it now
  returns the SDK. The `oort` and `oortmem` bins are unchanged.
- **The new `exports` map blocks deep imports** such as `oortmem/dist/wire.js`. Those paths were
  never documented. Use the root export (`oortmem`), `oortmem/ai-sdk`, or `@oortmem/core` for
  engine pieces.
- **Judgments.** SDK agent records are stored as `via: 'mcp'` with `source.harness: 'sdk'`;
  expert-role SDK records use `via: 'sdk'`. No other new `via` value appears.
