# Oort from code: the TypeScript SDK

`oortmem` is the `oort` command line, and since 0.6.0 its root export is also a library:
`createOort()` gives your code the same memory the CLI, the hooks and the MCP server use. It
runs the engine in your process (`local`) or calls Oort Cloud over HTTPS (`cloud`), with the same
methods, results and errors either way.

ESM only, Node 22.15 or newer. `require('oortmem')` works too, through Node's `require(esm)`.
Python has its own native client since 0.7 ([docs/python.md](python.md)), which also reaches an
`oort serve --listen` service; a TypeScript `remote` mode is not shipped yet. The design is in
[docs/design/2026-11-06-sdk-design.md](design/2026-11-06-sdk-design.md).

```sh
npm i oortmem
```

Every TypeScript block on this page is a file in [`examples/`](../examples), typechecked against
the real libraries and run in CI (the framework ones with each framework's own fake model). A
test fails when a block here and its file differ by one byte. Every exported name and type is in
the generated [API reference](sdk-reference.md).

## Quick start

On a machine where `oort setup` has run (it chose local or cloud, and the keys):

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

Against Oort Cloud, with the Oort key from the environment (`OORT_API_KEY`):

<!-- example: examples/src/cloud-quick-start.ts -->

```ts
import { createOort } from 'oortmem';

// Oort Cloud, with the Oort key from the environment (OORT_API_KEY).
await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });

await oort.remember('The user lives in Lund.');
const { memories } = await oort.recall('where does the user live?');
console.log(memories.map((m) => m.text));
```

Put `formatForPrompt(result)` in your model's system prompt. It builds the `<oort-memory>` block
the hooks inject, and escapes it so a stored memory can neither close the block nor forge a
label. Inject memory into a prompt only through it.

## Options

`createOort(options?)` is async: local mode opens SQLite and reads key sources. It never makes a
network request, and never checks for updates (the once-a-day check belongs to the command line:
[Updating](cli.md#updating-oort-update)). Every option object is checked strictly: an unknown key, or an option the mode
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
| `user`          | `string`                                             | local, cloud                | unset: the person (`self`). Setting it requires `org`; in cloud mode a server key ([Per-user memory in Oort Cloud](#per-user-memory-in-oort-cloud)) |
| `org`           | `string`                                             | local, cloud                | `'local'`. Required, and not `'local'`, whenever `user` is set. Cloud mode: your name for the key's account, not sent |
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
| `forget(id, { everywhere? })`                  | `{ forgotten, withdrawn?, requested?, unreachable? }` | yes | yes (`everywhere`: cloud only) |
| `pin(id)` / `unpin(id)`                        | `{ id, pinned, changed }`                  | yes   | yes (`changed: null`)     |
| `recent({ since?, limit? })`                   | `{ memories, warnings }`                   | yes   | yes                       |
| `explain(id)`                                  | `Explanation`                              | yes   | yes                       |
| `whoami()`                                     | `Whoami` (mode, agent, project, user, reads, writesTo, routes) | yes | yes        |
| `judge.record(input)`                          | `RecordJudgmentView`                       | yes   | `refused`                 |
| `judge.apply(item, opts?)`                     | `JudgeResult`                              | yes   | `refused`                 |
| `judge.list({ domain?, by?, all?, limit? })`   | `{ judgments }`                            | yes   | `refused`                 |
| `judge.confirm(id)`                            | `{ id, changed }`                          | expert role only | `refused`      |
| `consolidate({ budgetMs?, signal? })`          | `ConsolidateResult`                        | yes   | `refused`                 |
| `scoped({ user?, project?, agent?, judgeRole? })` | a new handle                            | yes   | yes (`user`: a server key) |
| `endUsers.erase(user)`                         | `EndUserErasure` (`erased`, `memories`, `coldCopies`, `turnRefs`, `cursors`) | `cloud-only` | a server key |
| `endUsers.export(user)`                        | `EndUserExport` (`exported`, `memories`, `jsonl`) | `cloud-only` | a server key |
| `endUsers.count()`                             | `EndUserCount` (`endUsers`, `limit`)       | `cloud-only` | a server key        |
| `close()`, `[Symbol.asyncDispose]()`           | `void`                                     |       |                           |
| `formatForPrompt(result, { budgetChars? })`    | `string` (a function, not a method)        | both  | both                      |

**`recall` options.** `limit` (1 to 50, default 10), `mode` (`current`, `as-of`, `history`,
`known-at`), `asOf` (valid time), `knownAt` (transaction time), `include` (narrows the levels
read: `self`, `planet`, `star`, `constellation`, `galaxy`), `budgetChars` (the default block size
for `formatForPrompt`), `includeWithdrawn`, `speed` (`full`: embed and rerank; `fast`: no rerank;
`lexical`: no model call), `inferTime` (default true: "on 2 April" picks as-of, as the CLI does)
and `signal`.

**`forget` with `everywhere`** (Oort Cloud) does what `oort forget --everywhere` does: it forgets
the memory, then withdraws your copies in Constellations. The result lists Constellation ids:
`withdrawn` (you were the only contributor), `requested` (others contributed, so the maintainers
got a removal request and the copy stays) and `unreachable` (not reached; the copy stays, so call
it again later with the full id, which still finds the copies of a memory already forgotten).
Outside the hive beta it is refused (`refused`, reason `hive-not-enabled`) before anything is
forgotten; in local mode it is `cloud-only`.

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

### Large local stores (0.9.0 or newer)

Two settings in `config` (or the home config) change how a local recall reads a large store. Both
leave the results' shape and scores as they were.

<!-- example: examples/src/large-store.ts -->

```ts
import { createOort } from 'oortmem';

// A large local store (0.9.0 or newer). `vectorIndex: 'binary'` searches a 1-bit code per memory
// and rescores the best 10 × k with their int8 vectors; the default, `auto`, does so from 100,000
// memories on. `adaptiveStop: 'rule'` (the default) leaves archived matches out, unread, when the
// hot and warm memories already answer.
await using oort = await createOort({
  mode: 'local',
  config: {
    store: { vectorIndex: 'binary' },
    recall: { adaptiveStop: 'rule' },
  },
});

await oort.remember('The auth service listens on port 8080 in staging.');
const { memories } = await oort.recall('which port does the auth service use?');
console.log(memories.map((m) => m.text).join('\n'));
```

- **`store.vectorIndex`**: the dense index. `auto` scans the int8 vectors exactly until the store
  holds 100,000 searchable vectors (`store.binaryAutoThreshold`), then builds a binary index (a
  1-bit code per vector, 10 × k candidates rescored with their int8 vectors) when a handle that may
  migrate opens it, and keeps it. `binary` builds it on the next open, `int8` drops it. A memory
  the codes rank outside the candidates can be missed;
  [the design note](design/2026-11-11-binary-quantization.md#9-measurements) has the measured
  recall and memory.
- **`recall.adaptiveStop`**: whether a recall that finds cold (archived) matches beside hot and
  warm ones returns them, which reads each one back and makes it warm again. `rule` leaves them
  out when the top hot or warm memory holds every informative word of the query and no cold match
  comes close; `decide` asks the decision model instead on a `full` recall (one call per such
  recall, see the table below; `recall.sufficientAt`, default 0.7); `off` always returns them. See
  [the CLI's description](cli.md#large-stores-the-binary-vector-index-090-or-newer).

`store` set in a repository's `oort.config.json` is ignored: a home has one store.

## Judgments

The same judgment memory as `oort judge`: record an expert's decisions, then predict how they
would judge a new item from those precedents.

<!-- example: examples/src/judgments.ts -->

```ts
import { createOort } from 'oortmem';

// The expert role is for code paths where a person really decided: a review UI, an import job.
await using expert = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
  config: { judge: { experts: ['ada'] } },
});

await expert.judge.record({
  subject: 'Post claims a cure for diabetes',
  verdict: 'rejected',
  reason: 'A medical claim with no source.',
  domain: 'content',
  by: 'ada',
});

// Model-facing code runs in the agent role: it records only for listed experts, and what it
// records waits for a person to confirm it before it counts as a precedent.
const agent = expert.scoped({ judgeRole: 'agent' });
const draft = await agent.judge.record({
  subject: 'Post claims a miracle cure for colds',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: 'ada',
});
console.log(draft.status); // 'agent-recorded'
await expert.judge.confirm(draft.id);

const r = await agent.judge.apply({ summary: 'Post claims a miracle cure', domain: 'content' });
// 'suggested' | 'needs-expert' | 'precedents-only'. A prediction is never the expert's decision.
console.log(r.status, r.prediction?.verdict, r.precedents.length);
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

<!-- example: examples/src/multi-user.ts -->

```ts
import { createOort, formatForPrompt } from 'oortmem';

// One root handle per tenant (`org`), kept in trusted host code: it can reach every user.
const oort = await createOort({
  mode: 'local',
  home: process.env['OORT_HOME'] ?? '/data/oort',
  org: 'acme',
  project: null,
  projectConfig: false,
  keySources: ['env'],
});

// Per request: a handle fixed to one end user. Hand only this one to the model's tools.
const forUser = (userId: string) => oort.scoped({ user: userId, agent: 'support-bot' });

await forUser('user-ada').remember('My order number is 1042.');

const ada = await forUser('user-ada').recall('what is my order number?');
const bob = await forUser('user-bob').recall('what is my order number?');
console.log(formatForPrompt(ada)); // Ada's Planet holds her order number
console.log(bob.memories.length); // 0: each end user has a Planet of their own

// At the end of a user's session (or from a scheduled job): no model call.
await forUser('user-ada').consolidate({ budgetMs: 200 });
await oort.close();
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
- **An end user's id** is 1 to 128 characters: a letter or digit first, then letters, digits and
  `_ . : @ -`. It is never trimmed or normalized, and `self`, `anonymous`, `default`, `local`,
  `root` and `count` are reserved, in any case. Anything else is refused before any I/O:
  `user-missing` for `undefined`, `null` or `''`, `self-not-derivable` for `self`, else
  `bad-user`. Map your own ids to this (a hash works). Local mode and Oort Cloud use the same rule.
- **A user handle never switches users.** `scoped({ user })` on a handle already scoped to
  another end user is refused (`user-hop`); the same id, `agent`, `project` and `judgeRole` still
  derive. Make each end user's handle from the handle you made the first one from.
- **A dropped user id fails loudly.** When the `user` key is present, it must hold a user id:
  `scoped({ user: req.user?.id })` with no user (`undefined`, `null` or an empty string) throws
  `OortUsageError` (`user-missing`). Only an options object without a `user` key at all acts as
  the person, so a server bug can never fall back to the tenant's own Planet and the agent's Star.
- `include` only narrows: a Constellation or Galaxy in local mode is `cloud-only` (`hive-level`),
  any other level the scope lacks is `refused` (`scope-denied`).
- `agent` and `user` are configuration, not authentication. Every process running as the same OS
  user can open the same home as that person, exactly as the CLI and the hooks do.
- **Cloud mode** applies the Oort key's scope: one key is one account. `user` there needs a
  server key and an Oort Cloud with per-user memory: see
  [Per-user memory in Oort Cloud](#per-user-memory-in-oort-cloud). An agent configured as a Star
  cannot write in cloud mode (`star-in-cloud`).
- **Consolidation** runs per scope. The hooks consolidate only the person's own memories, so a
  multi-tenant host calls `mem.consolidate({ budgetMs: 200 })` at the end of a user's session, or
  from a scheduled job. It calls no model.
- The CLI acts as the person: memories written for a `user` are invisible to `oort recall`.

A separate `home` per tenant gives physical separation (files, backups, deletion) when a contract
needs it.

### Per-user memory in Oort Cloud

> **Requires a server key on Oort Pro** and `oortmem` 0.8.0 or newer. Without per-user memory,
> an end user's handle is refused with `end-users-unsupported` before anything is sent, and the
> account's end-user calls with `end-users-not-allowed` (a key that is not a server key) or
> `end-users-unsupported` (an Oort Cloud without per-user memory).

The same `scoped({ user })` works against Oort Cloud with a **server key**: an Oort key made on
[oortcloud.dev/account](https://oortcloud.dev/account) with "Acts for end users". Each end user
gets a Planet of their own inside your account; your own memory, Stars, Constellations and
Galaxies stay out of their reach.

<!-- example: examples/src/cloud-multi-user.ts -->

```ts
import { createOort, formatForPrompt } from 'oortmem';

// Oort Cloud with a server key ("Acts for end users", made on oortcloud.dev/account) in
// OORT_API_KEY. An Oort Cloud without per-user memory refuses end users (end-users-unsupported).
const oort = await createOort({
  mode: 'cloud',
  org: 'acme',
  project: null,
  projectConfig: false,
  keySources: ['env'],
});

// Per request: a handle fixed to one end user (it sends Oort-User). Hand only this one to tools.
// Take userId from your own signed-in session, never from the request: the key reads every end user.
const forUser = (userId: string) => oort.scoped({ user: userId, agent: 'support-bot' });

await forUser('user-ada').remember('My order number is 1042.');

console.log(formatForPrompt(await forUser('user-ada').recall('what is my order number?')));
console.log((await forUser('user-bob').recall('what is my order number?')).memories.length); // 0

// The account's end users: how many, and erasing one (a deletion request). Server code only.
const { endUsers, limit } = await oort.endUsers.count();
console.log(`${endUsers} of ${limit} end users`);
const erased = await oort.endUsers.erase('user-ada');
console.log(`erased ${erased.memories} memories`);
await oort.close();
```

- **The client-side rules are the local ones**: `user-missing`, `self-not-derivable`,
  `star-with-user`, and `user` needs an explicit `org` other than `local`. In cloud mode the key's
  account is the storage boundary, so `org` is your name for it and is never sent; requiring it
  still keeps a handle made for the account's own memory from deriving an end user by accident.
  The id rule and the one-user-per-handle rule are the ones above.
- **The header.** An end user's handle sends `Oort-User: <id>` on `observe`, `remember`,
  `recall`, `recent`, `explain`, `forget`, `pin` and `unpin`; `whoami` and `endUsers` act as the
  account and never send it. A handle without `user` never sends it.
- **Checked before the first one.** An Oort Cloud from before per-user memory ignores
  `Oort-User` and would write the end user's memories into your own Planet. So before the first
  request that names an end user, the SDK asks `whoami` once per root handle (its scoped handles
  share the answer) whether the key has the `end-users` capability, and refuses with
  `OortRefusedError` (`end-users-unsupported`) when it does not. Only a yes is kept: after a
  refusal the next call asks again, so an upgrade needs no restart.
- **A server key never acts as the account.** On a handle without `user` its memory calls are
  refused (`usage`, `user-missing`); keep a normal key for the account's own memory.
- **An end user's handle reads their Planet only**: `include` with `star`, `constellation` or
  `galaxy` is `refused` (`scope-denied`), and `forget(id, { everywhere: true })` is a usage error
  (`user-not-supported`).
- **`endUsers.erase(user)`** erases one end user (every memory, its indexes and cold
  copies) and returns counts; erasing one with nothing is not an error. An answer that does not
  say what was erased is no proof of it and throws `OortInternalError` (`internal`). A write for
  them still in flight is refused (`end-user-erased`) and is not retried. **`endUsers.count()`** returns how
  many end users the account has and its plan's `limit` (Pro includes 100; a new one past it is
  `end-user-limit`, and the ones there keep working). **`endUsers.export(user)`** returns every
  memory Oort holds for one end user as an export file
  ([An end user's data requests](#an-end-users-data-requests)). All three are cloud only
  (`cloud-only`, `end-users` in local mode, where an end user lives under your `org` in your own
  store) and refused on a handle scoped to an end user (`user-not-supported`). They ask no
  `whoami` first: Oort Cloud keeps erasure and export open while Pro has lapsed or the account is
  blocked (and the count while Pro has lapsed), when `whoami` itself is refused, so a deletion or
  access request can always be honoured.

### An end user's data requests

> **Requires a server key on Oort Pro** and `oortmem` 0.8.0 or newer.

When a person asks you what you hold about them, for a copy, to correct it or to delete it (GDPR
Articles 15 to 17 and 20), you answer from your server with the server key. Oort has no portal
of its own for end users: the request comes to you, and you decide who is asking.

<!-- example: examples/src/cloud-data-requests.ts -->

```ts
import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOort } from 'oortmem';

// Answering an end user's data requests (GDPR access, portability, rectification, erasure) from
// your server, with a server key in OORT_API_KEY. The person asks you; you answer with this.
const oort = await createOort({
  mode: 'cloud',
  org: 'acme',
  project: null,
  projectConfig: false,
  keySources: ['env'],
});
const ada = oort.scoped({ user: 'user-ada' });
await ada.remember('I live in Oslo.');

// Access and portability: every memory Oort holds for them, in every state, as one file in the
// Oort export format. Hand it over as it is; `oort import <file>` reads it into any Oort.
const copy = await oort.endUsers.export('user-ada');
const file = path.join(os.tmpdir(), 'user-ada-memories.jsonl');
await writeFile(file, copy.jsonl, { mode: 0o600 });
console.log(`exported ${copy.memories} memories`);

// Rectification: save the corrected fact as them. Oort ends the wrong one (kept as history with
// an end date, never rewritten), and recall answers with the correction.
const [wrong] = (await ada.recall('where do I live?')).memories;
await ada.remember('Correction: I live in Bergen, not Oslo.');
// A wrong fact Oort did not end, or one they want gone even as history: forgetting deletes it.
if (wrong !== undefined && (await ada.explain(wrong.id)).memory.status === 'current') {
  await ada.forget(wrong.id);
  console.log('forgot the wrong fact');
}

// Erasure: everything of theirs at once. Their export is then empty, as for an id you never had.
const erased = await oort.endUsers.erase('user-ada');
console.log(`erased ${erased.memories} memories`);
console.log(`left ${(await oort.endUsers.export('user-ada')).memories}`);
await oort.close();
```

- **Access and portability: `endUsers.export(user)`.** It returns `{ exported, memories, jsonl }`:
  `jsonl` is one file in the [export format](export-format.md) (version 1), a manifest line, then
  one memory per line, holding every memory of that end user in every state: current ones, ended
  and corrected ones with their dates, pinned ones and ones kept in cold storage. Nothing from
  other end users or from your own memory is in it: the SDK checks that every line's scope is
  that end user's and refuses the whole answer (`OortInternalError`) otherwise. It is JSON,
  readable as it is, and
  `oort import <file>` reads it into a self-hosted Oort (each memory moves to that machine's
  Planet and is embedded again there). Treat the file as the person's data: write it with
  restricted permissions, send it to them only, and do not keep copies.
- **An unknown or erased end user exports empty**: the manifest with `memories: 0`, the same for
  an id you never had as for one you erased, so the answer says nothing about whether the id
  existed. It is not an error.
- **Rectification: save the corrected fact as them.** `remember` on their handle with the
  correction ends the wrong fact: it stays as history with an end date (`expiredAt`, and
  `endReason: 'corrected'` in the export) and is never rewritten, and recall answers with the
  correction. When Oort did not link the two (`explain` still shows the old one as `current`), or
  when the person wants the wrong fact gone even as history, `forget(id)` deletes it; forgetting
  removes the memory itself, it does not give it an end date.
- **Erasure: `endUsers.erase(user)`**, above. Exporting them afterwards returns the empty file.
- **The account answers, never the end user's handle**: `export` and `erase` are refused on a
  scoped handle (`user-not-supported`), so give model tools the scoped handle only. Oort Cloud
  records that an export happened and how many memories it held, never the end user's id.

## Errors

Every error is an `OortError` subclass with `code` (the `oort.v1` code the CLI's `--json` uses),
`reason` (finer and stable), `fix` (a runnable `oort …` command, or `null`), `retryable`, for
cloud refusals `status`, and `retryAfter` (seconds) when the service sent `Retry-After`. A rate
limit (`rate-limit`) is retryable: wait `retryAfter` when it is set. Messages name fields, never values, and never carry a key. A vendor's
own error is reported by its class name only.

| Class                          | `code`               | Typical `reason`                                                                    |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `OortUsageError`               | `usage`              | `invalid-argument`, `principal-required`, `self-not-derivable`, `user-missing`, `bad-user`, `user-hop`, `user-not-supported`, `closed`, `embedder-mismatch` (fix `oort reembed`), `bad-request`, `too-large` |
| `OortNotFoundError`            | `not-found`          |                                                                                     |
| `OortAmbiguousIdError`         | `ambiguous-id`       |                                                                                     |
| `OortNeedsKeyError`            | `needs-key`          | `missing-key`, with `role` and `envVar` (fix `oort models pull` or `oort keys set <vendor>`) |
| `OortNeedsLoginError`          | `needs-login`        | `no-key`, `key-rejected` (fix `oort login`)                                         |
| `OortNeedsConfirmationError`   | `needs-confirmation` | `preview-required`, `findings-unacknowledged` (Oort Cloud 409)                      |
| `OortCloudOnlyError`           | `cloud-only`         | `hive-level`, `end-users` (`endUsers` locally), or `forget({ everywhere })` locally |
| `OortNetworkError`             | `network`            | `unreachable`, `timeout`, `busy` (retryable)                                        |
| `OortRefusedError`             | `refused`            | `scope-denied`, `star-in-cloud`, `star-with-user`, `local-only`, `experts-not-listed`, `not-an-expert`, `daily-limit`, `expert-only`, `payment-required`, `not-enabled`, `hive-not-enabled`, `end-users-unsupported`, `end-users-not-allowed` (not a server key), `end-user-limit`, `end-user-erased`, `forbidden` (another Oort Cloud refusal), `not-current` (`judge.confirm` on a judgment that is no longer current), `cap-unavailable` (the daily judgment count could not be kept; retryable), `rate-limit` (retryable), `migration-required` (fix `oort doctor`) |
| `OortInternalError`            | `internal`           | `store-busy` (retryable), else none                                                 |

Retry what is `retryable`, then branch on `code`:

<!-- example: examples/src/errors.ts -->

```ts
import { createOort, OortError } from 'oortmem';

/** Retries what Oort marks `retryable`, waiting `retryAfter` seconds when the service sent it. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof OortError) || !e.retryable || attempt >= tries) throw e;
      await new Promise((done) => setTimeout(done, (e.retryAfter ?? attempt) * 1000));
    }
  }
}

try {
  await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });
  const r = await withRetry(() =>
    oort.observe({ user: 'Our staging database runs on port 6543.', assistant: 'Noted.' }),
  );
  console.log('saved:', r.outcome);
} catch (e) {
  if (!(e instanceof OortError)) throw e;
  // Branch on `code` first: new `reason` strings may appear in any release.
  switch (e.code) {
    case 'needs-login':
      console.error(`No usable Oort key (${e.reason}). Fix: ${e.fix}`);
      break;
    case 'refused':
      console.error(`Refused (${e.reason}): ${e.message}`);
      break;
    case 'network':
      console.error(`Oort Cloud is unreachable (${e.reason}); try again later.`);
      break;
    default:
      throw e;
  }
}
```

New `reason` strings may appear in any release; branch on `code` first.

## Which calls cost usage

No model is called at construction, by `whoami`, or by any read of stored records. "Vendor"
means your own key (billed by that vendor) or the Oort key through the Oort Pro relay (metered on
your Oort account); `whoami().routes` says which applies to each role.

| Call | Local, own keys or Oort Pro relay | Local models | Cloud mode |
| --- | --- | --- | --- |
| `recall` | A Voyage embed (skipped on a cache hit or a confident keyword answer) and a Voyage rerank (skipped when confident, or with `speed: 'fast'`). With `recall.adaptiveStop: 'decide'` (0.9.0 or newer), a TypeSafe call when a `full` recall finds cold matches beside hot and warm ones. `speed: 'lexical'`: no model call | none (`decide` still needs a key) | Metered Oort Cloud recall |
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

<!-- example: examples/src/serverless.ts -->

```ts
import { createOort, formatForPrompt } from 'oortmem';

// Module scope: warm invocations reuse the handle and its connection. Cloud mode writes nothing
// to disk and loads no native module.
const oort = await createOort({
  mode: 'cloud',
  keySources: ['explicit', 'env'],
  project: 'support-site',
  projectConfig: false,
});

export async function handler(event: { question: string; requestId: string }): Promise<string> {
  const memory = formatForPrompt(await oort.recall(event.question, { speed: 'fast' }));
  const answer = await answerWith(memory, event.question);
  // Await before returning: the runtime freezes after the response. `turnRef` makes a retried
  // invocation save the turn once.
  await oort.observe({ user: event.question, assistant: answer, turnRef: event.requestId });
  return answer;
}

// A one-shot job (a cron function, a queue consumer) closes its own handle when it ends.
export async function importFacts(facts: string[]): Promise<number> {
  await using job = await createOort({
    mode: 'cloud',
    keySources: ['explicit', 'env'],
    project: 'support-site',
    projectConfig: false,
  });
  const { results } = await job.remember(facts);
  return results.length;
}

/** Your model call goes here. */
async function answerWith(memory: string, question: string): Promise<string> {
  return `(an answer to "${question}", written with ${memory.length} characters of memory)`;
}
```

## Frameworks

### Vercel AI SDK: `oortmem/ai-sdk` (`@experimental`)

Tested with `ai` 7.0.162; the test resolves the model string through the AI SDK's global
provider to its `MockLanguageModelV4` (`ai/test`).

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

The tools always run in the agent role, return memory only as a `formatForPrompt` block, and
never offer `includeAgentRecorded` or `includeImported`: a model cannot widen what counts as
precedent. A refusal comes back to the model as `{ error: { code, message } }`. The adapter does
not import `ai` itself; `ai` 7 is an optional peer dependency.

With `oortmem` 0.6.0, write `tools: { ...oortTools(oort) }`: its `OortToolSet` was an interface,
which TypeScript does not assign to the AI SDK's `ToolSet`. Later releases accept
`oortTools(oort)` as it is.

### LangGraph.js (example, not a shipped adapter)

Tested with `@langchain/langgraph` 1.7.0 and `@langchain/core` 1.3.4; the test swaps
`ChatAnthropic` for LangChain's own `FakeListChatModel`.

`OortStore` is a LangGraph `BaseStore` over a scoped handle, passed with `compile({ store })`:
`search` with a query is `recall`, `put` of `{ text }` is `remember`, `delete` is `forget` and
`get` is `explain`. Oort assigns memory ids, so a put's key is not kept, and `get` and `delete`
take Oort ids. Your own `scopeOf` decides which namespace is which end user. Accept one shape and refuse the rest, as `userScope` does with `[userId]`: taking the first label of LangMem's `['memories', userId]` would put every user in one Planet. A node prompts with
`formatForPrompt` on that user's handle, never with raw store values, and observes the turn.

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
      if (Object.keys(op.filter ?? {}).length > 0 || (op.offset ?? 0) > 0) {
        throw new Error('OortStore searches by relevance only: no filter or offset');
      }
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
/**
 * This app's namespaces are `[userId]`, exactly: that end user's Planet. Any other shape is
 * refused, never guessed: reading the first label of LangMem's `['memories', userId]` would put
 * every user in one Planet.
 */
export function userScope(namespace: string[]): ScopedOptions {
  const [user] = namespace;
  if (namespace.length !== 1 || typeof user !== 'string' || user === '') {
    throw new TypeError(`OortStore namespaces here are [userId], not ${JSON.stringify(namespace)}`);
  }
  return { user };
}

const store = new OortStore(oort, userScope);
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

### OpenAI Agents JS (example, not a shipped adapter)

Tested with `@openai/agents` 0.21.0; the test answers with the SDK's own `ScriptedModel`
(`@openai/agents/testing`) as the default model provider, with tracing off.

`oortSession` wraps any `Session` (here the SDK's `MemorySession`): storage stays where it is,
and each user and assistant pair is observed. Recall goes through dynamic `instructions`, never
by rewriting history.

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
