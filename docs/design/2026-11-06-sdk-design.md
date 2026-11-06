# SDKs: `createOort()` for TypeScript and `Oort` for Python, one API shape

Date: 2026-11-06. Status: proposed design, for review before 0.6.0. Issues: CON-108 (this spec),
CON-24 (Python client), CON-107 (the `oort.v1` contract), CON-84 (spatial `Place`), CON-92 (end
users, B2B2C). Releases: **0.6.0** (TypeScript SDK, before the 18 November launch) and **0.7.0**
(native Python client, about 25 November).

This spec is about the developer surface only. It changes no ranking, write-path or storage
behaviour, except where a section says so (each change is listed in §12).

## 0. Decisions in brief

1. **One API, four transports.** TypeScript runs the engine in-process (local) or calls Oort
   Cloud over HTTPS. Python calls `oort serve` over HTTP (a Unix socket on a laptop, TCP with a
   bearer token in a VPC) or Oort Cloud over HTTPS. TypeScript can also call `oort serve`
   (`mode: 'remote'`, 0.7.0). Every method has the same name, arguments, result fields and error
   codes on every transport.
2. **New package `@oortmem/sdk`.** It holds the facade and the wiring that today lives in
   `packages/cli/src` (wire, credentials, keychain, relay, cloud client, local-model loader).
   `oortmem` re-exports it from an `exports` map, keeps its `bin`, and the CLI becomes a
   consumer of the SDK.
3. **ESM only, Node 22.15 or newer.** `require('oortmem')` still works through Node's
   `require(esm)`, because the library graph has no top-level await. That is tested.
4. **Errors are typed classes that carry the `oort.v1` code and the same `fix` as the CLI.**
   There are ten codes: CON-107's nine plus `refused`, which the `oort.v1` branch added. A
   `reason` field gives finer detail without growing the contract.
5. **An SDK caller is an agent.** Judgments it records are unconfirmed (`via: 'sdk-agent'`),
   allowed only for experts in `judge.experts`, and count against the same daily cap as MCP.
   Expert mode is an explicit construction option. Model-facing tools always run as an agent.
6. **Scope is fixed per handle.** No method takes an org, user, agent or project. `scoped()`
   derives a handle for another user or project from trusted host code. `include` can only
   narrow what the handle reads.
7. **Python ships with no runtime dependencies** (standard library only) and needs Python 3.10
   or newer. `AsyncOort` mirrors `Oort`.
8. **`oort serve` gains a memory protocol.** It is HTTP/1.1 with JSON, on the same Unix socket
   (told apart from hook frames by the first byte), and on an opt-in TCP listener with a token,
   TLS and health endpoints. Its routes mirror Oort Cloud's `/v1`, so Python has one HTTP client
   for both.
9. **One JSON contract suite** under `contract/sdk/`, run by both SDKs against an in-process
   engine, a fixture daemon and the fake cloud.
10. **Self-hosting.** 0.6.0 supports the TypeScript library embedded in your service, and cloud
    mode in serverless functions. 0.7.0 adds service mode, a container image and
    AWS and GCP recipes. A Postgres store and a Helm chart come later. Integrations at
    launch: Vercel AI SDK, LangGraph.js and OpenAI Agents JS for TypeScript; LangGraph, OpenAI
    Agents and CrewAI for Python.

## 1. Goals and non-goals

Goals:

- G1. A five-line TypeScript example and a five-line Python example that recall and observe,
  both locally and against Oort Cloud.
- G2. Every memory feature from code: temporal recall, scopes, judgments (record, apply,
  confirm, list) and consolidation, with the CLI's safety rules.
- G3. Integration with agent frameworks and self-hosted harnesses on AWS and GCP without
  reading engine internals.
- G4. One contract that both SDKs pass, so they cannot drift apart.

Non-goals for 0.6 and 0.7: sharing to Constellations, invites and keys (these stay in the CLI and
the dashboard), judgment packs, import, eval and purge, a browser or edge-runtime build, and
spatial recall (reserved, §11).

## 2. Architecture

```
TypeScript app ──► @oortmem/sdk ──┬─ local:  @oortmem/core + store-sqlite, in-process
                                  ├─ cloud:  HTTPS ─► api.oortcloud.dev /v1
                                  └─ remote: HTTP  ─► oort serve (0.7.0)
Python app ──────► oortmem (py) ──┬─ local:  HTTP over the Unix socket ─► oort serve ─► core
                                  ├─ remote: HTTPS/HTTP over TCP + token ─► oort serve
                                  └─ cloud:  HTTPS ─► api.oortcloud.dev /v1
```

| Layer                                  | Owns                                                                                          | Stability                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@oortmem/core`                        | Engine building blocks (recall, observe, judgment, grants, scrub)                             | No promise: advanced use only                          |
| `@oortmem/sdk` (new)                   | `createOort`, option resolution, keys, wiring, transports, the error mapping, result views    | Semver (§6.4)                                          |
| `oortmem` (npm)                        | Re-exports `@oortmem/sdk`, ships the `oort` bin and the framework adapters (subpath exports) | Semver for the root export; adapters `@experimental` |
| `oort serve`                           | Hook frames (unchanged), and the HTTP memory protocol (§7.1)                                  | Protocol `v1`                                          |
| `oortmem` (PyPI)                       | `Oort`, `AsyncOort`, errors, integrations, and the existing `oort` launcher                  | Semver, in lockstep with npm                           |

The CLI, the MCP server and the hooks call `@oortmem/sdk` internals (`wireEngine`) instead of
`packages/cli/src/wire.ts`. Every surface then shares one wiring path, so an engine-rule fix
reaches all of them at once.

## 3. API surface

### 3.1 Construction and configuration

TypeScript:

```ts
import { createOort } from 'oortmem';

const oort = await createOort(); // what `oort setup` chose on this machine
const cloud = await createOort({ mode: 'cloud' }); // the Oort key from the env or the keychain
const mine = await createOort({ mode: 'local', keys: { voyage, typesafe, anthropic } });
const offline = await createOort({ config: { embed: { provider: 'local' }, rerank: { provider: 'local' } } });
await using svc = await createOort({ mode: 'remote', url: 'https://oort.internal:7807' }); // 0.7.0

export function createOort(options?: OortOptions): Promise<Oort>;
```

Python:

```python
from oortmem import Oort, AsyncOort

oort = Oort()                                   # local through oort serve, or cloud, as `oort setup` chose
cloud = Oort(mode="cloud")                      # no Node needed
svc = Oort(mode="remote", url="https://oort.internal:7807", token=os.environ["OORT_SERVE_TOKEN"])
async with AsyncOort(mode="cloud") as aoort: ...
```

`createOort` is async because a local engine opens SQLite and reads key sources. `Oort(...)` does
no I/O: Python connects on the first call. Neither makes a network request at construction.

| Option (TS / Python)          | Type                                                  | Modes                         | Default                                                                         |
| ----------------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `mode`                        | `'auto' \| 'local' \| 'cloud' \| 'remote'`            | all                           | `'auto'`: the store in `$OORT_HOME/cloud.json` (as the CLI), else `local`       |
| `home`                        | `string`                                              | local, auto                   | `OORT_HOME`, else `~/.oort`                                                     |
| `cwd`                         | `string`                                              | local, cloud                  | `process.cwd()` / `os.getcwd()`; used only to find the project                  |
| `project`                     | `string \| null`                                      | all                           | derived from `cwd` (§3.1.2); `null` reads and writes global memories only       |
| `agent`                       | `string`                                              | all                           | `OORT_AGENT`, else anonymous (the Planet only)                                  |
| `user`                        | `string`                                              | local, remote                 | `'self'` (§8.3)                                                                 |
| `org`                         | `string`                                              | local                         | `'local'`; in remote mode the token decides it                                  |
| `keys`                        | `{ voyage?, typesafe?, anthropic?, oort? }`           | TS local; TS and Py cloud (`oort` / `api_key`) | none                                                                            |
| `keySources` / `key_sources`  | `('explicit' \| 'env' \| 'keychain')[]`               | local, cloud                  | all three; `keychain` is dropped when `OORT_NO_KEYCHAIN=1`                      |
| `config`                      | deep partial of the home config                       | TS local                      | none; laid over the resolved config (§3.1.3)                                    |
| `url`                         | `string`                                              | cloud, remote                 | cloud: `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`; remote: required     |
| `token`                       | `string`                                              | remote                        | `OORT_SERVE_TOKEN`                                                              |
| `judge`                       | `{ role: 'agent' \| 'expert', operator?: string }`    | all                           | `{ role: 'agent' }` (§5.3). Python: `judge_role=`, `operator=`                  |
| `harness`                     | `string`                                              | all                           | `'sdk'`, recorded in `source.harness`                                           |
| `timeoutMs` / `timeout` (s)   | `number`                                              | cloud, remote, Py local       | 30 s per request                                                                |
| `migrate`                     | `boolean`                                             | TS local                      | `true` (as every CLI command). `false`: an older store is refused with fix `oort doctor` |
| `autostart`                   | `boolean`                                             | Py local                      | `True` (§7.1.6)                                                                 |
| `env`                         | `Record<string, string \| undefined>`                 | all                           | `process.env` / `os.environ`                                                    |
| `fetch`                       | `typeof fetch`                                        | TS cloud, remote              | global `fetch`, or the keep-alive pool for long-lived processes                |

A combination that a mode does not take (for example `token` with `mode: 'local'`) throws
`OortUsageError` at construction. It is never silently ignored.

**Asymmetry, on purpose.** Python local mode runs the engine inside `oort serve`, which reads its
own keys and config. So Python takes no `keys` (except the Oort key for cloud) and no `config`
overlay in local mode. Passing either is a usage error that names the daemon's environment and
`oort keys set` as the fix.

#### 3.1.1 Key resolution

For each role (embed, rerank, decide, write) the first key found wins. The order matches the CLI
(`credentials.ts`), with explicit keys placed first:

| Order | Source                                                                                    | Notes                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1     | `keys.<vendor>` (explicit)                                                                | Held in memory only. Never written to disk, logged or put in an error.                                                       |
| 2     | `VOYAGE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` (env, non-empty)                |                                                                                                                              |
| 3     | Keychain item `oort.<vendor>`, or `credentials.json` (mode 600) where there is no Keychain | Skipped with `OORT_NO_KEYCHAIN=1` or when `keySources` leaves out `keychain`. Servers set it (§8.6).                        |
| 4     | The Oort key (`keys.oort`, `OORT_API_KEY`, Keychain `oort.oort`)                          | Routes the role through the Oort Pro relay. It is metered (§5.5), and `whoami().routes` reports it.                          |
| 5     | `local` provider in config                                                                | `oort models pull` models. No key, no network.                                                                               |
| —     | none                                                                                      | The role is unavailable. Recall degrades (`lexical-only` warning). A write throws `OortNeedsKeyError`.                       |

Cloud mode needs only the Oort key, found by steps 1 to 3 for `oort`. Without it, the SDK throws
`OortNeedsLoginError` (fix `oort login`).

#### 3.1.2 Project resolution

| Input                    | Project id                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project: 'acme-web'`    | `cfg:acme-web`. The same namespace as `oort project link`, because the host's own code is trusted to choose.                                                   |
| `project: null`          | No project: global memories only.                                                                                                                              |
| omitted                  | `resolveProject(cwd, home)`, exactly as the CLI does. A repository's `oort.config.json` `project.id` counts only with a trust link, and otherwise gives the `project-id-untrusted` warning. |

