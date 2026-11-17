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
| `judge`         | `{ role: 'agent' \| 'expert'; operator?: string }`   | local; cloud (`role: 'agent'` only) | `{ role: 'agent' }` (see [Judgments](#judgments))                                                    |

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
| `remember(facts, { type?, place? })`           | `RememberResult`                           | yes   | yes (`place` after 0.10.0) |
| `forget(id, { everywhere? })`                  | `{ forgotten, rewritten?, notRewritten?, withdrawn?, requested?, unreachable? }` | yes | yes (`everywhere`: cloud only) |
| `pin(id)` / `unpin(id)`                        | `{ id, pinned, changed }`                  | yes   | yes (`changed: null`)     |
| `recent({ since?, limit? })`                   | `{ memories, warnings }`                   | yes   | yes                       |
| `explain(id)`                                  | `Explanation` (with `links` and `hiddenLinks`) | yes | yes (`links` is empty)   |
| `link(from, to)` / `unlink(from, to)`          | `{ linked, unblocked, assertedBy }` / `{ removed, blocked }` | yes | `refused` (`local-only`) |
| `whoami()`                                     | `Whoami` (mode, agent, project, user, reads, writesTo, routes) | yes | yes        |
| `judge.record(input)`                          | `RecordJudgmentView`                       | yes   | yes (agent role)          |
| `judge.apply(item, opts?)`                     | `JudgeResult`                              | yes   | yes (no `predictionId`)   |
| `judge.list({ domain?, by?, all?, limit? })`   | `{ judgments }`                            | yes   | yes                       |
| `judge.confirm(id, { reviewer? })`             | `{ id, changed }`                          | expert role only | `refused` (`expert-only`: the dashboard) |
| `judge.withdraw(id)`                           | `{ id, withdrawn, changed, by }`           | expert role only | `refused` (`expert-only`: the dashboard) |
| `judge.experts.get()` / `judge.experts.set(experts)` | `{ experts }`                        | `get` (`set`: `experts-in-config`) | `get`; `set`: `refused` (`expert-only`: the dashboard) |
| `judge.resolve(predictionId, { verdict, reason?, criteria?, by, domain?, reviewer? })` | `ResolveView` (`agrees`, `prediction`, `judgment?`) | yes | `refused` |
| `judge.listPredictions({ status?, limit?, domain? })` | `{ predictions }`                   | yes   | `refused`                 |
| `judge.getPrediction(id)` / `judge.forgetPrediction(id)` | `PredictionView` / `{ id, forgotten }` | yes | `refused`               |
| `judge.evalLive({ domain?, includeAgentResolved? })` | `LiveEvalView`                       | yes   | `refused`                 |
| `feedback({ memoryId, signal, note?, query?, reviewer? })` | `FeedbackResultView` (`kept`, `feedback`, `applied?`, `reason?`) | yes | `refused` |
| `feedback.list({ status?, memoryId?, signal?, limit? })` | `{ feedback }`                    | yes   | `refused`                 |
| `feedback.confirm(id, { reviewer? })` / `feedback.dismiss(id)` | `FeedbackView`                            | expert role only | `refused`      |
| `feedback.retire(id)`                          | `{ feedback, memoryId, endReason }`        | expert role only | `refused`      |
| `feedback.supersede(id, fact)`                 | `{ feedback, memoryId, supersedes, redacted }` | expert role only | `refused`  |
| `exportTraining({ kind, out, expert?, since?, split?, include?, exclude?, force? })` | `TrainingExportView` (`dir`, `manifest`) | expert role only | `refused` (`local-only`) |
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
`lexical`: no model call), `inferTime` (default true, as the CLI does: a past time in the query ranks the results, and a
question about a state then, "which port did we use on 2 April", picks as-of),
`within` and `near` (spatial memory: 0.9.0 or newer locally, after 0.10.0 in Oort Cloud; see
[Spatial memory](#spatial-memory)) and `signal`.

**`forget` locally** also rewrites the later memories of the forgotten one's supersede chain that
restate one of its values ("changed from 3000 to 8080"), before it returns: the memory writer gets
each such memory alone, never the forgotten one, and states its current fact; a rewrite that adds
a word or keeps a value is not used. `rewritten` lists the ones rewritten. Any left as they were
(no writer, a failed or rejected rewrite, a concurrent change) are listed in `notRewritten`; check
or forget them too. See [Memories that restated it](cli.md#memories-that-restated-it). In Oort
Cloud the cloud rewrites them, and the result carries the same `rewritten` and `notRewritten`
(with `everywhere` too); Oort Cloud can also leave one as it was because the account is at a usage
cap, the plan does not allow model calls now, or a Constellation's rewrite did not finish in time.
Only memory ids are listed: `notRewrittenUnnamed` counts any left as they were that Oort Cloud
named with something else. An Oort Cloud that does not rewrite answers without the lists, and the
result leaves them out.

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
`entities`, `origin`, for a judgment, `judgment`, and for a memory remembered with one (0.9.0 or
newer), `place`. Recalled memories add `score` (comparable within one result only), `stale`, `why`
(`@experimental`) and, for a memory a person reported wrong or stale, `contested` (see
[Recall feedback](#recall-feedback)). A degraded recall is not an error:
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
- **`store.vectorIndex: 'rabitq'`** (0.10.0 or newer, opt-in): a RaBitQ index instead of the binary one. Each
  vector's 1-bit code is compared with a 4-bit copy of the query, with an error bound, and only
  the memories whose bound can still reach the top k are rescored (at most 10 × k). On the bench's
  corpora it read about half as many int8 vectors as the binary index, with the exact scan's
  results; [the design note](design/2026-11-12-rabitq-index.md#11-measurements) has the
  measurements. The scan runs in a native engine on macOS arm64 and Linux x64 and arm64 (glibc),
  and in TypeScript elsewhere (same results, slower scan). See the example below.
- **`recall.adaptiveStop`**: whether a recall that finds cold (archived) matches beside hot and
  warm ones returns them, which reads each one back and makes it warm again. `rule` leaves them
  out when the top hot or warm memory holds every informative word of the query and no cold match
  comes close; `decide` asks the decision model instead on a `full` recall (one call per such
  recall, see the table below; `recall.sufficientAt`, default 0.7); `off` always returns them. See
  [the CLI's description](cli.md#large-stores-the-binary-vector-index-090-or-newer).

<!-- example: examples/src/rabitq-index.ts -->

```ts
import { createOort } from 'oortmem';

// The RaBitQ index (0.10.0 or newer, opt-in). Each memory gets a 1-bit code with an error bound;
// a recall rescores, with their int8 vectors, only the memories whose bound can still reach the
// top k. A native engine ships for macOS arm64 and Linux x64 and arm64; elsewhere the same index
// runs in TypeScript, and `oort doctor` says which one this machine uses.
await using oort = await createOort({
  mode: 'local',
  config: { store: { vectorIndex: 'rabitq' } },
});

await oort.remember('The billing service deploys on Fridays after the change freeze.');
const { memories } = await oort.recall('when does the billing service deploy?');
console.log(memories.map((m) => m.text).join('\n'));
```

A repository's `oort.config.json` cannot set `store`, `recall.adaptiveStop`,
`recall.sufficientAt`, `recall.links` or `recall.userLinks` (they are ignored there, with a
warning): a home has one store, asking the decision model sends recalled text to its vendor, and
which links bring memories into a prompt is yours to decide. Your own code's `config`, or the home
config, can.

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
UI, an import job): `createOort({ judge: { role: 'expert', operator: 'grace' } })`. It records
anyone's judgments as `via: 'sdk'`, which counts as a person's, and may `confirm` an agent's
record. `scoped({ judgeRole: 'agent' })` narrows a handle back to the agent role; nothing widens
it. Framework tools always run in the agent role.

`judge.withdraw(id)` takes a judgment back: it stops counting anywhere at once, and stays listed
with `all: true`. It is the expert role's, like `confirm`. Withdrawing one that is already
withdrawn returns `changed: false`. `judge.experts.get()` returns the experts list; locally it is
the home config's (or the `config` option's), so `judge.experts.set()` is refused there
(`experts-in-config`).

### In Oort Cloud

In cloud mode the credential sets the role. An Oort key acts in the agent role, so a cloud handle
records, lists and applies judgments as an agent, under the same rules as locally.

<!-- example: examples/src/cloud-judgments.ts -->

```ts
import { createOort, OortRefusedError } from 'oortmem';

// In Oort Cloud an Oort key acts in the agent role: it records for the experts your account lists
// in the dashboard, and what it records waits there for a person to confirm it.
await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });

const { experts } = await oort.judge.experts.get();
const draft = await oort.judge.record({
  subject: 'Post claims a miracle cure for colds',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: experts[0]!,
});
console.log(draft.status); // 'agent-recorded'

// Unconfirmed agent records are left out of judging until a person confirms them.
const r = await oort.judge.apply({ summary: 'Post claims a miracle cure', domain: 'content' });
console.log(r.status, r.agentRecordedExcluded);

try {
  await oort.judge.confirm(draft.id);
} catch (e) {
  // A person's decision: made in the dashboard, not with a key.
  if (!(e instanceof OortRefusedError) || e.reason !== 'expert-only') throw e;
  console.log('confirm in the dashboard');
}
```

- It records only for the experts your account lists, which you set in the dashboard
  (`judge.experts.get()` reads them). The same refusals apply: `experts-not-listed`,
  `not-an-expert`, and `daily-limit` after 50 agent records a day. The cap is counted per account,
  and per end user for a server key's `scoped({ user })` handles.
- What it records stays unconfirmed until a person confirms it in the dashboard, so `judge.apply`
  leaves it out until then.
- A person's decisions are made in the dashboard at
  [oortcloud.dev/dashboard/judgments](https://oortcloud.dev/dashboard/judgments): `judge.confirm`,
  `judge.withdraw` and `judge.experts.set` are refused (`expert-only`).
- `createOort({ mode: 'cloud', judge: { role: 'expert' } })` is refused before any request
  (`expert-only`), and `judge.operator` is local only.
- Predictions stay local: `judge.apply` keeps none in the cloud (no `predictionId`), and
  `judge.resolve`, `judge.listPredictions`, `judge.getPrediction`, `judge.forgetPrediction`,
  `judge.evalLive` and `exportTraining` are refused (`local-only`).
- The experts list is the account's: on a handle scoped to an end user, `judge.experts.get()` is
  refused (`user-not-supported`), while recording for those experts works.
- `refused`, `cap-unavailable` (retryable) means Oort Cloud could not keep the daily count; nothing
  was recorded.

### Predictions and what the expert decided

`judge.apply` keeps each answer as a prediction: the item, the predicted verdict, its probability
and the precedents it cited. `JudgeResult.predictionId` is its id. When the person decides,
`judge.resolve` records it.

<!-- example: examples/src/predictions.ts -->

```ts
import { createOort } from 'oortmem';

// A review screen where a person decides runs in the expert role.
await using oort = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
});

for (const subject of [
  'Post claims a miracle cure for colds',
  'Post claims a herbal cure for colds',
]) {
  await oort.judge.record({
    subject,
    verdict: 'rejected',
    reason: 'A medical claim with no source.',
    domain: 'content',
    by: 'ada',
  });
}

// judge.apply keeps each answer as a prediction and returns its id.
const r = await oort.judge.apply({
  summary: 'Satire post about a miracle cure for colds',
  domain: 'content',
});

// Later, the person decides. A different verdict with a reason becomes a judgment, word for word,
// so the next judge.apply on a similar item cites it.
const { agrees, judgment } = await oort.judge.resolve(r.predictionId!, {
  verdict: 'approved',
  reason: 'Satire, clearly labelled as parody.',
  by: 'ada',
});
console.log(agrees, judgment?.outcome); // false 'added' (agrees is null when there was no prediction)

// Agreement and calibration over every resolved prediction.
const live = await oort.judge.evalLive();
console.log(live.resolved, live.bands.length);
```

- `agrees` is `true` or `false` when there was a prediction, and `null` when judging needed the
  expert. The verdict must be one of the prediction's verdicts.
- A reason makes a new judgment, unless the person agreed. It is stored word for word and needs a
  domain: the one you pass, else the prediction's.
- An unknown id is `not-found`. A prediction that is already resolved, older than 30 days or
  purged is `refused` with reason `already-resolved`, `expired` or `purged`. None of them writes
  anything. Another resolve or confirm landing meanwhile is `refused`, `conflict` (retryable):
  the judgment this call recorded is withdrawn and purged again.
- In the agent role, `resolve` follows the rules for `record`: only for a listed expert, a slot of
  the daily limit only when it records a judgment, and the whole prediction id (a prefix is
  `not-found`). The decision stays unconfirmed until an expert role calls
  `judge.confirm(predictionId)`, and an expert role's own `resolve` replaces it (the agent's
  judgment is withdrawn, or kept and named in `agentJudgmentKept`: with
  `agentJudgmentKeptReason: 'not-writable'` outside the handle's scope, or `'confirmed'` when a
  person already confirmed it). A prefix that matches both a judgment and a prediction is
  `ambiguous-id`. `evalLive` leaves unconfirmed decisions out unless `includeAgentResolved` is
  set.
- `evalLive` reports `overall` agreement, agreement on `suggested` items and their `coverage`,
  calibration per probability band (`bands`: `from`, `to`, `predicted`, `agreed`, `agreement`,
  `meanProbability`), and the `criteria` the expert overruled most.
- `judge.listPredictions()` lists pending predictions, newest first. Pass `status: 'resolved'` for
  decided ones. A pending prediction expires after 30 days; resolved ones stay until forgotten.
  A prediction is kept with the handle's project (unbound without one), so a handle scoped to
  another project does not list or resolve it; predictions kept before this were unbound.
  Above 5,000 pending from one author at its home (any project), or 50,000 from all authors there,
  `judge.apply` answers without keeping one (`kept: false`,
  `notKept: 'pending-cap'`); a failed write is `notKept: 'write-failed'`.
- Withdrawing, purging or forgetting a judgment first removes the text of every prediction that
  cited it; if one could not be purged the call fails (`internal`, `predictions-not-purged`,
  retryable) and the judgment is unchanged. `judge.forgetPrediction(id)` deletes one prediction
  (in the agent role, only a pending one: if a person resolves it while the call runs, it stays
  and the call is refused). It leaves the judgment its resolve recorded.
- Predictions are in the store file, so backups include them.

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
| `OortRefusedError`             | `refused`            | `scope-denied`, `star-in-cloud`, `star-with-user`, `local-only`, `experts-not-listed`, `not-an-expert`, `daily-limit`, `expert-only` (in Oort Cloud: a person's decision, made in the dashboard), `experts-in-config` (`judge.experts.set` locally), `payment-required`, `not-enabled`, `hive-not-enabled`, `end-users-unsupported`, `end-users-not-allowed` (not a server key), `end-user-limit`, `end-user-erased`, `forbidden` (another Oort Cloud refusal), `not-current` (`judge.confirm` on a judgment that is no longer current), `already-resolved`, `expired`, `purged` (`judge.resolve`), `not-resolved` (`judge.confirm` on a pending prediction), `conflict` (a prediction changed meanwhile; retryable), `in-progress` (a feedback row another call is resolving; retryable), `memory-changed` (a supersede could not take back its new memory; inspect it first), `predictions-unsupported` (a store that cannot keep predictions), `export-exists` (`exportTraining` into a directory that holds an earlier export; pass `force`), `not-a-directory` (`exportTraining` to a file or a symlink), `unsafe-directory` (`exportTraining` to an existing directory other users can write to), `store-changing` (`exportTraining` while labels kept changing; retryable), `cap-unavailable` (the daily judgment count could not be kept; retryable), `rate-limit` (retryable), `migration-required` (fix `oort doctor`) |
| `OortInternalError`            | `internal`           | `store-busy` (retryable), `predictions-not-purged` (retryable), else none          |

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
| `recall` | A Voyage embed (skipped on a cache hit or a confident keyword answer; a [question about two things](cli.md#questions-about-two-things) adds one input per part to the same request) and a Voyage rerank (skipped when confident, or with `speed: 'fast'`). With `recall.adaptiveStop: 'decide'` (0.9.0 or newer), a TypeSafe call when a `full` recall finds cold matches beside hot and warm ones. `speed: 'lexical'`: no model call | none (`decide` still needs a key) | Metered Oort Cloud recall |
| `observe` | A TypeSafe gate, always. If kept: one Anthropic writer call, one batched Voyage embed, and a TypeSafe reconcile per fact | Gate, writer and reconcile still need keys | Metered Oort Cloud observe |
| `remember` | One observe per fact | as above | One metered observe per fact |
| `judge.record` | One Voyage embed | none | Metered as one Oort Cloud save |
| `judge.apply` | One Voyage embed and one TypeSafe judge call | TypeSafe judge only | Metered as one Oort Cloud recall |
| `forget` | None, unless later memories of its chain restate one of its values: then one Anthropic writer call (that memory's text only) and one Voyage embed for each (CON-144) | The writer call still needs a key; the embed is local | No model call |
| `judge.resolve` | One Voyage embed when it records a judgment, else none | none | `refused` |
| `pin`, `unpin`, `link`, `unlink`, `explain`, `recent`, `judge.list`, `judge.confirm`, `judge.withdraw`, `judge.experts`, `judge.listPredictions`, `judge.getPrediction`, `judge.forgetPrediction`, `judge.evalLive`, `consolidate`, `whoami` | none | none | No model call |

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

## Time: what was true, and when

Facts change, and some turn out to be wrong. Oort keeps the old version instead of overwriting
it, so your code can ask what is true now, what was true on a past date, how a fact changed, and
what Oort believed on a past date. A support agent that learns a customer moved to another plan
can still say which plan they were on in March.

<!-- example: examples/src/time.ts -->

```ts
import { createOort } from 'oortmem';

// A support agent's memory of one customer. Each turn carries when it was said (`at`), and a date
// in the fact ("until", "starting") sets when the fact holds.
await using oort = await createOort({ mode: 'local' });

await oort.observe({
  user: 'Acme is on the Starter plan until 31 March 2026.',
  assistant: 'Noted.',
  at: '2026-03-02T09:00:00Z',
});
await oort.observe({
  user: 'Acme is on the Business plan starting 1 April 2026.',
  assistant: 'Noted.',
  at: '2026-03-30T09:00:00Z',
});

const question = 'Which plan is Acme on?';

// What is true now: the Starter fact has ended, so only the Business plan comes back.
const now = await oort.recall(question);
console.log(now.memories.map((m) => m.text));

// What was true on a date: `asOf` reads the facts that held then.
const march = await oort.recall(question, { asOf: '2026-03-15' });
console.log(march.memories.map((m) => m.text));

// Every version, each with the dates it held. The ended fact is kept as history.
const history = await oort.recall(question, { mode: 'history' });
for (const m of history.memories) console.log(m.validFrom, m.validTo, m.text);
```

- **Two times.** Each memory has a valid time, `validFrom` to `validTo`: when the fact held in the
  world. It also has a transaction time, from `recordedAt`: when Oort believed it. A recall reads
  one slice of them.
- **Two ways a fact ends.** When the situation changes, the old fact is **superseded**: it gets
  `validTo`, its `status` becomes `superseded`, and it still answers questions about the past.
  When a fact was wrong from the start, it is **corrected**: its `status` becomes `corrected`, and
  it never shows as having been true. A fact whose own end date has passed, with nothing replacing
  it, is `expired`. A fact that only gains detail is refined in place.
- **Dates in a fact** set when it holds: "until 31 March" ends it, "starting 1 April" starts it.
  They are read in code against the turn's `at` (now, when a turn has none).
- **The modes.** `current` (the default) is what is true now. `asOf` is what was true at that
  time, using everything learned since. `mode: 'history'` returns every version of the matching
  facts. `knownAt` is what Oort believed at that time, corrected facts included. Without a mode,
  `inferTime` reads one from the query, as the CLI does. The rules for each are in
  [Time: recall modes](cli.md#time-recall-modes).

## Spatial memory

A memory can carry where it was observed, and recall can ask what is in a place or near a point.
A robot that remembers where it saw each tool can then ask which toolboxes are in room B, or what
is within 1.5 m of it, and get only the memories from there. `within` and `near` filter before
ranking and before `limit` is taken.

Places need 0.9.0 or newer on the local engine, and a version after 0.10.0 in Oort Cloud. The same
calls, options and checks work in both modes. In Oort Cloud:

- A spatial recall reads only your own memories, never a Constellation.
- A `near` whose region holds more than 2,000 placed memories you can read (after `within`) is
  refused with `OortUsageError` (reason `invalid-argument`) and Oort Cloud's message, which asks
  for a smaller radius or a `within`. The local engine has no such limit.
- A place or filter Oort Cloud refuses is the same `OortUsageError` local mode gives, with Oort
  Cloud's message. The SDK checks every place before it is sent, so this is rare.
- `oort cloud import` now uploads each memory with its place. It skips memories already in Oort
  Cloud, so one uploaded by an earlier version stays there without its place.

<!-- example: examples/src/spatial.ts -->

```ts
import { createOort, type Place } from 'oortmem';

// A robot's memory of a site: each fact is remembered with where it was seen. The same code runs
// on the local engine (0.9.0 or newer) and on Oort Cloud (after 0.10.0).
await using oort = await createOort();

const room = (r: string, x: number, y: number, at?: string): Place => ({
  nodeId: `site:hq/room:${r}${at === undefined ? '' : `/${at}`}`,
  mapId: 'hq',
  pose: { x, y },
});
const seen: [string, Place][] = [
  ['The red toolbox is on shelf A1.', room('A', 1, 1, 'shelf:A1')],
  ['The aluminium ladder leans on the north wall.', room('A', 3, 4)],
  ['The cordless drill charges on bench A.', room('A', 2, 2, 'bench:A')],
  ['The blue toolbox is on shelf B3.', room('B', 11, 1, 'shelf:B3')],
  ['The torque wrench is in drawer 4.', room('B', 12, 3, 'drawer:4')],
  ['Spare fuses are in the grey cabinet.', room('B', 14, 1)],
  ['The green toolbox sits under the window.', room('B', 13, 4)],
  ['The first aid kit hangs by the door.', room('C', 21, 1)],
  ['The fire extinguisher is in the corner.', room('C', 24, 4)],
  ['The forklift charger is on the east wall.', room('C', 22, 3)],
];
for (const [fact, place] of seen) await oort.remember(fact, { place });

// Which toolboxes are in room B? `within` matches whole path segments: room:B, never room:B2.
const inB = await oort.recall('toolbox', { within: 'room:B' });
for (const m of inB.memories) console.log(m.why.placePath, '|', m.text);

// What is within 1.5 m of the robot? Distance is measured on the same map and frame only.
const here = { mapId: 'hq', pose: { x: 13, y: 3 }, radius: 1.5 };
const near = await oort.recall('toolbox', { near: here });
for (const m of near.memories) console.log(m.why.distanceM?.toFixed(2), '|', m.text);
```

**A place** (`Place`) is a place path, map coordinates, or both:

| Field        | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `nodeId`     | A place path, root first: `site:hq/floor:2/room:B/shelf:B3`. 1 to 16 segments of 1 to 64 letters (any script, with combining marks), digits and `. _ : @ -`; normalised to NFC; invisible characters (any default-ignorable code point, such as a variation selector) are refused, except the joiners IDNA's ContextJ rules allow (ZWJ after a virama; ZWNJ after a virama or between letters of a joining script such as Arabic). Compared exactly: a name with and without its ZWNJ is two places to `within` |
| `mapId`      | The map the coordinates are in. Required with `pose`                                          |
| `mapVersion` | Recorded, not filtered on                                                                     |
| `frame`      | The coordinate frame, default `map`. `odom` is refused: odometry drifts                       |
| `pose`       | `{ x, y, z?, yaw? }` in metres (x forward, y left, z up) and radians. Without `z`, 2D          |
| `extent`     | The region around `pose`: a box `{ dx, dy, dz? }` (full sizes, centred) or `{ radius }`      |
| `geo`        | `{ lat, lon, alt? }` (WGS84). Stored and returned, not searchable yet                        |
| `sigma`      | Pose uncertainty in metres (1 sigma)                                                          |

It needs a `nodeId`, a `pose` or `geo`. An unknown field, a value out of range or a bad path is a
usage error naming the field, never its value.

**Asking by place.**

- **`within: 'room:B'`** keeps memories whose place path contains `room:B` as whole segments, at
  any depth: `site:hq/room:B` and `site:hq/room:B/shelf:B3`, never `room:B2`. Nothing in the path
  is a wildcard.
- **`near: { mapId, frame?, pose: { x, y, z? }, radius }`** keeps memories within `radius` metres
  of `pose`, measured to the memory's region (0 inside it). Coordinates on another map or in
  another frame are never compared, so they never match. `z` counts only when both sides have it.
- **Both** must hold when you pass both. They compose with every time mode: `asOf` reads where
  things were then, and `history` returns each matching fact with the rest of its supersede chain
  (where it moved to, too).
- Memories without a place are unaffected by a recall that names neither, and never match one
  that does. Ranking is unchanged.

Each memory a spatial recall returns carries its `place`, and its `why` adds `placePath` and, with
`near`, `distanceM` (metres; 0 inside the region).

**Writing.** `remember(facts, { place })` tags every fact of the call; `observe({ ..., place })`
tags the memories the turn writes. In Oort Cloud, a retried `remember` is saved once (its
`turnRef` holds the fact, its type hint, the project, the UTC day and the place), so the same fact at another
place on the same day is saved again, not taken for a retry. A fact that supersedes or corrects another gets the turn's
place only, never the old one's. A refinement keeps its place unless the turn gives one. A turn
seen somewhere else than a memory it would reinforce adds a memory instead (decision `place` /
`elsewhere`), within the two places' `sigma`. Deciding that a thing moved is a later release's
job.

## Memory links

A link says that two memories belong together, so that recall can bring one along when it finds
the other. A support agent whose recall finds "the billing service deploys on Fridays" can bring
along "Friday deploys wait for the change freeze to end", which the question alone might miss.

Links work in local mode. A link holds no text: two ids, who asserted it and when. A recall
follows a link for one hop, under the rules in
[Following links at recall](cli.md#following-links-at-recall). By default it follows only links
confirmed at a terminal with `oort link`, and only at `speed: 'full'`. Links your code writes with
`link()` are followed once `recall.links.enabled` is set in the home config.

<!-- example: examples/src/links.ts -->

```ts
import { createOort } from 'oortmem';

await using oort = await createOort({ mode: 'local' });

const saved = await oort.remember([
  'The billing service deploys on Fridays.',
  'Friday deploys wait for the change freeze to end.',
]);
const [deploys, freeze] = saved.results.map((r) => r.id!);

// A link holds no text: two ids, who asserted it and when. From the SDK that is always `agent`.
const linked = await oort.link(deploys!, freeze!);
console.log(linked.linked, linked.assertedBy); // true agent

// `explain` lists the links whose other end this handle can read; `hiddenLinks` counts the rest.
const { links, hiddenLinks } = await oort.explain(deploys!);
console.log(links.map((l) => `${l.kind} ${l.assertedBy}`).join(', '), hiddenLinks); // explicit agent 0

// Unlinking removes the link. A pair that could be related again is blocked until it is linked.
const removed = await oort.unlink(deploys!, freeze!);
console.log(removed.removed); // true
```

- `link(from, to)` returns `{ linked, unblocked, assertedBy }`. From the SDK, `oort serve` and MCP
  a link is always asserted by `agent`; only `oort link`, confirmed at a terminal, records
  `user`. `user` is a record of how the link was made, not proof of who made it, and it gives no
  more access than `agent`. A `user` link is never downgraded.
- Both memories must be ones the handle writes, in the same Planet or the same Star. Any other pair
  (a Constellation or Galaxy memory, two different nodes, one memory twice, a memory the handle
  only reads) rejects with `OortNotFoundError`, the same as an id that does not exist.
- `unlink(from, to)` returns `{ removed, blocked }`. When the two were not linked, or share an
  entity or a session, it records a block: nothing links the pair again until `link` is called on
  it, which removes the block (`unblocked: true`). A link asserted by `user` is left in place:
  `unlink` rejects with `OortRefusedError` (`reason: 'asserted-by-user'`), and only `oort unlink`
  confirmed at a terminal removes it. `link` rejects the same way for a pair unlinked at a
  terminal.
- `explain(id).links` lists `{ kind, id, direction, assertedBy?, createdAt }` for links whose other
  end the handle reads. `hiddenLinks` counts the others, together with supersede-chain neighbours
  it cannot read.
- A recalled memory that a link brought in has `why.via` (`@experimental`, as `why` is):
  `{ kind, from, weight }`, with `kind` one of `explicit`, `episode` or `about`, `from` the id of
  the returned memory it was reached from, and `weight` from 0 to 1. `formatForPrompt` labels its
  line `linked`. It passed the same relevance gate as a hit, and it is always a memory the handle
  reads. `speed: 'lexical'` follows no link. A recall that ran out of its links time budget lists
  `links-skipped` in `degraded`.
- `forget(id)` removes every link and block of the memory.
- In cloud mode `link` and `unlink` reject with `OortRefusedError` (`reason: 'local-only'`),
  `explain().links` is empty, and recall follows no link: `why.via` never appears, and a home
  config with `recall.links.enabled` adds the warning `links-local-only` to each recall.

## Recall feedback

Feedback says what a recalled memory was worth: it `helped`, it is `wrong`, it is `stale` (out of
date), or it was `irrelevant` to a query (local mode). There is no recall log: you name the memory
by its id, and for `irrelevant` you pass the query it was recalled for.

<!-- example: examples/src/feedback.ts -->

```ts
import { createOort } from 'oortmem';

// A review screen where a person reads what was recalled runs in the expert role.
await using person = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
});

const saved = await person.remember(['The staging database runs Postgres 15.']);
const memoryId = saved.results[0]!.id!;

// Model-facing code runs in the agent role: its feedback waits for a person.
const agent = person.scoped({ judgeRole: 'agent' });
const draft = await agent.feedback({ memoryId, signal: 'wrong', note: 'Upgraded to 16 in May.' });
console.log(draft.kept && draft.feedback.status); // pending

// Nothing changes until the person confirms it. Then recall labels the memory contested.
const pending = await person.feedback.list({ status: 'pending' });
await person.feedback.confirm(pending.feedback[0]!.id);
const r = await person.recall('staging database version');
console.log(r.memories.find((m) => m.id === memoryId)?.contested?.signal); // wrong

// The person resolves it: store the right fact, and the old memory ends superseded.
const done = await person.feedback.supersede(
  pending.feedback[0]!.id,
  'The staging database runs Postgres 16.',
);
console.log(done.supersedes === memoryId, done.feedback.status); // true superseded
```

**Who counts.** The judge role decides, as for judgments. A handle in the expert role is a person:
its feedback counts at once (`via: 'sdk'`), and only it may `confirm`, `retire`, `supersede` or
`dismiss`; an agent handle is refused (`expert-only`). A handle in the agent role (the default)
gives feedback as an MCP agent does: kept `pending`, with no effect on recall until a person
confirms it. An agent names a memory by its whole id; a person may use a unique prefix.

**What each signal does.**

- `helped` adds `feedback.helpedAccesses` accesses (home config, default 2, 0 turns it off) to the
  memory's access log at the current time, so it ranks as if it had just been used that often. One
  `helped` per memory and person counts per UTC day; a later one is kept with `applied: false` and
  `reason: 'already-helped-today'`.
- `wrong` and `stale` open a correction. Ranking does not change and no memory is ended. Recall
  returns the memory with `contested: { feedbackId, signal, note?, by, at }`, and `formatForPrompt`
  adds `(contested: wrong, note: "...")` to its line, until a person resolves it:
  - `feedback.retire(id)` ends the memory now: `corrected` for `wrong` (it never held), `expired`
    for `stale` (it held until now).
  - `feedback.supersede(id, fact)` stores `fact` (one line, at most 500 characters, scrubbed of
    secrets) as a new memory, and the old one ends `superseded`.
  - `feedback.dismiss(id)` closes the feedback and keeps the memory as it is.
- `irrelevant` keeps the pair of query and memory id. Recall does not use it yet.

**Limits and races.** `note` and `query` lose invisible characters (zero-width, bidirectional
and tag characters), are scrubbed of secrets, made one line and cut to 500 characters. One agent
keeps at most 5,000 pending rows at its home, across every project, and all agents together
50,000 there; past that, `feedback()`
returns `{ kept: false, reason: 'pending-cap' }`. A row is kept with its memory's project, so a
handle scoped to another project does not see it.

`retire` and `supersede` first mark the row `resolving`, then change the memory, then close the
row. When two resolves run at once, one wins and the other rejects with `OortRefusedError`:
`already-resolved`, `in-progress` (another call is resolving it; retryable) or `conflict` (the
row changed meanwhile and nothing was written; retryable). A call that stopped part way leaves
the row `resolving`, and recall still returns `contested`: the same call again finishes it, and a
supersede never stores the fact twice. The same call again takes the row over before it changes
anything (`claim.takenOverBy`, `takenOverAt`), so a call still running stops before its next
change. The row's `claim` says who started it, who took it over, `ageSeconds`, and the `fact` a
supersede would store. Once `claim.canTakeOver` (5 minutes), `dismiss`, `retire` or a `supersede`
with another fact takes it over. When everything the claim changes is already in place, it is
finished as it was meant and the call rejects with `already-resolved`, saying nothing was undone.
Otherwise what it changed is put back first (its new memory, while nothing recalled, linked or
changed it, and the old memory's end; `claim.undoing` while that runs). The closed row keeps
`resolved.claimedBy`. The new memory is authored by the expert. If the old memory ended another
way meanwhile, the new one is removed and the row goes back to `open`; if the new one was
recalled, linked or changed meanwhile, it is kept, the row still goes back to `open`, and the error has reason
`memory-changed` and is not retryable: inspect the memories first. Another memory already at the
id a supersede writes is refused (`conflict`) and nothing changes. `forget(id)` deletes every feedback row about the memory, whoever gave it.

## Where a label came from

Every judgment, every resolve of a prediction, and every feedback row records how it arrived, as
`origin` (local mode). It tells a later reader, such as an export of training data, how the label
reached Oort. It is how a label arrived, not proof that a person made it: your integration can
name any reviewer, and whatever drives a terminal can answer the CLI's prompt.

<!-- example: examples/src/label-origin.ts -->

```ts
import { createOort } from 'oortmem';

// A review screen in your app: a person decides, and your integration names who that was.
await using review = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
  config: { judge: { experts: ['ada'] } },
});

const reviewed = await review.judge.record({
  subject: 'Post claims a cure for diabetes',
  verdict: 'rejected',
  reason: 'A medical claim with no source.',
  domain: 'content',
  by: 'ada',
  reviewer: 'grace@example.com',
});

// Model-facing code runs in the agent role: what it records is `agent`, whatever it passes.
const agent = review.scoped({ judgeRole: 'agent' });
const draft = await agent.judge.record({
  subject: 'Post claims a miracle cure for colds',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: 'ada',
  reviewer: 'grace@example.com',
});

// A confirm records its own origin and keeps the agent's as `proposedOrigin`.
await review.judge.confirm(draft.id, { reviewer: 'grace@example.com' });

const { judgments } = await review.judge.list();
const shown = (id: string) => {
  const j = judgments.find((x) => x.id === id)!;
  return [j.origin, j.reviewer, j.proposedOrigin ?? '-'].join(' ');
};
console.log(shown(reviewed.id)); // integration grace@example.com -
console.log(shown(draft.id)); // integration grace@example.com agent
```

| Origin | How the label arrived |
| --- | --- |
| `interactive` | A person answered the CLI's confirmation prompt for this label at a terminal, unless something on that machine drove the terminal for them. Never from the SDK. Code that calls the core library (`@oortmem/core`) directly can also record it, outside an agent harness; the CLI's question is the only path Oort itself offers. |
| `dashboard` | The Oort Cloud dashboard. The public API cannot set it: asking for it records `integration`. Code that edits the store or loads Oort's internal files can write anything, just as it could edit the database. |
| `connector` | An upstream connector, with `upstream` naming the system and who made the label there. Kept only as `dashboard` is. |
| `integration` | An expert-role handle, here or over `oort serve`, and every CLI call that does not record `interactive`. |
| `agent` | An agent-role handle (the default), here or over `oort serve`, and the MCP tools. |

- In the expert role, `judge.record`, `judge.resolve`, `feedback()` and both `confirm` calls take
  an optional `reviewer`: who reviewed the label, as your integration asserts it. It is kept as
  `reviewer`, scrubbed of secrets, one line with no tabs or invisible characters, at most 120
  characters (otherwise `OortUsageError`). Oort does not check who it names.
- Agents over MCP and agent-role handles always record `agent`. A `reviewer` an agent-role handle
  passes is ignored (one over 120 characters is still `OortUsageError`), and the MCP tools take
  no origin or reviewer at all.
- The CLI records `interactive` only when a person answered a prompt naming the label on the
  controlling terminal, and never while one of `AGENT_ENV_MARKERS` (from `@oortmem/core`) is set:
  `AI_AGENT`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`,
  `CODEX_SANDBOX_NETWORK_DISABLED`, `CURSOR_AGENT` and `GEMINI_CLI`. An agent that can run
  commands on your machine can unset them and drive a terminal, so `interactive` is only as
  trustworthy as the shells on that machine. For labels you will fine-tune on, prefer the
  dashboard and connectors; the [training export](#training-export) can leave out
  `interactive`. See [Where a label came from](cli.md#where-a-label-came-from) in the CLI
  reference.
- A confirm records the confirmer's origin as the label's origin and keeps the agent's as
  `proposedOrigin`: an agent's judgment confirmed by an expert-role handle reads
  `origin: 'integration', proposedOrigin: 'agent'`.
- Origin changes nothing about who may do what: the rules for the agent and expert roles stay as
  they are.
- `feedback.retire`, `supersede` and `dismiss` keep how they arrived in `FeedbackView.resolved`
  (`origin: 'integration'` from an expert-role handle).
- `JudgmentView`, `PredictionView.resolution` and `FeedbackView` carry `origin`, and `reviewer`,
  `upstream` and `proposedOrigin` when set. A label written before Oort kept origins reads as
  `agent` when an agent recorded it and no person has confirmed it, and as `integration`
  otherwise.
- Purging a judgment drops its `reviewer`, and recording the same decision again leaves the row,
  and its origin, as they were.
- `exportTraining` exports only `interactive`, `dashboard` and `connector` labels by default;
  `include: ['integration']` adds the labels an expert-role handle records, `exclude` leaves out
  origins, and `agent` labels never leave.

## Training export

`exportTraining` writes the labels people gave (judgments, resolves of predictions and recall
feedback) as JSON Lines a fine-tuning job reads, one file per kind and `manifest.json`, into
`out` (local mode). It is `oort export training` from code, with the same files, filters and
rules ([Training export](cli.md#training-export-oort-export-training) in the CLI reference).

<!-- example: examples/src/training-export.ts -->

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOort } from 'oortmem';

// A review screen in your app: a person decides, so the handle runs in the expert role.
await using review = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
});

await review.judge.record({
  subject: 'Post claims a cure for diabetes',
  verdict: 'rejected',
  reason: 'A medical claim with no source.',
  domain: 'content',
  by: 'ada',
  reviewer: 'grace@example.com',
});

// Labels from code arrive as `integration`: add it to the default origins to export them.
// Preference rows hold verdicts only; preferenceReasons adds the person's reason to `chosen`.
const out = mkdtempSync(join(tmpdir(), 'oort-training-'));
const { manifest } = await review.exportTraining({
  kind: 'all',
  out,
  include: ['integration'],
  preferenceReasons: true,
});

const rows = readFileSync(join(out, 'sft.jsonl'), 'utf8').trim().split('\n');
const row = JSON.parse(rows[0]!) as { messages: { content: string }[]; origin: string };
console.log(manifest.counts.sft?.rows, row.origin); // 1 integration
console.log(row.messages[1]!.content.split('\n')[0]); // Verdict: rejected
console.log(manifest.notes.length); // 1 (the manifest notes that `rejected` has no reason)

// Model-facing code runs in the agent role, and an agent never exports training data.
const agent = review.scoped({ judgeRole: 'agent' });
await agent.exportTraining({ kind: 'sft', out }).catch((e: { reason?: string }) => {
  console.log(e.reason); // expert-only
});
```

**Who may export.** Only a handle in the expert role: an agent-role handle is refused
(`OortRefusedError`, `expert-only`) and writes nothing. The export reads what the handle's grant
reads, so a handle scoped to one project never exports another project's feedback or
predictions. Judgments belong to the expert, not to a project: every handle of that person reads
them.

**Options.** `kind` (`sft`, `preference`, `retrieval` or `all`) and `out` (a directory, as an
absolute path; a relative one is a usage error) are required. `expert` keeps one expert's labels; `since` keeps labels made at or after a time;
`split: 'time:0.8'` writes `<kind>.train.jsonl` and `<kind>.eval.jsonl` instead of
`<kind>.jsonl`, the earliest 80% of each kind to train, and rows with the same time on one side.
A retrieval query whose rows would fall on both sides is left out of both (`straddles-split`).
`include` adds origins to `interactive`, `dashboard` and `connector` (only `integration` adds
one; `agent` is a usage error), and `exclude` leaves origins out. `preferenceReasons: true` adds
the person's reason to `chosen` in preference rows. A directory the export creates is 0700; an
existing `out` keeps its mode, and is refused (`unsafe-directory`) when group or others can write
to it, since another user could replace the files; someone who can write to its parent controls
where the export lands, so choose a directory only you can write to. Each file is 0600. A
directory that holds an earlier export is refused (`export-exists`) unless `force: true`, which
replaces that export's files once the new ones are complete and leaves other files alone. A
file or a symlink as `out` is refused (`not-a-directory`).

**While the store changes.** The export does not lock the store. It writes each file under a
temporary name, reads every record behind its rows again, and builds again from the start when
one was forgotten, withdrawn or corrected meanwhile; after 3 builds that kept changing it fails
(`store-changing`, retryable) and writes nothing. On a failure before the renames the temporary
files go and an earlier export stays as it was. If the export fails while renaming, `out` has no
`manifest.json`; run it again. The temporary files also go on SIGINT or SIGTERM, and leftovers
of an interrupted run are removed when the next export into `out` starts. A forget that finishes between that check and the renames can
still be in the files, so export again after forgetting to be sure. An export is a copy:
forgetting a memory later does not change files already written.

**What it writes.** Every row carries `id`, `at` (the label's time) and `origin`, with
`proposedOrigin` and `reviewer` when set; rows are oldest first. Each text is cleaned of
invisible and control characters and scrubbed of secrets again on the way out.

- `sft.jsonl`: one row per judgment a person made, `{ messages: [{ role: 'user', content:
  <item> }, { role: 'assistant', content: 'Verdict: <verdict>\nReason: <reason>' }] }`. A
  judgment of `Post says a vitamin cures the flu`, `rejected` because `A health claim with no
  cited source.`, becomes:

  ```json
  {"messages":[{"role":"user","content":"Post says a vitamin cures the flu"},{"role":"assistant","content":"Verdict: rejected\nReason: A health claim with no cited source."}],"id":"4f1c…","at":"2026-10-01T09:00:00.000Z","domain":"content","origin":"interactive"}
  ```

- `preference.jsonl`: one row per resolved prediction where the person chose another verdict
  than the one proposed, `{ prompt, chosen, rejected }`: `chosen` is the person's verdict,
  `rejected` the proposal, both as `Verdict: <verdict>`. A proposal has no reason, so a reason
  on the chosen side only would teach a model to prefer the longer answer rather than the right
  verdict. With `preferenceReasons: true`, `chosen` adds the person's reason and
  `manifest.notes` says that `rejected` has none. A resolve that agreed gives no row. A
  prediction that proposed `approved` for `Post says garlic cures infections`, resolved
  `rejected` with the reason `Health claim with no source.`, becomes:

  ```json
  {"prompt":"Post says garlic cures infections","chosen":"Verdict: rejected","rejected":"Verdict: approved","id":"9a8b…","at":"2026-10-08T09:00:00.000Z","domain":"content","origin":"dashboard","reviewer":"grace@example.com"}
  ```

  With `preferenceReasons: true`, `chosen` is `"Verdict: rejected\nReason: Health claim with no source."`.

- `retrieval.jsonl`: `{ query, positive, negative }`, each a memory's text. An `irrelevant`
  row is a hard negative for its query, paired with a `helped` row of the same query when there
  is one (`positive: null` when there is none); a `helped` row counts only when it was given
  with a `query`. Feedback `{ signal: 'irrelevant', query: 'auth service port' }` on the lunch
  memory and `{ signal: 'helped', query: 'auth service port' }` on the port memory become:

  ```json
  {"query":"auth service port","positive":"The auth service listens on port 5502 in staging.","negative":"The team orders lunch on Fridays.","id":"71c2…","at":"2026-10-12T09:00:00.000Z","origin":"interactive","positiveId":"83d4…","positiveOrigin":"interactive"}
  ```

- `manifest.json` (`TrainingManifestView`, also returned as `manifest`): the export time, the
  Oort version, the filters, rows per kind, origin and split part, every record left out by
  kind and reason (`agent-unconfirmed`, `withdrawn`, `pending`, `dismissed`, `agreed`, …), the
  rows whose text changed, `notes` about the rows, and each file's `sha256`. The CLI reference
  lists every reason.

**What `origin` proves.** It says how a label reached Oort, not who made it: your integration
names any `reviewer` it likes, and whatever drives a terminal can answer the CLI's prompt (see
[Where a label came from](#where-a-label-came-from)). The export keeps these fields as stored;
choose the origins you trust before you train on them.

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
