# The TypeScript SDK: modes, options, methods

`createOort(options?)` returns a handle (`Oort`) whose scope is fixed when it is made. It is
async (local mode opens SQLite and reads key sources) and never makes a network request.

## Modes

- **`local`** runs the engine in your process on a SQLite store in `home`. Model calls use your
  own Voyage, TypeSafe and Anthropic keys, or the Oort key through the Oort Pro relay.
- **`cloud`** calls Oort Cloud over HTTPS with the Oort key (`OORT_API_KEY`). It writes nothing
  to disk and loads no native module. Without a usable key it throws `OortNeedsLoginError`.
- **`auto`** (the default) uses the store `oort setup` chose on this machine
  (`$OORT_HOME/cloud.json`), else `local`. Good for a developer's own tools; servers pass `mode`.

Same methods, results and errors in every mode. Against Oort Cloud:

<!-- example: examples/src/cloud-quick-start.ts -->

```ts
import { createOort } from 'oortmem';

// Oort Cloud, with the Oort key from the environment (OORT_API_KEY).
await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });

await oort.remember('The user lives in Lund.');
const { memories } = await oort.recall('where does the user live?');
console.log(memories.map((m) => m.text));
```

## Options

Every option object is checked strictly: an unknown key, or an option the mode does not take
(`keys.voyage` with `mode: 'cloud'`), throws `OortUsageError`.