Python cloud mode has no Node, so it ports `projectIdFor` (`<basename>-<sha256(main root)[:8]>`,
worktrees resolved to the main checkout, and links from `project-links.json`). On macOS it
canonicalises case with `fcntl.F_GETPATH`, matching Node's `realpathSync.native`. Shared vectors
in the contract suite pin the result (§9). Services should pass `project` explicitly.

#### 3.1.3 Config

TypeScript local mode resolves config as the CLI does: the home `config.json`, then the
project's `oort.config.json`, with `serve` and `judge` read from the home config only. Then
`options.config` is laid on top. The overlay may set `judge` (the host's code is the operator),
but it may not set `serve`. `projectConfig: false` skips the repository file. That is what a
server wants when its own working directory happens to be a git checkout.

### 3.2 Result types (TypeScript; Python mirrors them as frozen dataclasses)

Field names are camelCase in TypeScript and on the wire, and snake_case in Python. The mapping is
mechanical (`validFrom` → `valid_from`). Ids are always full ids, and times are ISO 8601 strings
(`datetime` in Python).

```ts
export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'preference' | 'judgment';
export type MemoryStatus = 'current' | 'superseded' | 'corrected' | 'expired' | 'not-yet-valid' | 'withdrawn';
export type IncludeLevel = 'self' | 'planet' | 'star' | 'constellation' | 'galaxy';
export type RecallMode = 'current' | 'as-of' | 'history' | 'known-at';

export interface MemoryView {
  id: string;
  text: string; // scrubbed again on read (§5.1)
  type: MemoryType;
  tier: 'hot' | 'warm' | 'cold';
  pinned: boolean;
  status: MemoryStatus;
  validFrom: string;
  validTo: string | null;
  recordedAt: string; // createdAt: transaction time
  updatedAt: string;
  entities: string[];
  origin?: { level: IncludeLevel; space: string; author?: string; overriddenBy?: string };
  judgment?: JudgmentView;
  /** @experimental Reserved for CON-84. Never set before spatial memory ships. */
  place?: Place;
}

export interface RecalledMemory extends MemoryView {
  score: number; // fused score; comparable within one result only
  stale?: true; // a volatile fact nobody confirmed within recall.staleAfterDays
  /** @experimental Diagnostic; fields may change in a minor release. */
  why: { lexicalRank?: number; denseRank?: number; reranked?: number; coverage: number; dense?: number; activation: number; chain?: true };
}

export interface Warning { code: string; message: string } // the oort.v1 warning codes

export interface RecallResult {
  memories: RecalledMemory[];
  abstained: boolean; // candidates were found, none relevant: answer without memory
  temporal: { mode: RecallMode; asOf?: string; knownAt?: string; inferred: boolean };
  read: string[]; // spaces read, as labels: "your Planet", "Star cursor", "Constellation web"
  degraded: string[]; // core's Degradation values, plus 'hive-unavailable' in cloud
  warnings: Warning[];
}

export type Outcome = 'added' | 'reinforced' | 'updated' | 'superseded' | 'corrected' | 'skipped';
export interface ObserveResult {
  outcome: Outcome; // the turn's headline
  memories: { outcome: Outcome; id?: string; supersedes?: string; reason?: string }[];
  counts: Partial<Record<Outcome, number>>;
  duplicate?: true; // the same turnRef was saved before
  warnings: Warning[];
}
export interface RememberResult { results: { fact: number; outcome: Outcome; id?: string; supersedes?: string; reason?: string }[]; warnings: Warning[] }

export interface Explanation {
  memory: MemoryView & { salience: number; activation: number; source: string };
  decisions: { stage: string; question: string; answer: string; probability: number }[];
  chain: { id: string; text: string; validFrom: string; validTo: string | null; endReason: 'superseded' | 'corrected' | 'expired' | null }[];
  hiddenLinks: number; // links into memories this handle cannot read
}

export interface Whoami {
  mode: 'local' | 'cloud' | 'remote';
  account: string | null;
  agent: string | null;
  project: string | null;
  user: string;
  reads: string[];
  writesTo: string;
  version: string;
  routes: Record<'embed' | 'rerank' | 'decide' | 'write', 'own-key' | 'oort-pro' | 'local' | 'cloud' | 'missing'>;
}
```

### 3.3 Methods

| TypeScript                                                       | Python (`Oort`; `AsyncOort` has the same with `async def`)                          | Returns                                     | Local | Cloud                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- | ----- | ---------------------------- |
| `recall(query: string, opts?: RecallOptions)`                    | `recall(query, *, limit=10, mode=None, as_of=None, known_at=None, include=None, budget_chars=None, include_withdrawn=False, speed="full", infer_time=True)` | `RecallResult`                              | yes   | yes                          |
| `observe(turn: Turn, opts?: { signal? })`                        | `observe(turn: Turn \| Mapping)`                                                    | `ObserveResult`                             | yes   | yes                          |
| `remember(facts: string \| readonly string[], opts?: { type? })` | `remember(facts, *, type=None)`                                                     | `RememberResult`                            | yes   | yes                          |
| `forget(id: string, opts?: { everywhere?: boolean })`            | `forget(id, *, everywhere=False)`                                                   | `{ forgotten: string; withdrawn?: string[] }` | yes   | yes (`everywhere`: cloud only) |
| `pin(id)` / `unpin(id)`                                          | `pin(id)` / `unpin(id)`                                                             | `{ id; pinned; changed }`                   | yes   | yes                          |
| `explain(id)`                                                    | `explain(id)`                                                                       | `Explanation`                               | yes   | yes                          |
| `recent(opts?: { since?: string \| Date; limit?: number })`      | `recent(*, since=None, limit=20)`                                                   | `{ memories: MemoryView[] }`                | yes   | yes                          |
| `judge.record(input: JudgmentInput)`                             | `judge.record(*, subject, verdict, reason, domain, by, ref=None, verdicts=None, criteria=None, decided_at=None)` | `RecordJudgmentResult`                      | yes   | `refused`                    |
| `judge.apply(item: string \| JudgeItem, opts?: JudgeOptions)`    | `judge.apply(item, *, details=None, domain=None, by=None, limit=5, threshold=0.7, include_imported=False, include_agent_recorded=False)` | `JudgeResult`                               | yes   | `refused`                    |
| `judge.confirm(id)`                                              | `judge.confirm(id)`                                                                 | `{ id; changed }`                           | expert | `refused`                   |
| `judge.list(opts?: { domain?; by?; all?; limit? })`              | `judge.list(*, domain=None, by=None, all=False, limit=100)`                         | `{ judgments: JudgmentView[] }`             | yes   | `refused`                    |
| `consolidate(opts?: { budgetMs?; signal? })`                     | `consolidate(*, budget_ms=None)`                                                    | `ConsolidateResult`                         | yes   | `refused` (the cloud consolidates) |
| `forgetAll(opts: { confirm: 'forget-all' })` `@experimental`     | `forget_all(*, confirm)`                                                            | `{ forgotten: number }`                     | 0.7.0 | `refused`                    |
| `whoami()`                                                       | `whoami()`                                                                          | `Whoami`                                    | yes   | yes                          |
| `scoped(s: { user?; project?; agent?; judgeRole?: 'agent' })`    | `scoped(*, user=None, project=None, agent=None, judge_role=None)`                   | a new handle                                | yes   | `project`, `agent` only      |
| `close()`, `[Symbol.asyncDispose]()`                             | `close()`, `__enter__`/`__exit__` (`__aenter__`/`__aexit__`)                        | `void`                                      |       |                              |
| `formatForPrompt(r: RecallResult, opts?: { budgetChars? })` (function) | `format_for_prompt(r, *, budget_chars=None)`                                  | `string`                                    | both  | both                         |

```ts
export interface RecallOptions {
  limit?: number; // 1–50, default 10
  mode?: RecallMode;
  asOf?: string | Date; // valid time
  knownAt?: string | Date; // transaction time
  include?: IncludeLevel[]; // narrows; a level the handle cannot read → OortRefusedError
  budgetChars?: number; // cap on returned text, as the hooks use
  includeWithdrawn?: boolean; // withdrawn judgments too
  speed?: 'full' | 'fast' | 'lexical'; // full: embed + rerank; fast: no rerank; lexical: no model call
  inferTime?: boolean; // default true: "on 2 April" picks as-of, as in the CLI and MCP
  signal?: AbortSignal;
}

export interface Turn {
  user: string;
  assistant: string;
  tools?: string[]; // tool-call summaries (exit codes, file edits), at most 16 × 512 bytes
  at?: string | Date; // default now
  sessionId?: string;
  turnRef?: string; // makes a retry safe: the same turn is saved once
  /** @experimental Reserved for CON-84. */
  place?: Place;
}

export interface JudgmentInput {
  subject: string; ref?: string; verdict: string; verdicts?: readonly string[];
  reason: string; criteria?: readonly string[]; domain: string; by: string; decidedAt?: string | Date;
}
export interface JudgeItem { summary: string; details?: string; ref?: string; domain?: string; by?: string }
export interface JudgeOptions { limit?: number; threshold?: number; minSimilarity?: number; minAgreement?: number; includeImported?: boolean; includeAgentRecorded?: boolean }
```

`RecordJudgmentResult`, `JudgeResult`, `JudgmentView` and `ConsolidateResult` are core's types
(`judgment.ts`, `consolidate.ts`) restricted to their documented fields. Every `Memory` becomes
an `id`, every `Int8Array` is dropped, and `JudgeResult.decisions` is marked `@experimental`.
`JudgmentView` adds `status`, `confirmed: boolean` and `agentRecorded: boolean`.

### 3.4 Semantics worth pinning down

- **Temporal rules** match the MCP `viewOf` exactly. `mode: 'as-of'` needs `asOf`, and
  `'known-at'` needs `knownAt`. `'current'` and `'history'` take neither. `asOf` together with
  `knownAt` is a usage error. Without `mode`, a single date picks the view. Without either,
  `inferTime` decides.
- **Ids.** Every id argument takes a full id or a unique prefix of at least 8 characters (Oort
  Cloud's `MIN_ID_PREFIX`). Locally that is stricter than the CLI's any-length prefix, so behaviour
  is the same on every transport. Several matches throw `OortAmbiguousIdError`. An id this handle
  cannot read throws `OortNotFoundError`, indistinguishable from an unknown id (store contract).
- **`remember`** frames each fact as a user statement and runs it through the write path, as the
  MCP tool and the cloud backend do (`remember.ts`). Up to 5 facts per call, each at most 500
  characters (the MCP constants). Raising either limit later is not a breaking change.
- **`observe`** is the full write path: scrub, gate, writer, reconcile. It can take seconds. In
  a request handler, call it after answering the user. In a serverless function, await it before
  returning, because the runtime freezes after the response.
- **Star agents in cloud mode.** An agent configured as a Star cannot write in cloud mode, the
  same as `refuseStarInCloud`. `observe`, `remember`, `forget` and `pin` throw `OortRefusedError`.
- **`scoped()`** shares the engine and its connections and returns a cheap immutable handle.
  `child.close()` does nothing. `root.close()` closes every handle derived from it. Calling any
  handle after that throws `OortUsageError` with reason `closed`. `scoped()` can switch the judge
  role from expert to agent, never the other way.
- **Concurrency.** One handle is safe for concurrent calls. Locally, writes wait on SQLite's lock
  (`busyTimeoutMs` 5000) and then throw `OortInternalError` with reason `store-busy` and
  `retryable: true`.
- **Lifecycle.** TypeScript loads adapters lazily, per role, on first use: the first recall loads
  embed and rerank, and the first write loads decide and write. A process that only recalls never
  imports the writer's dependencies. That keeps cold starts short (§8.1). `close()` is idempotent
  and closes the store, the keep-alive pool and any local model sessions.

### 3.5 Limits (the same on every transport)

| Input                 | Limit                                         | Source                                      |
| --------------------- | --------------------------------------------- | ------------------------------------------- |
| `recall` query        | 2,048 UTF-8 bytes                             | cloud `recallTextBytes`                     |
| `recall` `limit`      | 1 to 50                                       | cloud `recallK`                             |
| `observe` turn        | 128 KiB in total; the engine keeps 32 KiB after scrubbing | cloud `observeBytes`, core `cap.ts` |
| `tools` summaries     | 16 × 512 bytes                                | core `cap.ts`                               |
| `remember`            | 5 facts × 500 characters                      | `@oortmem/mcp`                              |
| Judgment fields       | `JUDGMENT_LIMITS`                             | core `judgment.ts`                          |
| `recent` `limit`      | 1 to 100                                      | cloud `listLimit`                           |

Anything over a limit throws `OortUsageError` before any I/O, naming the field but never its
value.

## 4. Errors

```ts
export type OortErrorCode =
  | 'usage' | 'not-found' | 'ambiguous-id' | 'needs-key' | 'needs-login'
  | 'needs-confirmation' | 'cloud-only' | 'network' | 'refused' | 'internal';

export class OortError extends Error {
  readonly code: OortErrorCode;
  readonly fix: string | null; // the oort.v1 fix: a runnable `oort …` command, or null
  readonly reason?: string; // finer detail, stable strings (below)
  readonly status?: number; // HTTP status, for cloud and remote
  readonly retryable: boolean;
  // `cause` holds the original error (never a key or a request body)
}
export class OortUsageError extends OortError {}            // code 'usage'
export class OortNotFoundError extends OortError {}         // 'not-found'
export class OortAmbiguousIdError extends OortError {}      // 'ambiguous-id'
export class OortNeedsKeyError extends OortError { readonly role: 'embed' | 'rerank' | 'decide' | 'write'; readonly envVar: string }
export class OortNeedsLoginError extends OortError {}       // 'needs-login'
export class OortNeedsConfirmationError extends OortError {} // 'needs-confirmation'
export class OortCloudOnlyError extends OortError {}        // 'cloud-only'
export class OortNetworkError extends OortError {}          // 'network', retryable
export class OortRefusedError extends OortError {}          // 'refused'
export class OortInternalError extends OortError {}         // 'internal'
```

Python uses the same class names, subclassing `OortError(Exception)`, with the attributes
`code`, `fix`, `reason`, `status` and `retryable`. Use `isinstance` or match on `code`.

`refused` is the tenth code. It is not in CON-107's first draft, but the `oort.v1` branch added
it (docs/cli.md, "JSON output"). Without it, a plan limit or a role rule would read as `usage` and
tell an agent to change its arguments.

**Mapping.** This is the same table as the CLI's `describeError`, moved into `@oortmem/sdk` so
the CLI and both SDKs share it.

| Source                                                           | Code                                                         | `reason`                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Option or argument validation, `JudgmentInputError`, `ExportFormatError` | `usage`                                              | `invalid-argument`                          |
| `EmbedderMismatchError`                                          | `usage` (fix `oort reembed`)                                 | `embedder-mismatch`                         |
| `MissingCredentialError`, missing role for a write               | `needs-key` (fix `oort models pull` or `oort keys set <p>`)  | `missing-key`                               |
| No Oort key, cloud 401, relay 401, service token rejected        | `needs-login` (fix `oort login`; for a token: none)          | `no-key`, `key-rejected`, `token-rejected`  |
| `GrantError`, `ScopeDeniedError`, Star agent writing in cloud    | `refused`                                                    | `scope-denied`, `star-in-cloud`             |
| Judgments, `consolidate` or `forgetAll` in cloud mode            | `refused`                                                    | `local-only`                                |
| Agent-role judgment rules (§5.3)                                 | `refused`                                                    | `experts-not-listed`, `not-an-expert`, `daily-limit`, `expert-only` |
| Cloud 402, 403 (`cloud_not_enabled`, `hive_not_enabled`, other), 429 | `refused`                                                | `payment-required`, `not-enabled`, `hive-not-enabled`, `rate-limit` |
| Cloud 400, 413                                                   | `usage`                                                      | `bad-request`, `too-large`                  |
| Cloud 404, store miss                                            | `not-found`                                                  |                                             |
| Cloud 409 `ambiguous`, local prefix match > 1                    | `ambiguous-id`                                               |                                             |
| Cloud 409 `preview_required`, `findings_unacknowledged`; `forgetAll` without `confirm` | `needs-confirmation`                   |                                             |
| A cloud-only option locally (`forget({ everywhere })`, `include: ['constellation']`) | `cloud-only` (fix `oort cloud use`)      |                                             |
| Connection refused, reset, DNS, timeout; cloud 5xx               | `network`, retryable                                         | `unreachable`, `timeout`, `busy`            |
| `StoreMigrationRequiredError` with `migrate: false`              | `refused` (fix `oort doctor`)                                | `migration-required`                        |
| SQLite busy                                                      | `internal`, retryable                                        | `store-busy`                                |
| Python local: no Node, or the daemon is too old                  | `usage`                                                      | `node-missing`, `daemon-outdated`           |
| `place`, `near` or `within` before CON-84                        | `usage`                                                      | `spatial-unavailable`                       |
| Anything else                                                    | `internal`                                                   | none                                        |

A **degraded recall is not an error.** It returns results and fills `degraded` and `warnings`
with the codes `oort.v1` uses (`lexical-only`, `recall-degraded`, `time-mode-unreported`). The
SDK never prompts, so the only `needs-confirmation` cases are those the server or `forgetAll`
raise.

## 5. Safety parity with the CLI

### 5.1 Secrets

- **Locally**, the engine scrubs: `observe` drops a turn that holds a secret
  (`scrubObservation`), `recall` scrubs the query before any embedder or reranker sees it, and
  judgments redact secrets from their text. The SDK passes data straight to core, so it inherits
  all of this.
- **On read**, every text field the SDK returns goes through `scrub()` again (the MCP server's
  `clean`). That catches memories stored before a rule existed.
- **In cloud mode**, TypeScript scrubs the turn, the facts and the query on the client before
  sending them. The code is the same, and it costs nothing. Oort Cloud scrubs again before
  anything is stored or reaches a model.
- **Python** does not port the scrubber in 0.7.0. Secrets are still never *stored* or *sent to a
  model vendor* in any mode, because scrubbing runs wherever the engine runs (in-process, in `oort
  serve`, or in Oort Cloud). A secret in a Python cloud call does reach Oort Cloud over TLS before
  it is dropped. The contract suite asserts, for both SDKs and every transport, that no fixture
  secret ever comes back in a result (§9). Client-side scrubbing for Python is open question Q3.

### 5.2 Output escaping

The SDK returns data, not rendered text. Nothing in it is HTML- or terminal-escaped, because the
caller decides where text goes. Two exceptions:

- `formatForPrompt` / `format_for_prompt` builds the same `<oort-memory>` block the hooks inject.
  It escapes block tags (`escapeBlockTags`) and space labels (`escapeLabelText`), so a stored
  memory cannot close the block or forge a label. Adapters (§10) inject only through it. Python
  ports these two functions, about 20 lines, checked by contract cases.
- Expert ids in agent-facing strings go through `safeExpertId`, as in the MCP server.

Judgment text fields already refuse control, bidi and invisible characters on the way in (core).

### 5.3 Judgment expert rules

| Rule                                  | `judge.role: 'agent'` (default)                                                                                          | `judge.role: 'expert'`                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Who may be named in `by`              | Only experts listed in `judge.experts` in the home config (or the TS `config` overlay). None listed: `refused`, `experts-not-listed`. | Anyone, as `oort judge record --by` allows                                             |
| Daily cap                             | 50 a day per Oort home, shared with MCP (`MCP_JUDGMENTS_PER_DAY`, the same locked counter file, renamed in code to "agent-recorded judgments") | None                                                                                   |
| Stored as                             | `via: 'sdk-agent'`: agent-recorded and unconfirmed. Judging leaves it out unless `includeAgentRecorded`. It never corrects a person's judgment. | `via: 'sdk'`: counts as a person's, which is what `'sdk'` means in core today          |
| `judge.confirm`                       | `refused`, `expert-only`                                                                                                 | Allowed. Recorded as `confirmed: { by: operator }`                                     |
| Over the TCP service listener (§8.4)  | Allowed                                                                                                                  | Refused. A service token is not a person.                                              |
| Through framework tools (§10)         | Always                                                                                                                   | Never. The adapters call `scoped({ judgeRole: 'agent' })`.                             |

`operator` defaults to `judge.operator` in the home config, else `local-user`.

**Core change (required, 0.6.0).** Add `'sdk-agent'` to `JudgmentVia`. Make
`isUnconfirmedAgentJudgment` true for `via` in `{ 'mcp', 'sdk-agent' }` with no `confirmed`, and
let the pack parser accept the new value. Older readers map an unknown `via` to `'pack'`, which
judging already leaves out by default, so packs stay safe both ways. `'sdk'` keeps its current
meaning, so no stored judgment changes meaning.

**Why the agent default.** The SDK caller is usually code that an LLM drives. The rule protects
the expert's record from the model, not from the developer, so expert mode stays one explicit
option for host code paths where a person really decided (a review UI, an import job).

### 5.4 Grants and scopes

- Each handle has one principal: `org`, `user` (customerId), `agent` and `project`. It is fixed
  at construction or by `scoped()`. No method takes a scope argument. Reads and writes go through
  `localGrant` with the agent's home, so the store enforces isolation, including another agent's
  Star (store contract, "What a store guarantees").
- `include` is intersected with the grant. A level outside it throws `OortRefusedError`
  (`ScopeDeniedError`), never a wider read.
- `agent` and `user` are validated (`isAgentId`, and for `user`
  `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`). Like agent ids, they are configuration, not
  authentication. Any code holding the root handle can derive any user's handle, so the trust
  boundary is the handle that host code passes to model-facing tools.
- Cloud mode: the Oort key's scope applies (a narrowed key reads only its Constellations), and
  `agent` reads only the Constellations that agent is attached to.
- Remote mode: the token fixes `org`. Requests name `user`, `project` and `agent` (§7.1.3).

### 5.5 Billing: which calls cost what

No model is called at construction, by `whoami`, or by any read of stored records. "Vendor"
below means your own key, billed by that vendor, or the Oort key through the Oort Pro relay,
metered against your Oort account. `whoami().routes` says which applies to each role.

| Call                                       | Local, own keys or Oort Pro relay                                                                                    | Local models only           | Cloud mode                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------- |
| `recall`                                   | Voyage embed (skipped on a cache hit or a confident lexical answer), Voyage rerank (skipped when confident, or with `speed: 'fast'`). `speed: 'lexical'`: none. | none                        | Metered Oort Cloud recall                          |
| `observe`                                  | TypeSafe gate, always. If the turn is kept: one Anthropic writer call, one batched Voyage embed, and one TypeSafe reconcile per fact (or one batched call) | Gate, writer and reconcile still need keys | Metered Oort Cloud observe                         |
| `remember`                                 | One `observe` per fact                                                                                               | as above                    | One metered observe per fact                       |
| `judge.record`                             | One Voyage embed                                                                                                     | none                        | `refused`                                          |
| `judge.apply`                              | One Voyage embed and one TypeSafe judge call                                                                         | TypeSafe judge only         | `refused`                                          |
| `forget`, `pin`, `unpin`, `explain`, `recent`, `judge.list`, `judge.confirm`, `consolidate`, `whoami` | none                                                                            | none                        | No model call. Reads and deletes are `billing: any` routes in the cloud contract (they work on every plan) |

The relay is used only when a role has no vendor key and an Oort key is present, as in the CLI.
`keySources: ['explicit']` turns off every implicit source, for hosts that want no surprises.

## 6. Packaging (TypeScript)

### 6.1 Packages and exports

New `packages/sdk` (`@oortmem/sdk`):

```json
{
  "name": "@oortmem/sdk",
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=22.15.0" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "dependencies": {
    "@oortmem/core": "workspace:*",
    "@oortmem/store-sqlite": "workspace:*",
    "@oortmem/embed-voyage": "workspace:*",
    "@oortmem/rerank-voyage": "workspace:*",
    "@oortmem/decide-jev": "workspace:*",
    "@oortmem/writer": "workspace:*",
    "undici": "7.30.1"
  },
  "peerDependencies": { "@oortmem/local-models": "workspace:^" },
  "peerDependenciesMeta": { "@oortmem/local-models": { "optional": true } }
}
```

These move from `packages/cli/src` into `packages/sdk/src`: `wire.ts` (as `wireEngine`, with
explicit `project`, `user` and `org`), `credentials.ts`, `keychain.ts`,
`credentials-file.ts`, `relay.ts`, `local-models.ts`, `embed-cache-disk.ts`, `cloud.ts`, `cloud-http.ts`, and the
error mapping from `output.ts`. `createHookLogger` stays in `@oortmem/claude-code`. The SDK takes
an optional logger and does not import it.

`packages/cli` (`oortmem`) gains:

```json
{
  "sideEffects": ["./dist/main.js"],
  "exports": {
    ".": { "types": "./dist/sdk.d.ts", "default": "./dist/sdk.js" },
    "./ai-sdk": { "types": "./dist/adapters/ai-sdk.d.ts", "default": "./dist/adapters/ai-sdk.js" },
    "./langgraph": { "types": "./dist/adapters/langgraph.d.ts", "default": "./dist/adapters/langgraph.js" },
    "./openai-agents": { "types": "./dist/adapters/openai-agents.d.ts", "default": "./dist/adapters/openai-agents.js" },
    "./package.json": "./package.json"
  },
  "bin": { "oort": "dist/main.js", "oortmem": "dist/main.js" },
  "peerDependencies": { "ai": "^7", "@langchain/langgraph": "*", "@openai/agents": "*" },
  "peerDependenciesMeta": { "ai": { "optional": true }, "@langchain/langgraph": { "optional": true }, "@openai/agents": { "optional": true } }
}
```

`dist/sdk.js` is `export * from '@oortmem/sdk'` and nothing more. Before release, each framework
peer's range is pinned to the major the adapter was tested on.

### 6.2 What a library user pulls in

| Concern                 | Decision                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load time               | The root export never imports `commander`, `@clack/prompts`, `@modelcontextprotocol/server`, `picocolors`, `smol-toml`, `jsonc-parser` or `@oortmem/claude-code`. A test walks the module graph of `import('oortmem')` and fails on any of them. |
| Install size            | `oortmem` still installs the CLI dependencies (they are small and pure JS). If that matters, use `@oortmem/sdk`, which has the same API minus the bin and the adapters.                                                          |
| Native modules          | `better-sqlite3` and `sqlite-vec` are installed (local is the default), but `@oortmem/store-sqlite` is imported only when a local engine opens. Cloud and remote mode never load a native module, which suits Lambda.             |
| Vendor SDKs             | `@typesafe-ai/sdk`, `ai` and `@ai-sdk/anthropic` are installed and dynamically imported on a role's first use, as `wire.ts` does today.                                                                                          |
| Tree-shaking            | `sideEffects: false` on `@oortmem/sdk` and on every engine package. Only `dist/main.js` (the bin) is marked as having effects. Adapters are subpath exports, so a bundler never sees a framework the app does not use.           |
| ESM / CJS               | ESM only. Node 22.12 and later load ESM from `require()`, and the floor is 22.15, so CJS apps can `require('oortmem')` as long as the graph has no top-level await. A CI test runs `require('oortmem')`. No dual build.             |
| Node floor              | 22.15.0 (`engines` on every package, as today). Bun and Deno are best effort, not tested.                                                                                                                                       |
| Types                   | Hand-written public types in `packages/sdk/src/types.ts`, not core's. Core's internals never leak into `.d.ts`, so core can change freely.                                                                                      |

### 6.3 `@oortmem/core`

`@oortmem/core` keeps its building-block exports for store authors and advanced users. Its README
says plainly that it has no stability promise and that apps should use `oortmem`.

### 6.4 Stability promise

- **Before 1.0:** a breaking change to anything not marked `@experimental` lands only in a minor
  release (0.6 → 0.7). It is listed under "Breaking" in the release notes, and where possible it
  is deprecated (a JSDoc `@deprecated` plus a one-time warning) for one minor first. A patch
  release only adds or fixes.
- **`@experimental`** (may change in any minor): `mode: 'remote'`, the three adapter subpaths,
  `Place` and every `place` field, `RecalledMemory.why`, `JudgeResult.decisions`, `forgetAll`,
  and the diagnostics channel payloads (§8.7). Python marks the same with a docstring line and
  `oortmem.experimental` re-exports.
- **Additive changes are always allowed.** That means new optional options, new result fields,
  new `reason` and warning strings, and higher limits. Callers must ignore unknown fields.
- **1.0** comes when both SDKs pass the shared suite and the stable surface has gone one minor
  without a breaking change.
- Python versions move with npm (0.7.x and 0.7.x), and the Python client accepts any daemon with
  protocol `v1` and version 0.7.0 or newer (§7.1.5).

## 7. Python

Package: `oortmem` on PyPI. It keeps the `oort` and `oortmem` console scripts (the launcher) and
adds:

```
oortmem/
  __init__.py        Oort, AsyncOort, format_for_prompt, errors, types
  _transport.py      HTTP over a Unix socket and over TCP/TLS (http.client, ssl, socket)
  _cloud.py          the Oort Cloud mapping (§7.2)
  _project.py        project id derivation (§3.1.2)
  _keys.py           Oort key lookup: explicit, env, credentials.json, macOS Keychain via /usr/bin/security
  _daemon.py         find, check and autostart oort serve (reuses cli.py's Node/npx resolution)
  types.py           frozen dataclasses (slots=True)
  errors.py
  integrations/langgraph.py, openai_agents.py, crewai.py   (import the framework lazily)
  py.typed
```

| Decision          | Choice                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies      | **None at runtime.** HTTP/1.1 over `http.client`, with a small subclass that connects over `AF_UNIX`, plus `ssl`, `json` and `dataclasses`. Extras install frameworks only: `oortmem[langgraph]`, `oortmem[openai-agents]`, `oortmem[crewai]`. |
| Async             | `AsyncOort` runs the sync client in `asyncio.to_thread`, with a bounded connection pool (default 8). Cancellation stops waiting but not the request in flight. A native async transport (an optional `httpx` extra) is open question Q5. |
| Python floor      | **3.10.** 3.9 is past end of life, and LangGraph and CrewAI need 3.10. The launcher keeps working on 3.9 for `oort` only: importing `Oort` on 3.9 raises a clear `ImportError`.                                               |
| Version lockstep  | `oortmem==0.7.x` launches or autostarts `oortmem@0.7.x` through npx when no `oort` is installed.                                                                                                                                |
| Typing            | Full annotations, `py.typed`, and `Literal` types for modes and codes. Results are dataclasses, inputs are keyword arguments (or a `Mapping` for `observe`).                                                                    |

### 7.1 Local transport: the memory protocol on `oort serve`

#### 7.1.1 Choice: HTTP on the existing socket, plus an opt-in TCP listener

`oort serve` today speaks length-prefixed JSON frames on a Unix socket for the hooks, with
methods `ping`, `status`, `stop`, `hook` and `recall`. The SDK protocol adds **HTTP/1.1 with
JSON** instead of more frame methods:

- **One protocol for every network shape.** The same routes serve a laptop (Unix socket), a
  sidecar or a VPC service (TCP), and they mirror Oort Cloud's `/v1`. So Python has one
  HTTP client, the TypeScript `remote` mode reuses the cloud client's code, and any language can
  call it with `curl --unix-socket`.
- **Hooks keep frames.** The hook path has a millisecond budget and loads no HTTP parser.
- **One socket.** A frame always starts with byte `0x00`, because its 4-byte big-endian length is
  at most 4 MiB. An HTTP request starts with an ASCII method letter. The daemon reads the first
  byte of each connection and hands it to the frame decoder or to `node:http`'s parser (by
  emitting the socket as a `connection` on an internal `http.Server`). There is no second socket
  file, and the directory and permission checks are unchanged.

#### 7.1.2 Routes

Every route answers in the `oort.v1` envelope: `{ schema: "oort.v1", ok: true, data, warnings }`
or `{ schema: "oort.v1", ok: false, error: { code, message, fix } }`. Bodies are checked against
strict zod schemas: an unknown field is refused, and `place` is a reserved field (§11).

| Method and path                                       | SDK call                   | Oort Cloud equivalent                       |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------- |
| `GET /v1/health`                                      | (handshake)                | `GET /health`                               |
| `GET /v1/whoami`                                      | `whoami`                   | `GET /v1/whoami`                            |
| `POST /v1/recall`                                     | `recall`                   | `POST /v1/recall` (`limit` → `k`)           |
| `POST /v1/observe`                                    | `observe`                  | `POST /v1/observe`                          |
| `POST /v1/remember`                                   | `remember`                 | none: the client maps it to `observe` (§7.2) |
| `GET /v1/memories?since=&limit=`                      | `recent`                   | `GET /v1/memories`                          |
| `GET /v1/memories/:id`                                | (`explain` uses it)        | `GET /v1/memories/:id`                      |
| `GET /v1/memories/:id/explain`                        | `explain`                  | none: the client builds it from `GET`       |
| `DELETE /v1/memories/:id`                             | `forget`                   | `DELETE /v1/memories/:id`                   |
| `POST /v1/memories/:id/pin`, `/unpin`                 | `pin`, `unpin`             | same                                        |
| `POST /v1/judgments`                                  | `judge.record`             | none (`refused`)                            |
| `POST /v1/judgments/apply`                            | `judge.apply`              | none                                        |
| `POST /v1/judgments/:id/confirm`                      | `judge.confirm`            | none                                        |
| `GET /v1/judgments?domain=&by=&all=&limit=`           | `judge.list`               | none                                        |
| `POST /v1/consolidate`                                | `consolidate`              | none                                        |
| `POST /v1/forget-all`                                 | `forgetAll`                | none                                        |
| `GET /healthz`, `GET /readyz`, `GET /metrics`         | (operations, §8.4)         |                                             |

HTTP status: 200 on success. Errors map 400 → `usage`, 401 → `needs-login`, 403 → `refused` or
`cloud-only`, 404 → `not-found`, 409 → `ambiguous-id` or `needs-confirmation`, 413 → `usage`,
503 → `network` (with `reason: busy` or `shutting-down`), and 500 → `internal`. The client
always trusts the envelope's `code` over the status.

#### 7.1.3 Scope on each request

The scope travels in headers, so every route carries it the same way:

| Header                     | Meaning                                                                                                    | Unix socket                    | TCP listener                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `Oort-Cwd`                 | Absolute path used to find the project, as the hook's `cwd`. Only selects; never read as a file to load.   | yes                            | refused                                          |
| `Oort-Project`             | An explicit project id (becomes `cfg:<id>`), or `-` for none                                               | yes                            | yes (required, `-` allowed)                      |
| `Oort-Agent`               | Agent id                                                                                                   | yes                            | yes                                              |
| `Oort-User`                | End user (customerId)                                                                                      | yes                            | yes                                              |
| `Oort-Judge-Role`          | `agent` or `expert`, plus `Oort-Operator`                                                                  | yes                            | `agent` only                                     |
| `Authorization: Bearer …`  | Service token                                                                                              | not needed (file permissions)  | required                                         |

The daemon keeps engines warm per (configuration, project), up to `ENGINE_MAX`, as it does for
the hooks. A request's grant is built from its headers on a warm engine, which is cheap.

#### 7.1.4 Auth

- **Unix socket:** file permissions, as today. The socket is mode 600 in a 700 directory owned by
  this user, checked with `lstat`, with no symlinks followed. The client runs the same
  `inspectDir` check before it connects. Anyone running as the same user is trusted as the person
  (the same rule as the CLI and the hooks), so expert mode is allowed here.
- **TCP:** a bearer token (§8.4). There is no anonymous TCP access, ever.

#### 7.1.5 Versioning

- The path carries the protocol major (`/v1`). `GET /v1/health` returns
  `{ version, protocol: 1, mode, capabilities: string[] }`. `capabilities` names optional
  features (`judgments`, `consolidate`, `forget-all`, `spatial`), so a newer client can test for
  a feature instead of comparing versions.
- Unlike the hooks, the SDK accepts a daemon of any version that speaks protocol 1 at version
  0.7.0 or newer. Any change that is not additive bumps the path to `/v2`, and the daemon serves
  both for one minor.
- A daemon older than 0.7.0 reads the HTTP request's first bytes as a frame length larger than 4
  MiB and drops the connection with `bad-frame`. The client takes that as an outdated daemon and
  throws `OortUsageError` (reason `daemon-outdated`, fix `oort serve stop`). It never stops
  another version's daemon by itself.

#### 7.1.6 Autostart, idle exit and life without Node

- If the socket does not answer, the client tries once to start the daemon. With
  `autostart=True` (the default) it runs `oort serve --detach`, finding `oort` the way the
  launcher does (an installed `oort`, else `npx oortmem@<same version>`). It then waits up to 5
  s for `GET /v1/health`. The hook circuit breaker file is not touched.
- SDK requests count as activity for `--idle` (default 30 minutes). A long-lived Python service
  should run `oort serve` under its own supervisor instead of relying on autostart.
- **Without Node 22.15 or newer,** local and auto-resolved-local mode throw `OortUsageError`
  (reason `node-missing`). The message says to install Node, or to use `Oort(mode="cloud")` or
  `mode="remote"`, which need no Node.
- The daemon never migrates the store (unchanged). On an older store it answers
  `refused`/`migration-required` with fix `oort doctor`. Service mode may opt in with
  `--migrate` (§8.4).

### 7.2 Cloud transport

Python calls `https://api.oortcloud.dev` directly (or `OORT_CLOUD_URL`), using
`packages/cli/test/cloud-contract.json` as the source of truth:

| SDK call                                              | Cloud request                                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall`                                              | `POST /v1/recall` `{ text, project?, projectPrivate?, k, mode?, asOf?, knownAt?, include?, agent?, rerank?, embed? }`. `speed: 'fast'` sends `rerank: false`, and `'lexical'` also sends `embed: false` |
| `observe`                                             | `POST /v1/observe` `{ project?, turnRef?, observation: { user, assistant, at?, session?, tools? } }`                                                  |
| `remember`                                            | One `observe` per fact, framed exactly as `cloudBackend.remember` does (`Remember this: …` / `Noted: …`)                                             |
| `forget`                                              | `DELETE /v1/memories/:id`, or `?everywhere=1` with `everywhere`                                                                                       |
| `pin` / `unpin`                                       | `POST /v1/memories/:id/pin` / `unpin`                                                                                                                 |
| `explain`                                             | `GET /v1/memories/:id`, shaped as `cloudBackend.explain` does                                                                                         |
| `recent`                                              | `GET /v1/memories?project=&limit=`                                                                                                                    |
| `whoami`                                              | `GET /v1/whoami?agent=`                                                                                                                               |
| judgments, `consolidate`, `forgetAll`                 | not sent: `OortRefusedError` (`local-only`)                                                                                                           |

Both SDKs map errors with the contract's `errors` table and §4. `projectPrivate` is sent only when
the project's own config file states it (`privacyStatement`). TypeScript reuses `CloudClient`
unchanged, and keep-alive is on for any handle that lives longer than one call.

## 8. Running in your own infrastructure

### 8.1 Deployment shapes

| Shape                                                           | Works today (0.5.4)                                                                                                       | 0.6.0                                                                                                                                                   | 0.7.0                                                                                                                       | Missing or later                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Library in the agent process** (Node)                         | Only by hand-wiring `@oortmem/core`                                                                                       | `createOort()`: local engine in-process (SQLite on a volume), or cloud mode                                                                             | unchanged                                                                                                                   | Python cannot embed the engine; it goes through the daemon                                                           |
| **Long-running service** (ECS, Cloud Run, GKE, EKS)             | `oort mcp` over stdio only                                                                                                | A Node service embedding the SDK, **one replica**, store on a block volume                                                                              | `oort serve --listen` as the memory service for any language: token, TLS, health, metrics; the official image                | Several replicas need a server-grade store (§8.2). Cloud Run has no block volumes, so use cloud mode or GKE           |
| **Serverless** (Lambda, Cloud Functions)                        | No: the CLI expects a home directory and a keychain                                                                       | TS **cloud mode**: no native module loaded, no disk writes, adapters lazy. Keep the handle in module scope across invocations                          | Python cloud mode (standard library only, small cold start). Either SDK in remote mode against an Oort service in the VPC   | A local store in serverless is not supported: `/tmp` is ephemeral and per instance                                   |
| **Sidecar daemon** next to the agent                            | `oort serve`, hooks only                                                                                                  | none                                                                                                                                                    | `oort serve` in the same pod or task: a shared `emptyDir` Unix socket (same uid), or `--listen 127.0.0.1:7807` with a token | None for one agent per store. For many pods, use the service shape                                                    |

Cold starts (TypeScript): `createOort({ mode: 'cloud' })` reads env and options only. The first
call opens one HTTPS connection. Nothing under `better-sqlite3`, `onnxruntime-node` or the
writer's SDKs is imported. A test asserts this by checking the import graph in cloud mode.

### 8.2 Storage

**SQLite on a persistent block volume is the supported self-hosted store for 0.6 and 0.7.**

- Use EBS (EKS StatefulSet with the EBS CSI driver, or ECS on EC2) or a GCE persistent disk (a GKE
  StatefulSet). `OORT_HOME` lives on the volume. It holds `oort.sqlite` with its WAL, `cold/` (the
  zstd blobs), `models/` and the key-free config.
- **One host per store.** SQLite WAL needs shared memory on one host. Several processes on that
  host are fine, as with the CLI, hooks, MCP and daemon today. Several hosts are not, so run one
  replica per store (`replicas: 1`, `ReadWriteOnce`). Use a rolling update with
  `maxSurge: 0`, or `Recreate`.
- **No network filesystems.** EFS, Filestore and other NFS, SMB, and FUSE mounts such as GCS
  FUSE break WAL's shared memory and its locking guarantees. In 0.7.0, `openSqliteStore` checks
  `fs.statfsSync(dir).type` against the NFS, SMB and FUSE magic numbers. `oort serve --listen`
  refuses to start on one. The CLI and SDK warn (`network-filesystem`) and keep going, for
  compatibility.
- **ECS on Fargate** attaches EBS volumes per task. Whether that fits a single long-lived store
  (data surviving task replacement) is **unverified**. Until it is checked, the AWS recipe uses
  ECS on EC2 or EKS.
- **Backups:** volume snapshots, plus a scheduled `oort export` (JSON Lines, `docs/export-format.md`)
  to S3 or GCS. A restore is `oort import`. The store's own pre-migration copies
  (`VACUUM INTO`) stay as they are.

**A server-grade store (Postgres with pgvector on RDS or Cloud SQL) is not built for 0.6 or 0.7.**
It is the right next store, and the seam is ready for it:

- `MemoryStore` takes a `Grant` on every method and enforces it inside the store. `storeConformance`
  (`@oortmem/core/store-conformance`) already runs the contract and isolation suites against any
  store, so `@oortmem/store-postgres` is "pass the suite", not a redesign.
- The mapping: one `memories` table with the address columns (level, org, customer, agent, hive,
  run, project, author) and the same `CHECK`s as schema v3, a `tsvector` column for `lexical`
  (recall fuses by rank, so `ts_rank` versus `bm25` does not break fusion), pgvector for `dense`
  partitioned or filtered by node, and cold blobs in a table or in S3/GCS behind the
  existing cold methods. Row-level security per `org_id` as a second line of defence, never the
  first.
- **Trigger to build it:** the first self-hosting user who needs more than one replica, or high
  availability, that Oort Cloud does not meet. Until then: one replica plus snapshots, or Oort
  Cloud. Target: after 0.7.0, decided by demand (Q8).

### 8.3 Multi-tenant use

| Option                                                                    | Isolation                                                                                    | Use when                                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Scopes in one store**: `org` = your tenant, `user` = their end user     | Grants enforced in the store, covered by the conformance and isolation suites                | **Default.** Many end users per tenant                                                                           |
| **One store per tenant** (one `OORT_HOME` or volume per org)              | Physical. Separate files, keys and backups                                                   | Contractual separation, per-tenant residency, per-tenant deletion by file                                        |
| **One store per end user**                                                | Physical                                                                                     | Only when lexical *score* independence matters. FTS5 `bm25` statistics are per table (store contract, "Known limit"), but results never cross tenants either way |

The SDK maps a host app's identities like this:

```ts
const oort = await createOort({ mode: 'local', home: '/data/oort', org: tenantId, project: null });
const forUser = (userId: string) => oort.scoped({ user: userId, agent: 'support-bot' });
const mem = forUser(req.user.id); // hand only this handle to the model's tools
```

- `org` is the owner: the storage, key and deletion boundary. `user` gives each end user their own
  Planet. `agent` is the host's agent and gets a Star. What one agent learns about one user (an
  Orbit, `agent-user` level) and promotion to a shared Galaxy are **CON-92 (B2B2C)**. The address
  model already has room for them, and the SDK will expose them as `scoped({ user, agent, orbit:
  true })` when that epic ships. Not before.
- Memories written for a `user` other than `self` are invisible to the `oort` CLI, which always
  acts as `self`. A `--user` flag for operators is open question Q9.
- In **cloud mode**, an Oort key is one account (one person's Planet and their Constellations),
  so a multi-tenant app cannot keep its end users apart through the cloud until CON-92. 0.6 and
  0.7 say so in the docs, and `user` is a usage error in cloud mode.
- `forgetAll({ confirm: 'forget-all' })` (0.7.0, `@experimental`) erases every memory a handle
  can write: one end user's Planet and the agent's Star for them. It is built from `list` and
  `forget`, needs no store change, and gives a self-hosted multi-tenant app a GDPR erasure path
  ahead of CON-92's `forgetCustomer`.

### 8.4 Service mode: `oort serve --listen`

**Decision: yes, in 0.7.0, and the Python client's remote transport is this API.** The local
transport stays the Unix socket, carrying the same HTTP protocol (§7.1). There is one protocol
and two listeners: the socket for one machine's processes, TCP for the network.

```sh
oort serve --listen 0.0.0.0:7807 --tls-cert /run/tls/tls.crt --tls-key /run/tls/tls.key
oort serve --listen 127.0.0.1:7807 --plaintext        # sidecar, or behind a TLS-terminating proxy
PORT=8080 oort serve --listen 0.0.0.0:$PORT --plaintext --migrate   # one-replica service
```

| Concern           | Decision                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opt-in            | TCP opens only with `--listen` (or `serve.listen` in the home config or `OORT_CONFIG`). A repository config cannot set it (`serve` is home-only). The Unix socket stays on beside it. The sentence "No TCP listener, ever" in the daemon's doc comment and docs/cli.md becomes "never unless `--listen` is given".                                                                                                    |
| Auth              | `Authorization: Bearer <token>`. The token comes from `OORT_SERVE_TOKEN` or `OORT_SERVE_TOKEN_FILE` (a mounted secret: AWS Secrets Manager through the ECS `secrets` field or the Secrets Store CSI driver, GCP Secret Manager through Cloud Run secret env vars or the CSI driver). It must be at least 32 bytes of entropy. It refuses to start without a token. Comparison uses `timingSafeEqual` on SHA-256 digests. Up to two comma-separated tokens are accepted, for rotation. |
| What a token may do | Everything in its org (`OORT_SERVE_ORG`, default `local`): any `user`, `project` and `agent`, agent-role judgments only, and no `Oort-Cwd`. Per-token scopes (one token per user group, read-only tokens) come later (Q10). Treat the token like a database password: it reaches every end user of that org.                                                                                                    |
| TLS               | Built-in TLS via `node:https` with `--tls-cert`/`--tls-key` (reloaded on `SIGHUP`). Plaintext needs `--plaintext` and is allowed only for a loopback address or when stated explicitly (behind an ALB, a Cloud Run front end, or a service mesh with mTLS). A non-loopback `--listen` without either refuses to start. mTLS client certificates come later.                                                          |
| Health            | `GET /healthz`: 200 when the process serves (no auth, no store access). `GET /readyz`: 200 when the store is open and at the current schema, else 503 with `{ ready: false, store: 'migration-required' \| 'locked' \| 'network-filesystem' }` (no auth, no data). Use them as the liveness and readiness probes or target-group health checks.                                                                       |
| Migration         | `--migrate` lets the service migrate on start (it is the only writer). Without it, it reports not-ready with `migration-required`. A one-off job running `oort doctor` (which migrates) also works.                                                                                                                                                                                                                                |
| Limits            | The current per-connection limits stay for the socket. TCP: 256 connections, 4 MiB bodies, 30 s per request, keep-alive 60 s. Rate limiting belongs to the platform (ALB, Cloud Armor, mesh).                                                                                                                                                                                                                           |
| Idle exit         | Off with `--listen` (a service does not exit when idle).                                                                                                                                                                                                                                                                                                                                                              |
| Port              | No default; `--listen` is explicit. Docs use 7807. `PORT` is honoured in `--listen 0.0.0.0:$PORT` by the shell, not by magic.                                                                                                                                                                                                                                                                                       |

### 8.5 Model keys, local models and egress

- **Keys come from the environment only on servers.** Inject `VOYAGE_API_KEY`,
  `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` (or `OORT_API_KEY` for the relay) from AWS Secrets
  Manager or GCP Secret Manager through the platform's secret injection. The image sets
  `OORT_NO_KEYCHAIN=1`. Keys are never written to the volume.
- **Local models in containers:** `@oortmem/local-models` (ONNX Runtime, CPU only, about 115 MB)
  plus the default models (about 58 MB) give embedding and reranking with no egress. Saving
  memories still calls the decision and writer models (a local decision model is CON-16), so a
  fully air-gapped deployment can recall and judge by precedent but cannot observe. The large
  multilingual models (600 MB or more each, about 1 GB of memory) suit a long-lived service, not
  serverless.
- **Egress list** for a VPC firewall: the Voyage, TypeSafe and Anthropic APIs for own keys, or
  the Oort Pro relay for an Oort key, or `api.oortcloud.dev` for cloud mode, and the model mirror
  at pull time only (`OORT_MODELS_URL`).
- **Data residency:** Oort Cloud stores memories in the EU. Self-hosted, the store is wherever
  your volume is. Text still reaches the model vendors your keys point at, under your agreements
  with them. For EU-only processing of embeddings, use local models. The decision and writer
  calls stay with their vendors until CON-16.

### 8.6 Packaging for servers

| Item                       | Decision                                                                                                                                                                                                                                                                                      | Release        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Official image             | `ghcr.io/oortmem/oort:<version>`, multi-arch (amd64, arm64), built from `gcr.io/distroless/nodejs22-debian12:nonroot` (glibc, for `better-sqlite3` prebuilds). Runs as uid 65532 with a read-only root filesystem, `OORT_HOME=/data` as the one writable volume, `OORT_NO_KEYCHAIN=1`, and the entrypoint `oort serve`. Signed with build provenance from the release workflow. | 0.7.0          |
| Local-models variant       | `…:<version>-local`, with `@oortmem/local-models` and the two default models in the image, pinned by SHA-256 as `oort models pull` pins them                                                                                                                                                  | 0.7.0          |
| Env-only config            | `OORT_CONFIG` holds a JSON overlay of the home config, read after `config.json`. It may set `serve` and `judge`, because the operator controls the environment. With it, a container needs no config file.                                                                                     | 0.7.0          |
| Deployment examples        | `docs/self-hosting.md`, with a docker-compose file, a Kubernetes StatefulSet (`replicas: 1`, PVC, probes, Secret), an ECS-on-EC2 task definition snippet and a Cloud Run cloud-mode example (an app using the SDK, no Oort service)                                                           | 0.7.0          |
| Helm chart, Terraform module | Later. A chart for a single-replica StatefulSet adds little over the example manifest. Revisit with the Postgres store, when replicas > 1 make a chart worth maintaining.                                                                                                                   | later          |

### 8.7 Observability

- **Never in logs or metrics:** memory text, queries, turn text, judgment text, keys, tokens, or
  scope values (user, project, agent ids can be personal data). Ids of memories are omitted too.
- **Service logs:** one JSON line per request on stdout:
  `{ ts, level, msg: "request", route, status, ms, mode, degraded: [...], counts: {...}, requestId }`.
  Start, stop, config and migration lines follow the same shape. `serve.log` keeps its current
  start and stop lines for `--detach`.
- **Metrics:** `GET /metrics` (Prometheus text, bearer token, or a separate `--metrics-listen
  127.0.0.1:9464` without a token). It exports `oort_requests_total{route,status}`,
  `oort_request_duration_seconds{route}`, `oort_recall_degraded_total{reason}`,
  `oort_model_calls_total{role,via}` (billing visibility: `via` is `own-key`, `oort-pro` or
  `local`), `oort_observe_outcomes_total{outcome}` and `oort_store_bytes`.
- **The hook log** is unchanged: counts and timings, never text (docs/claude-code.md).
- **TypeScript SDK:** it publishes to `node:diagnostics_channel` (`oortmem:call`) one event per
  call, `{ op, mode, ms, outcome, degraded, modelCalls }`, with no text. Hosts forward it to
  OpenTelemetry or their logger. There is no logging dependency, and nothing is printed by
  default. `@experimental` payload.
- OpenTelemetry tracing comes later, on top of the same channel.

### 8.8 What lands when

| Release   | Self-hosting scope                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.6.0** | TS SDK embedded in a one-replica service on a block volume. TS cloud mode in serverless (lazy native modules, `OORT_NO_KEYCHAIN`, `keySources`). The diagnostics channel. Docs: "Using Oort from your service" (library and serverless shapes only).                                       |
| **0.7.0** | `oort serve` HTTP protocol (socket and `--listen`), token, TLS, `/healthz`, `/readyz`, `/metrics`, `--migrate`, network-filesystem refusal, `OORT_CONFIG`, the image and its `-local` variant, `forgetAll`, TS `mode: 'remote'`, Python local, remote and cloud, and `docs/self-hosting.md` with AWS and GCP recipes. |
| **Later** | `@oortmem/store-postgres` (by demand), Helm and Terraform, per-token scopes and mTLS, a server-side observe queue (Q6), OpenTelemetry, multi-tenant cloud (CON-92).                                                                                                                         |

## 9. Shared contract tests

One suite, `contract/sdk/`, at the repository root, versioned with the protocol:

```
contract/sdk/
  cases/*.json          one file per area: recall, temporal, observe, remember, ids, judge, scope, errors, scrub, format, place, limits
  seeds/*.json          stores to start from, as export-format v2 lines plus judgments
  vectors/project-id.json   cwd layouts → expected project ids (Python port)
  secrets.b64.txt       a symlink to packages/core/test/fixtures/secrets.b64.txt (base64, so check-public stays clean)
  schema.json           JSON Schema of a case
```

A case:

```json
{
  "id": "judge.agent-record-is-unconfirmed",
  "transports": ["local", "remote"],
  "seed": "judge-basic",
  "options": { "agent": "bot", "config": { "judge": { "experts": ["ada"] } } },
  "now": "2026-11-06T12:00:00Z",
  "steps": [
    { "call": "judge.record", "args": { "subject": "Post claims a cure", "verdict": "rejected", "reason": "No source.", "domain": "content", "by": "ada" },
      "expect": { "result": { "outcome": "added", "memory": { "$type": "string" } } }, "save": { "id": "$.memory" } },
    { "call": "judge.list", "args": {},
      "expect": { "result": { "judgments": { "$some": { "id": "${id}", "agentRecorded": true, "confirmed": false } } } } },
    { "call": "judge.confirm", "args": { "id": "${id}" }, "expect": { "error": { "code": "refused", "reason": "expert-only" } } }
  ]
}
```

- **Arguments and expectations use the camelCase wire names.** The Python runner converts names
  with the documented mechanical rule, so one file serves both SDKs. Matchers: `$type`, `$len`,
  `$some`, `$every`, `$absent`, `$regex`, `$approx`. Unknown result fields are ignored (the
  additive rule, §6.4).
- **Determinism.** Fake adapters from core's test helpers (a hash embedder, a rule-based
  decider, an echo writer), a fixed `now`, and seeded stores. Real models are never called.
- **Transports.**
  - TypeScript `local`: the in-process engine with the fakes.
  - Both SDKs, `remote` and Python `local`: `packages/sdk/test/fixture-daemon.ts`, which starts
    `oort serve` with the fakes on a temporary socket or port. It is test-only and never in the
    npm `files`, so no shipped binary can swap in fake models.
  - `cloud`: the fake cloud the CLI's tests already run against `cloud-contract.json`.
- **Runners.** `packages/sdk/test/contract.test.ts` (vitest) and `python/tests/test_contract.py`
  (pytest, Python 3.10 and 3.13 in CI, Node 22.15 for the fixture daemon). `pnpm verify` runs the
  TypeScript side. The release workflow runs both and blocks publishing on failure.
- **Must-have areas for 0.6.0** (TypeScript runner, `local` and `cloud`):
  - every §3.5 limit and §3.4 temporal rule;
  - each error code at least once;
  - scope isolation (two users, two agents, and `include` narrowing);
  - all §5.3 judgment rules, including the daily cap (with the counter at 49) and `via` values;
  - scrubbing: every fixture secret, observed, remembered or used as a query, never appears in
    any result;
  - `formatForPrompt` escaping of a memory that contains `</oort-memory>`;
  - `place` refused with `spatial-unavailable`.

  0.7.0 adds the Python runner, `remote`, the project-id vectors and daemon versioning.

## 10. Framework integrations

What was checked: each framework's current interface, through Context7 (`ctx7`) on 2026-11-06.
The library ids used: `/websites/ai-sdk_dev` (Vercel AI SDK, including the v6 → v7 migration
guide), `/websites/langchain_oss_javascript_langgraph` and
`/websites/reference_langchain_javascript_langchain-langgraph` (LangGraph.js),
`/websites/reference_langchain_python_langgraph` and `/langchain-ai/langgraph` (LangGraph Python,
`store/base`), `/websites/openai_github_io_openai-agents-js` and `/openai/openai-agents-python`
(OpenAI Agents SDK), `/llmstxt/crewai_llms_txt` (docs v1.15.23) and `/crewaiinc/crewai`
(CrewAI), and `/llmstxt/mastra_ai_llms_txt` and `/mastra-ai/mastra` (Mastra). Re-check each
before its adapter ships, because these interfaces move fast.

| Framework                       | Current memory or tool interface (as checked)                                                                                                                                                                                                       | Thinnest good adapter                                                                                                                                                                           | Launch? |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Vercel AI SDK** (TS, v7)      | `tool({ description, inputSchema, execute })` (`parameters` became `inputSchema` in v5). Tools are passed as `tools: {…}` to `generateText`/`streamText`. In v7, approval is call-level (`toolApproval`). There is no memory interface.            | `oortTools(oort)` → `{ recall, remember, forget }`. `oortObserve(oort, prompt)` returns an `onFinish` callback that calls `observe`. `formatForPrompt` goes into `system`.                    | **TS, 0.6.0** |
| **LangGraph.js**                | `BaseStore` with `batch(ops)` and `put`/`get`/`search(namespacePrefix, { query, filter, limit, offset })`/`delete`, passed by `compile({ store })` and read in nodes as `runtime.store`                                                            | `OortStore extends BaseStore`: `search` with `query` → `recall`, `put` → `remember`, `delete` → `forget`, `get` by Oort id. A `namespaceToScope(ns)` function (host code) maps a namespace to `scoped({ user, project })`. Plus the tools. | **TS, 0.6.0** |
| **OpenAI Agents JS**            | `Session`: `getSessionId`, `getItems(limit?)`, `addItems(items)`, `popItem`, `clearSession`, passed by `run(agent, input, { session })`. `tool({ name, description, parameters, execute(args, context, details) })`.                                | `oortSession(inner, oort)` wraps any `Session`: it delegates storage, and `addItems` pairs the user and assistant items and calls `observe`. Recall goes through dynamic `instructions` (`oortInstructions(oort)`) and `oortTools`, never through rewritten history. | **TS, 0.6.0** |
| **LangGraph (Python)**          | `BaseStore(ABC)`: abstract `batch(ops)` and `abatch(ops)`. `get`, `put`, `search(namespace_prefix, *, query, filter, limit…)`, `delete` and `list_namespaces` are built on them. `Item` has `namespace`, `key`, `value`, `created_at` and `updated_at`; `SearchItem` adds a score. | `OortStore(BaseStore)` dispatches `GetOp`, `PutOp` and `SearchOp` the same way as the TS adapter. `list_namespaces` returns only the namespaces the mapping knows. Async goes through `AsyncOort`. | **Py, 0.7.0** |
| **OpenAI Agents (Python)**      | `Session` protocol (no base class needed): `get_items`, `add_items`, `pop_item`, `clear_session`, passed by `Runner.run(..., session=)`. Tools via `@function_tool`; the docs now also show `@tool` from `agents.decorators`.                    | Same as JS: `OortSession(inner, oort)`, `oort_instructions(oort)`, and `oort_tools(oort)` built with `function_tool`                                                                         | **Py, 0.7.0** |
| **CrewAI**                      | Unified `Memory(storage=StorageBackend)`. The backend's `search` receives `query_embedding: list[float]`, not text. Tools are `BaseTool` subclasses (`args_schema`, `_run`) or `@tool`.                                                            | **Tools only:** `OortRecallTool`, `OortRememberTool` and `OortForgetTool`. A `StorageBackend` adapter would bypass Oort's ranking, because CrewAI embeds the query itself.                  | **Py, 0.7.0** |
| **Mastra**                      | `createTool({ id, description, inputSchema, outputSchema?, execute(inputData, context) })`. `Memory` storage is thread- and message-oriented (`MemoryStorage.saveMessages`, threads, resources).                                                  | Tools only, through `createTool`. A docs example, not a subpath.                                                                                                                             | Example after launch |

Rules for every adapter:

- It takes a handle and calls `scoped({ judgeRole: 'agent' })`.
- It injects memory only through `formatForPrompt`.
- It exposes `record_judgment`/`judge` tools only when `judge: true` is passed.
- It lives in a subpath (TS) or an extra (Python), so the core install never depends on a
  framework.

Each ships with a 20-line example in `docs/sdk.md`. Any MCP-capable framework can also use `oort
mcp` today with no code.

## 11. Spatial readiness

The `Place` type is reserved now, in the shape CON-84 proposes, so that adding spatial memory later
breaks nothing:

```ts
/** @experimental Reserved for CON-84; calls that pass it are refused until spatial memory ships. */
export interface Place {
  nodeId?: string; // place-tree node, e.g. "site:hq/floor:2/room:B/shelf:B3"
  frame?: string; // coordinate frame, e.g. "map"; never "odom"
  mapId?: string;
  mapVersion?: number;
  pose?: { x: number; y: number; z?: number; yaw?: number }; // metres, REP-103
  extent?: { dx: number; dy: number; dz?: number } | { radius: number };
  geo?: { lat: number; lon: number; alt?: number; h3?: string }; // WGS84
  sigma?: number; // 1σ pose uncertainty, metres
}
```

| Where                                                    | Now (0.6, 0.7)                                                                                                          | After CON-84                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Turn.place`, `remember(…, { place })`                   | Shape-validated, then `OortUsageError` (`spatial-unavailable`). Never silently dropped: a robot must not believe it stored a location. | Stored on the memory                                 |
| `RecallOptions.near`, `.within` (names reserved, types `never`) | Not accepted by the types. At runtime: `spatial-unavailable`                                                      | `near: { pose, radius, mapId }`, `within: { nodeId } \| { box, mapId }` |
| `MemoryView.place`                                       | Never set                                                                                                               | Set when stored                                      |
| `RecalledMemory.why`                                     | none                                                                                                                    | `placePath`, `distanceM`, `stalePose`                |
| Daemon schemas                                           | `place`, `near` and `within` are named reserved fields (strict schemas would otherwise refuse them as unknown)          | Accepted                                             |
| `/v1/health` capabilities                                | no `spatial`                                                                                                            | `spatial`                                            |
| Python                                                   | A `Place` dataclass that mirrors the shape                                                                              | Same                                                 |

Moving a call from refused to accepted, and filling an optional field, are additive changes
(§6.4). The export format and the store contract gain their optional `place` in CON-84 itself.

## 12. Changes outside the new packages

| Package             | Change                                                                                                                                                   | Release |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `@oortmem/core`     | `JudgmentVia` gains `'sdk-agent'`, `isUnconfirmedAgentJudgment` covers it, and the pack parser accepts it (§5.3)                                          | 0.6.0   |
| `oortmem` (CLI)     | Imports wiring from `@oortmem/sdk`. `exports` map and adapters. The daily-cap counter is shared with the SDK. `docs/cli.md` judgment `via` table adds `sdk` and `sdk-agent` | 0.6.0   |
| `oortmem` (CLI)     | `oort serve`: HTTP on the socket, `--listen`, token, TLS, probes, metrics, `--migrate`; `OORT_CONFIG`                                | 0.7.0   |
| `@oortmem/store-sqlite` | Network-filesystem detection (§8.2)                                                                                                                  | 0.7.0   |
| `docs/`             | `docs/sdk.md` (0.6.0); `docs/self-hosting.md` and the Python section (0.7.0)                                                                              |         |

## 13. Out of scope (0.6 and 0.7)

- Constellation sharing, invites, members, keys and Galaxies from the SDK. They need a person's
  confirmed preview, so they stay in the CLI and the dashboard.
- Judgment packs, bulk import, `judge eval`, `judge withdraw` and `judge purge` from the SDK.
- `export`/`import`, `reembed`, `models pull` and `project link` (CLI tasks).
- A browser or edge-runtime build (no SQLite there; cloud mode in edge runtimes is open question
  Q7).
- Orbits and end-user Planets in the cloud (CON-92), and spatial recall (CON-84 onwards).

## 14. Open questions, with recommendations

| #   | Question                                                                                               | Recommendation                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Should `refused` be in the SDK even though CON-107's issue lists nine codes?                           | **Yes.** It is already in the `oort.v1` branch and docs. Update CON-107's notes so the issue matches the code.                                                                                                                                      |
| Q2  | Should the SDK depend on the `oort.v1` branch landing first?                                           | **Yes, for 0.6.0.** The error mapping moves into `@oortmem/sdk` in the same release. Merge CON-107 step 2 before the SDK branch.                                                                                                                  |
| Q3  | Should Python scrub on the client in cloud mode?                                                       | **Not in 0.7.0.** Instead, export the scrub rule table from `scrub.ts` as generated JSON in a later release, so both languages run one rule set, checked by the shared secret fixtures. A hand port would drift.                                |
| Q4  | Should the agent-role daily cap be configurable?                                                       | **Yes, in 0.7.0:** `judge.agentDailyLimit` in the home config or `OORT_CONFIG`, default 50, maximum 5,000. Services with many end users need more than 50 a day per home.                                                                          |
| Q5  | Should `AsyncOort` get a native async transport?                                                       | **Threads for 0.7.0.** Add an optional `oortmem[httpx]` extra only if benchmarks show thread offload limits throughput.                                                                                                                             |
| Q6  | Should there be a server-side observe queue (fire and forget)?                                         | **Later (0.8).** `POST /v1/observe?async=1` → 202 with `turnRef`, drained like the hooks' queue. Until then, callers await `observe` off the response path.                                                                                        |
| Q7  | Should cloud mode run in edge runtimes (Cloudflare Workers, Vercel Edge)?                              | **After 0.7.0.** It needs a `oortmem/cloud` subpath that imports no `node:` modules. It is cheap once the cloud client is isolated, but not needed for launch.                                                                                      |
| Q8  | When should the Postgres store be built?                                                               | **On the first concrete need** for more than one replica or HA in self-hosting. Write its slices then, against `storeConformance`. Not on the 0.6 or 0.7 path.                                                                                     |
| Q9  | Should the CLI gain `--user` and `--org` for operators of multi-tenant stores?                         | **Yes, in 0.7.0,** for `recall`, `inspect`, `forget` and `export` only, so an operator can inspect and erase one end user's memories.                                                                                                             |
| Q10 | Should there be per-token scopes in service mode?                                                      | **Later.** It would be a token file with hashed tokens, each bound to an org and optionally users, read-only, or judge role. One full token per org is enough for 0.7.0's VPC use, and is documented as such.                                     |
| Q11 | Should `remember` get a cloud route instead of the client-side `observe` mapping?                      | **Yes, in the cloud API's next contract change.** Add `POST /v1/remember`, so the framing lives in one place. Both SDKs switch when the contract file lists it.                                                                                     |
| Q12 | Should `createOort()` with no options in a server pick up a developer's `~/.oort`?                     | **Keep CLI parity** (`mode: 'auto'`) for the five-line example. Docs for servers always pass `mode`, `home`, `project` and `keySources` explicitly. `whoami()` shows what was resolved.                                                            |
| Q13 | Is ECS on Fargate with EBS suitable for a long-lived store?                                            | **Verify before the 0.7.0 AWS recipe.** Until then, recommend ECS on EC2 or EKS with the EBS CSI driver.                                                                                                                                            |
