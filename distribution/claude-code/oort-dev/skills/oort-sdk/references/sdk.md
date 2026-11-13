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

| Option          | Modes                      | Default and meaning                                                                                                 |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mode`          | all                        | `'auto'`; or `'local'`, `'cloud'`                                                                                   |
| `home`          | local, auto                | `OORT_HOME`, else `~/.oort`                                                                                         |
| `cwd`           | all                        | `process.cwd()`; used only to find the project and its config                                                       |
| `project`       | all                        | derived from `cwd` as the CLI does; a string becomes `cfg:<id>`; `null` means global memories only                  |
| `projectConfig` | local, cloud               | `true`; `false` skips the repository's `oort.config.json` (a server whose cwd is a checkout)                        |
| `agent`         | all                        | `OORT_AGENT`, else anonymous (the Planet only)                                                                      |
| `user`          | local                      | unset: the person. Setting it requires `org`                                                                        |
| `org`           | local                      | `'local'`. Required, and not `'local'`, whenever `user` is set                                                      |
| `keys`          | local; cloud (`oort` only) | none: `{ voyage?, typesafe?, anthropic?, oort? }`                                                                   |
| `keySources`    | all                        | `['explicit', 'env', 'keychain']`; `keychain` is skipped with `OORT_NO_KEYCHAIN=1`                                  |
| `config`        | local                      | none: a deep partial of the home config, laid over it (`serve` cannot be set)                                       |
| `url`           | cloud                      | `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`                                                                  |
| `timeoutMs`     | cloud                      | 30 000 per request                                                                                                  |
| `migrate`       | local                      | `true`; `false` refuses an older store (`refused`, `migration-required`)                                            |
| `env`           | all                        | `process.env`                                                                                                       |
| `fetch`         | cloud                      | a keep-alive connection pool                                                                                        |
| `judge`         | local                      | `{ role: 'agent' }`; `{ role: 'expert', operator? }` only where a person decides (see [judgments.md](judgments.md)) |

**Keys.** Each model role (embed, rerank, decide, write) uses the first key found: `keys.<vendor>`,
then `VOYAGE_API_KEY`, `TYPESAFE_API_KEY` or `ANTHROPIC_API_KEY`, then the Keychain (or
`credentials.json` where there is no Keychain), then the Oort key through the Oort Pro relay
(metered). With none, recall degrades to keyword search (warning `lexical-only`) and a write
throws `OortNeedsKeyError`. A local model (`oort models pull`, or
`config: { embed: { provider: 'local' } }`) is a config choice, never a fallback. Cloud mode
needs only the Oort key. Passing `keys` with a `keySources` that leaves out `'explicit'` is a
usage error.

## Methods

| Method                                            | Returns                             | Cloud mode                                                        |
| ------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `recall(query, opts?)`                            | `RecallResult`                      | yes                                                               |
| `observe(turn, { signal? })`                      | `ObserveResult`                     | yes                                                               |
| `remember(facts, { type?, place? })`              | `RememberResult`                    | yes (`place`: `refused`, `local-only`)                            |
| `forget(id, { everywhere? })`                     | `ForgetResult`                      | yes (`everywhere`: cloud only)                                    |
| `pin(id)` / `unpin(id)`                           | `PinResult`                         | yes (`changed: null`)                                             |
| `recent({ since?, limit? })`                      | `{ memories, warnings }`            | yes                                                               |
| `explain(id)`                                     | `Explanation`                       | yes (`links` is empty)                                            |
| `link(from, to)` / `unlink(from, to)`             | `LinkResult` / `UnlinkResult`       | `refused` (`local-only`)                                          |
| `whoami()`                                        | `Whoami`                            | yes                                                               |
| `judge.record(input)`                             | `RecordJudgmentView`                | `refused`                                                         |
| `judge.apply(item, opts?)`                        | `JudgeResult`                       | `refused`                                                         |
| `judge.list({ domain?, by?, all?, limit? })`      | `{ judgments }`                     | `refused`                                                         |
| `judge.confirm(id)`                               | `{ id, changed }` (expert role)     | `refused`                                                         |
| `consolidate({ budgetMs?, signal? })`             | `ConsolidateResult`                 | `refused`                                                         |
| `scoped({ user?, project?, agent?, judgeRole? })` | a new handle                        | `project`, `agent` only in 0.7.0 (`user`: after it, a server key) |
| `endUsers.erase(user)`                            | `EndUserErasure`                    | 0.8.0, a server key                                               |
| `endUsers.count()`                                | `EndUserCount`                      | 0.8.0, a server key                                               |
| `endUsers.export(user)`                           | `EndUserExport`                     | 0.8.0, a server key                                               |
| `close()`, `[Symbol.asyncDispose]()`              | `void`                              |                                                                   |
| `formatForPrompt(result, { budgetChars? })`       | `string` (a function, not a method) | both                                                              |

**`recall` options.** `limit` (1 to 50, default 10), `mode` (`current`, `as-of`, `history`,
`known-at`), `asOf` (valid time), `knownAt` (transaction time), `include` (narrows the levels
read: `self`, `planet`, `star`, `constellation`, `galaxy`), `budgetChars` (the default block size
for `formatForPrompt`), `includeWithdrawn`, `speed` (`full`: embed and rerank; `fast`: no rerank;
`lexical`: no model call), `inferTime` (default true: "on 2 April" picks as-of), `within` and
`near` (spatial memory, below) and `signal`.
`as-of` needs `asOf`, `known-at` needs `knownAt`, and `asOf` together with `knownAt` is a usage
error.

**A `Turn`** for `observe` is `{ user, assistant }`, plus optional `tools` (tool-call summaries),
`at`, `sessionId`, `turnRef` and `place`. `turnRef` is deduplicated by Oort Cloud only (it answers
`duplicate: true`); locally a retry may write twice.

**Spatial memory** (0.9.0 or newer, local mode only). `remember(facts, { place })` and a turn's
`place` tag memories with where they are: `{ nodeId?, mapId?, mapVersion?, frame?, pose?, extent?,
geo?, sigma? }`, with a place path such as `site:hq/room:B/shelf:B3`, map coordinates in metres
(`pose: { x, y, z?, yaw? }`, `mapId` required with it), or both. `recall(q, { within: 'room:B' })`
keeps memories whose path contains those whole segments; `near: { mapId, frame?, pose, radius }`
keeps those within `radius` metres on the same map and frame. Both filter before ranking and
`limit`, and compose with the time modes. Recalled memories carry `place`, `why.placePath` and
`why.distanceM`. `frame: 'odom'` is refused. In cloud mode all three are `refused`, reason
`local-only`, before anything is sent (until Oort Cloud holds places).

<!-- example: examples/src/spatial.ts -->

```ts
import { createOort, type Place } from 'oortmem';

// A robot's memory of a site: each fact is remembered with where it was seen. Places are kept by
// the local engine (0.9.0 or newer); Oort Cloud refuses them until it holds places too.
await using oort = await createOort({ mode: 'local' });

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

## Memory links (local mode)

`link(from, to)` says two memories belong together; `unlink` removes it, or blocks a pair that was
not linked. Both memories must be ones the handle writes, in the same Planet or Star: any other
pair rejects with `OortNotFoundError`, like a missing id. From the SDK a link is always asserted
by `agent`. Recall does not use links yet. In cloud mode both reject (`refused`, `local-only`).

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

## Stability

Before 1.0, a breaking change to anything not marked `@experimental` lands only in a minor
release (0.6 to 0.7). `@experimental`, and free to change in any minor: `oortmem/ai-sdk`,
`RecalledMemory.why` and `JudgeResult.decisions`. New options, result fields, `reason` strings
and warnings are additive and can arrive in any release.