| Option          | Modes                                             | Default and meaning                                                                                                 |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mode`          | all                                               | `'auto'`; or `'local'`, `'cloud'`                                                                                   |
| `home`          | local, auto                                       | `OORT_HOME`, else `~/.oort`                                                                                         |
| `cwd`           | all                                               | `process.cwd()`; used only to find the project and its config                                                       |
| `project`       | all                                               | derived from `cwd` as the CLI does; a string becomes `cfg:<id>`; `null` means global memories only                  |
| `projectConfig` | local, cloud                                      | `true`; `false` skips the repository's `oort.config.json` (a server whose cwd is a checkout)                        |
| `agent`         | all                                               | `OORT_AGENT`, else anonymous (the Planet only)                                                                      |
| `user`          | local                                             | unset: the person. Setting it requires `org`                                                                        |
| `org`           | local                                             | `'local'`. Required, and not `'local'`, whenever `user` is set                                                      |
| `keys`          | local; cloud (`oort` only)                        | none: `{ voyage?, typesafe?, anthropic?, oort? }`                                                                   |
| `keySources`    | all                                               | `['explicit', 'env', 'keychain']`; `keychain` is skipped with `OORT_NO_KEYCHAIN=1`                                  |
| `config`        | local                                             | none: a deep partial of the home config, laid over it (`serve` cannot be set)                                       |
| `url`           | cloud                                             | `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`                                                                  |
| `timeoutMs`     | cloud                                             | 30 000 per request                                                                                                  |
| `migrate`       | local                                             | `true`; `false` refuses an older store (`refused`, `migration-required`)                                            |
| `env`           | all                                               | `process.env`                                                                                                       |
| `fetch`         | cloud                                             | a keep-alive connection pool                                                                                        |
| `judge`         | local; cloud (`role: 'agent'` only, after 0.10.0) | `{ role: 'agent' }`; `{ role: 'expert', operator? }` only where a person decides (see [judgments.md](judgments.md)) |

**Keys.** Each model role (embed, rerank, decide, write) uses the first key found: `keys.<vendor>`,
then `VOYAGE_API_KEY`, `TYPESAFE_API_KEY` or `ANTHROPIC_API_KEY`, then the Keychain (or
`credentials.json` where there is no Keychain), then the Oort key through the Oort Pro relay
(metered). With none, recall degrades to keyword search (warning `lexical-only`) and a write
throws `OortNeedsKeyError`. A local model (`oort models pull`, or
`config: { embed: { provider: 'local' } }`) is a config choice, never a fallback. Cloud mode
needs only the Oort key. Passing `keys` with a `keySources` that leaves out `'explicit'` is a
usage error.

## Methods

| Method                                                                                                                                                          | Returns                                            | Cloud mode                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `recall(query, opts?)`                                                                                                                                          | `RecallResult`                                     | yes                                                               |
| `observe(turn, { signal? })`                                                                                                                                    | `ObserveResult`                                    | yes                                                               |
| `remember(facts, { type?, place? })`                                                                                                                            | `RememberResult`                                   | yes (`place` after 0.10.0)                                        |
| `forget(id, { everywhere? })`                                                                                                                                   | `ForgetResult`                                     | yes (`everywhere`: cloud only)                                    |
| `pin(id)` / `unpin(id)`                                                                                                                                         | `PinResult`                                        | yes (`changed: null`)                                             |
| `recent({ since?, limit? })`                                                                                                                                    | `{ memories, warnings }`                           | yes                                                               |
| `explain(id)`                                                                                                                                                   | `Explanation`                                      | yes (`links`, after 0.10.0, is empty)                             |
| `link(from, to)` / `unlink(from, to)` (after 0.10.0)                                                                                                            | `LinkResult` / `UnlinkResult`                      | `refused` (`local-only`)                                          |
| `whoami()`                                                                                                                                                      | `Whoami`                                           | yes                                                               |
| `judge.record(input)`                                                                                                                                           | `RecordJudgmentView`                               | yes, agent role (after 0.10.0)                                    |
| `judge.apply(item, opts?)`                                                                                                                                      | `JudgeResult`                                      | yes, no `predictionId` (after 0.10.0)                             |
| `judge.list({ domain?, by?, all?, limit? })`                                                                                                                    | `{ judgments }`                                    | yes (after 0.10.0)                                                |
| `judge.confirm(id, { reviewer? })`                                                                                                                              | `{ id, changed }` (expert role)                    | `refused` (`expert-only`: the dashboard)                          |
| `judge.withdraw(id)` (after 0.10.0)                                                                                                                             | `{ id, withdrawn, changed, by }` (expert role)     | `refused` (`expert-only`: the dashboard)                          |
| `judge.experts.get()` / `judge.experts.set(experts)` (after 0.10.0)                                                                                             | `{ experts }` (`set` locally: `experts-in-config`) | `get`; `set`: `refused` (`expert-only`)                           |
| `judge.resolve(predictionId, input)` (after 0.10.0)                                                                                                             | `ResolveView`                                      | `refused`                                                         |
| `judge.listPredictions({ status?, limit?, domain? })` (after 0.10.0)                                                                                            | `{ predictions }`                                  | `refused`                                                         |
| `judge.getPrediction(id)` / `judge.forgetPrediction(id)` (after 0.10.0)                                                                                         | `PredictionView` / `{ id, forgotten }`             | `refused`                                                         |
| `judge.evalLive({ domain?, includeAgentResolved? })` (after 0.10.0)                                                                                             | `LiveEvalView`                                     | `refused`                                                         |
| `feedback({ memoryId, signal, note?, query?, reviewer? })` (after 0.10.0)                                                                                       | `FeedbackResultView`                               | `refused`                                                         |
| `feedback.list(opts?)` / `feedback.confirm(id, { reviewer? })` / `feedback.retire(id)` / `feedback.supersede(id, fact)` / `feedback.dismiss(id)` (after 0.10.0) | `{ feedback }` / views (expert role resolves)      | `refused`                                                         |
| `exportTraining({ kind, out, expert?, since?, split?, include?, exclude?, force? })` (after 0.10.0)                                                             | `TrainingExportView` (expert role)                 | `refused`                                                         |
| `consolidate({ budgetMs?, signal? })`                                                                                                                           | `ConsolidateResult`                                | `refused`                                                         |
| `scoped({ user?, project?, agent?, judgeRole? })`                                                                                                               | a new handle                                       | `project`, `agent` only in 0.7.0 (`user`: after it, a server key) |
| `endUsers.erase(user)`                                                                                                                                          | `EndUserErasure`                                   | 0.8.0, a server key                                               |
| `endUsers.count()`                                                                                                                                              | `EndUserCount`                                     | 0.8.0, a server key                                               |
| `endUsers.export(user)`                                                                                                                                         | `EndUserExport`                                    | 0.8.0, a server key                                               |
| `close()`, `[Symbol.asyncDispose]()`                                                                                                                            | `void`                                             |                                                                   |
| `formatForPrompt(result, { budgetChars? })`                                                                                                                     | `string` (a function, not a method)                | both                                                              |

**`recall` options.** `limit` (1 to 50, default 10), `mode` (`current`, `as-of`, `history`,
`known-at`), `asOf` (valid time), `knownAt` (transaction time), `include` (narrows the levels
read: `self`, `planet`, `star`, `constellation`, `galaxy`), `budgetChars` (the default block size
for `formatForPrompt`), `includeWithdrawn`, `speed` (`full`: embed and rerank; `fast`: no rerank;
`lexical`: no model call), `inferTime` (default true: "on 2 April" picks as-of), `within` and
`near` (spatial memory, below) and `signal`.
`as-of` needs `asOf`, `known-at` needs `knownAt`, and `asOf` together with `knownAt` is a usage
error. Oort keeps a fact that changed as history (superseded) and one that was wrong as never true
(corrected), so `current` is what is true now, `asOf` what was true then, `history` every version,
and `knownAt` what Oort believed then. A date in a fact ("until 31 March", "starting 1 April")
sets when it holds, read against the turn's `at`.

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

**A `Turn`** for `observe` is `{ user, assistant }`, plus optional `tools` (tool-call summaries),
`at`, `sessionId`, `turnRef` and `place`. `turnRef` is deduplicated by Oort Cloud only (it answers
`duplicate: true`); locally a retry may write twice.

**Spatial memory** (0.9.0 or newer, local mode only). A memory can carry where it was observed,
and recall can keep only the memories in a place or near a point: a robot asks which toolboxes
are in room B. `remember(facts, { place })` and a turn's `place` tag memories with where they
are: `{ nodeId?, mapId?, mapVersion?, frame?, pose?, extent?, geo?, sigma? }`, with a place path such as `site:hq/room:B/shelf:B3`, map coordinates in metres
(`pose: { x, y, z?, yaw? }`, `mapId` required with it), or both. `recall(q, { within: 'room:B' })`
keeps memories whose path contains those whole segments; `near: { mapId, frame?, pose, radius }`
keeps those within `radius` metres on the same map and frame. Both filter before ranking and
`limit`, and compose with the time modes. Recalled memories carry `place`, `why.placePath` and
`why.distanceM`. `frame: 'odom'` is refused. Oort Cloud takes all three after 0.10.0, with the
same checks: a spatial recall there reads only your own memories (never a Constellation), and a
`near` whose region holds more than 2,000 placed memories is an `OortUsageError` (reason
`invalid-argument`) with Oort Cloud's message, asking for a smaller radius or a `within`. In
0.10.0 and older, cloud mode refuses them (`refused`, `local-only`) before anything is sent.

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

**Results.** Every memory is a `MemoryView`: `id`, `text` (scrubbed of secrets again on the way
out), `type`, `tier`, `pinned`, `status`, `validFrom`, `validTo`, `recordedAt`, `updatedAt`,
`entities`, `origin`, for a judgment, `judgment`, and `place` when it has one. A `RecalledMemory` adds `score`
(comparable within one result only), `stale` and `why` (`@experimental`). A `RecallResult` has
`memories`, `abstained` (nothing stored answered the query), `temporal` (the time mode used),
`read` (the spaces read), and `degraded` and `warnings` when recall ran degraded
(`lexical-only`, `recall-degraded`, `time-mode-unreported`). Ignore result fields you do not
know: new ones may appear in any release.

**`whoami()`** returns the `mode`, `account`, `agent`, `project`, `user`, `reads`, `writesTo`,
`version` and `routes`: per model role (embed, rerank, decide, write) `own-key`, `oort-pro`,
`local`, `cloud` or `missing`.

**Ids.** A full id, or a unique prefix of at least 8 characters. Several matches throw
`OortAmbiguousIdError`. An id outside the handle's scope is `OortNotFoundError`, exactly like an
unknown one.

**Abort.** An aborted `signal` stops the SDK waiting and rejects with the signal's reason. Work
already sent (cloud) or started (local) may still land; in cloud mode, retry with the same
`turnRef`.

**Lifecycle.** One handle is safe for concurrent calls. `close()` is idempotent; afterwards every
call throws `OortUsageError` (`closed`). Closing a `scoped()` handle does nothing; closing the
root closes everything. `await using oort = await createOort()` closes it for you. Keys given in
code stay out of every enumerable field, so `console.log(oort)` prints only the mode and scope.

## Limits

Anything over a limit throws `OortUsageError` before any I/O. The error names the field, never
its value.

| Input             | Limit                                                            |
| ----------------- | ---------------------------------------------------------------- |
| `recall` query    | 2,048 UTF-8 bytes                                                |
| `recall` `limit`  | 1 to 50                                                          |
| `observe` turn    | 128 KiB in all (the engine keeps 32 KiB of text after scrubbing) |
| `tools` summaries | truncated to 16 × 512 bytes, never refused                       |
| `turnRef`         | 128 characters                                                   |
| `remember`        | 5 facts of at most 500 characters                                |
| `recent` `limit`  | 1 to 100                                                         |

## Large local stores (0.9.0 or newer)

Two config settings change how a local recall reads a large store; results keep their shape and
scores. `store.vectorIndex`: `auto` (default) searches int8 vectors exactly until 100,000
searchable vectors, then builds a binary index (1-bit codes, the best 10 × k rescored in int8);
`binary` builds it now, `int8` drops it. A memory the codes rank outside the candidates can be
missed. `rabitq` (0.10.0 or newer, opt-in) builds a RaBitQ index instead: 1-bit codes with an error bound each, so
only the memories that can still reach the top k are rescored (at most 10 × k); a native engine on
macOS arm64 and Linux x64/arm64, TypeScript elsewhere, same results. `recall.adaptiveStop`: `rule` (default) leaves cold (archived) matches out, unread, when
the top hot or warm memory holds every informative query word and no cold match comes close;
`decide` asks the decision model instead (one TypeSafe call per `full` recall with cold matches);
`off` always returns them. A repository's `oort.config.json` cannot set either (nor
`recall.sufficientAt`); `config` in code or the home config can. Python local mode reads them
from `~/.oort/config.json`.

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

## Memory links (local mode, after 0.10.0)

Not in 0.10.0: `link`, `unlink`, `Explanation.links` and `why.via` come in the release after it.
On 0.10.0, do not call them.

`link(from, to)` says two memories belong together, so a recall that finds one can bring the
other along; `unlink` removes it, or blocks a pair that was not linked. Both memories must be
ones the handle writes, in the same Planet or Star: any other pair rejects with `OortNotFoundError`, like a missing id. From the SDK a link is always asserted
by `agent`; `unlink` rejects (`refused`, `asserted-by-user`) for a link confirmed at a terminal
with `oort link`. A `full` recall follows a link confirmed at a terminal for one hop;
links your code writes are followed once the home config sets `recall.links.enabled`. A memory a
link brought in has `why.via` (`{ kind, from, weight }`), passed the same relevance gate as a hit,
and is labelled `linked` by `formatForPrompt`. In cloud mode both reject (`refused`, `local-only`)
and recall follows no link.

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

## Recall feedback (local mode, after 0.10.0)

Not in 0.10.0: `feedback` and `RecalledMemory.contested` come in the release after it. On 0.10.0,
do not call them.

`feedback({ memoryId, signal, note?, query? })` says a recalled memory `helped`, is `wrong`, is
`stale`, or was `irrelevant` to `query` (required for that signal). There is no recall log: name
the memory by id. The judge role decides who counts. An agent-role handle (the default, and what
model-facing code should use) records `pending` feedback that changes nothing until an
expert-role handle or `oort feedback confirm` confirms it. An expert-role handle counts at once,
and only it can `confirm`, `retire` (end the memory), `supersede` (store the right fact; the old
memory ends `superseded`) or `dismiss`; an agent handle gets `refused`, `expert-only`. `helped`
adds `feedback.helpedAccesses` accesses (default 2) once per memory and person per UTC day.
`wrong` and `stale` never change ranking or end a memory: recall returns `contested` on it and
`formatForPrompt` labels the line until a person resolves it. A lost race between two resolves
rejects with `refused` (`already-resolved`, or `in-progress` / `conflict`, both retryable) and
changes nothing. A retire or supersede that stopped part way leaves the row `resolving` (its
`claim` shows who, how long ago and the pending fact): the same call again finishes it, and after
5 minutes `dismiss`, `retire` or a reworded `supersede` takes it over, finishing it when its
changes are all in place (`already-resolved`) and otherwise putting them back first. Feedback is kept with its
memory's project, and a kept prediction with the handle's project.

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

## Stability

Before 1.0, a breaking change to anything not marked `@experimental` lands only in a minor
release (0.6 to 0.7). `@experimental`, and free to change in any minor: `oortmem/ai-sdk`,
`RecalledMemory.why` and `JudgeResult.decisions`. New options, result fields, `reason` strings
and warnings are additive and can arrive in any release.
