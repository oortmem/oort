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
| `remember(facts, { type? })`                      | `RememberResult`                    | yes                                                               |
| `forget(id, { everywhere? })`                     | `ForgetResult`                      | yes (`everywhere`: cloud only)                                    |
| `pin(id)` / `unpin(id)`                           | `PinResult`                         | yes (`changed: null`)                                             |
| `recent({ since?, limit? })`                      | `{ memories, warnings }`            | yes                                                               |
| `explain(id)`                                     | `Explanation`                       | yes                                                               |
| `whoami()`                                        | `Whoami`                            | yes                                                               |
| `judge.record(input)`                             | `RecordJudgmentView`                | `refused`                                                         |
| `judge.apply(item, opts?)`                        | `JudgeResult`                       | `refused`                                                         |
| `judge.list({ domain?, by?, all?, limit? })`      | `{ judgments }`                     | `refused`                                                         |
| `judge.confirm(id)`                               | `{ id, changed }` (expert role)     | `refused`                                                         |
| `consolidate({ budgetMs?, signal? })`             | `ConsolidateResult`                 | `refused`                                                         |
| `scoped({ user?, project?, agent?, judgeRole? })` | a new handle                        | `project`, `agent` only in 0.7.0 (`user`: after it, a server key) |
| `endUsers.erase(user)`                            | `EndUserErasure`                    | 0.8.0, a server key                                               |
| `endUsers.count()`                                | `EndUserCount`                      | 0.8.0, a server key                                               |
| `close()`, `[Symbol.asyncDispose]()`              | `void`                              |                                                                   |
| `formatForPrompt(result, { budgetChars? })`       | `string` (a function, not a method) | both                                                              |

**`recall` options.** `limit` (1 to 50, default 10), `mode` (`current`, `as-of`, `history`,
`known-at`), `asOf` (valid time), `knownAt` (transaction time), `include` (narrows the levels
read: `self`, `planet`, `star`, `constellation`, `galaxy`), `budgetChars` (the default block size
for `formatForPrompt`), `includeWithdrawn`, `speed` (`full`: embed and rerank; `fast`: no rerank;
`lexical`: no model call), `inferTime` (default true: "on 2 April" picks as-of) and `signal`.
`as-of` needs `asOf`, `known-at` needs `knownAt`, and `asOf` together with `knownAt` is a usage
error.

**A `Turn`** for `observe` is `{ user, assistant }`, plus optional `tools` (tool-call summaries),
`at`, `sessionId` and `turnRef`. `turnRef` is deduplicated by Oort Cloud only (it answers
`duplicate: true`); locally a retry may write twice.

**Results.** Every memory is a `MemoryView`: `id`, `text` (scrubbed of secrets again on the way
out), `type`, `tier`, `pinned`, `status`, `validFrom`, `validTo`, `recordedAt`, `updatedAt`,
`entities`, `origin` and, for a judgment, `judgment`. A `RecalledMemory` adds `score`
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

## Stability

Before 1.0, a breaking change to anything not marked `@experimental` lands only in a minor
release (0.6 to 0.7). `@experimental`, and free to change in any minor: `oortmem/ai-sdk`,
`RecalledMemory.why` and `JudgeResult.decisions`. New options, result fields, `reason` strings
and warnings are additive and can arrive in any release.
