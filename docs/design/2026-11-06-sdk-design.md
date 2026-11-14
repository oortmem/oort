# SDKs: `createOort()` for TypeScript and `Oort` for Python, one API shape

Date: 2026-11-06. Status: proposed design, revised the same day for build effort and security. Issues: CON-108 (this spec), CON-24 (Python client), CON-107 (the
`oort.v1` contract), CON-84 (spatial `Place`), CON-92 (end users, B2B2C). Releases: **0.6.0**
(TypeScript SDK, before the 18 November launch) and **0.7.0** (native Python client, about 25
November).

This spec covers the developer surface. It changes no ranking, write-path or storage behaviour,
except where a section says so. Every such change is listed in §14.

**How to read it.** §1 is the 0.6.0 scope, and it is binding: whatever §1 leaves out is 0.7 or
later, even where a later section describes it in full. The later sections give the complete
design, so that 0.6.0 does not paint 0.7 into a corner. Each item is tagged **[0.6]**, **[0.7]**
or **[later]** where its release is not obvious.

## 0. Decisions in brief

1. **One API shape, several transports.** In 0.6.0, TypeScript runs the engine in-process
   (`local`) or calls Oort Cloud over HTTPS (`cloud`). 0.7.0 adds Python, which talks to `oort
   serve` (a Unix socket on one machine, or an opt-in TCP listener with a token in a VPC) or to
   Oort Cloud. It also adds a TypeScript `remote` mode against `oort serve`. Method names,
   arguments, result fields and error codes are the same on every transport.
2. **0.6.0 is one package.** The facade ships from `oortmem`'s root export
   (`packages/cli/src/sdk/`). A separate `@oortmem/sdk` package, and moving the wiring files into
   it, wait until 0.7. The public import path, `oortmem`, stays the same either way.
3. **ESM only, Node 22.15 or newer.** `require('oortmem')` still works through Node's
   `require(esm)`, because the library's import graph has no top-level await. A test checks it.
4. **Errors are typed classes carrying the `oort.v1` code and a `reason`.** There are ten codes:
   CON-107's nine, plus `refused`. They are built on CON-107 step 2's `describeError`, which must
   merge first (Q2).
5. **An SDK caller is an agent.** Its judgments are stored exactly like MCP's (`via: 'mcp'`, with
   `source.harness: 'sdk'`), so every reader, 0.5.x included, treats them as unconfirmed. They
   are allowed only for experts listed in `judge.experts`, and they share MCP's daily cap and its
   counter file. Expert mode is an explicit option that records `via: 'sdk'`. Model-facing tools
   never expose expert mode or the options that widen judging.
6. **Scope is fixed per handle, and safe by default.** No method takes a scope argument.
   `scoped()` derives handles from trusted host code. A handle for an end user (`user`) needs an
   explicit `org` and gets that user's Planet only, never a Star, until CON-92: today's Star is
   keyed by org and agent, not by user, so a Star would leak between users.
7. **Cloud mode touches no disk and loads no native module.** The store import becomes dynamic,
   and `oort.sqlite` is no longer opened before the cloud check. Import-graph tests enforce this.
8. **Python (0.7.0) has no runtime dependencies** and needs 3.10 or newer, while `import oortmem`
   keeps working on 3.9 for the launcher. `oort serve` gains an HTTP memory protocol whose routes
   mirror Oort Cloud's `/v1`. It is served on the existing socket, with routing by the first
   byte, and on an opt-in TCP listener that requires TLS (or an explicit proxy flag) and a
   256-bit token.
9. **One JSON contract suite** under `contract/sdk/`. 0.6.0 ships its TypeScript runner, laid out
   so the Python runner drops in for 0.7.0.
10. **Integrations.** 0.6.0 ships one adapter, `oortmem/ai-sdk` (Vercel AI SDK,
    `@experimental`), and docs examples for LangGraph.js and OpenAI Agents JS. 0.7.0 adds
    LangGraph, OpenAI Agents and CrewAI for Python, and the self-hosting pieces: service mode,
    the container image, and AWS and GCP recipes.

## 1. 0.6.0 scope (launch, binding)

The estimate for the full design was 11 to 14 days, which does not fit before 18 November. 0.6.0
ships only what follows. Anything else in this spec is **0.7 or later**.

| Area      | In 0.6.0                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package   | `oortmem` only. The facade lives in `packages/cli/src/sdk/` and is reached through `exports["."]` → `dist/sdk/index.js`, with the `bin` kept. No new npm package (a new one would need a manual first publish before trusted publishing can take over). |
| Modes     | `'auto' \| 'local' \| 'cloud'`. `remote` is absent from the types.                                                                                                                                                                             |
| Options   | `mode`, `home`, `cwd`, `project`, `projectConfig`, `agent`, `user`, `org`, `keys`, `keySources`, `config`, `url`, `timeoutMs`, `migrate`, `env`, `fetch`, `judge.role` (with `judge.operator`).                                                |
| Methods   | `recall`, `observe`, `remember`, `forget`, `pin`, `unpin`, `recent`, `explain`, `whoami`, `scoped`, `close` and `[Symbol.asyncDispose]`, the `formatForPrompt` function, `judge.record`, `judge.apply`, `judge.list`, `judge.confirm` (expert role only), and `consolidate` (local only). |
| Errors    | The ten codes plus `reason`, built on CON-107 step 2's merged `describeError`, without the CLI-only fixes ("again with `--yes`", `oort --help`).                                                                                             |
| Cloud     | No native module loaded and nothing written to disk: a dynamic `@oortmem/store-sqlite` import, the cloud check before any store is opened, and no hook logger or query cache. Tests check the import graph and `require('oortmem')`.        |
| Security  | §6.3 (judgments as `via: 'mcp'`, the `isAgentVia()` helper), §6.4 (Planet only for end users, an explicit `org`), and §6.6 (key handling).                                                                                                     |
| Tests     | The contract suite: JSON cases under `contract/sdk/` with a TypeScript runner, run against the local engine and the shared fake cloud (§10).                                                                                                 |
| Adapters  | `oortmem/ai-sdk` (`@experimental`). LangGraph.js and OpenAI Agents JS appear as docs examples only.                                                                                                                                         |
| Docs      | `docs/sdk.md`: the five-line examples, every option and method, the error table, the billing table, library and serverless use, and the migration notes (§13.2).                                                                            |

**Deferred to 0.7 or later**, even though the design below covers them:

- `@oortmem/sdk` and the file move (§7.1);
- `mode: 'remote'` and all daemon and service-mode work (§8.1, §9.4);
- `forgetAll`;
- the `node:diagnostics_channel` events;
- the `Place` type and the `near` and `within` options (0.6 reserves these names in the docs
  only; §12);
- loading adapters lazily per role;
- client-side scrubbing of cloud requests;
- a configurable judgment cap;
- the LangGraph.js and OpenAI Agents JS adapter subpaths;
- the Python client.

**Order of work (each step independently testable):**

1. Merge CON-107 step 2.
2. Add `isAgentVia()` in core and switch every site to it (§6.3).
3. Split wiring: `wireEngine()` (principal-free), `principalFor()`, and the cloud check before the
   store (§3.5).
4. Build the facade, types and error mapping.
5. Add the judge rules and the shared counter.
6. Add the contract runner, the cases, and the fake cloud moved into a shared helper.
7. Build the `ai-sdk` adapter.
8. Write `docs/sdk.md`.
9. Before the release tag, run the gated live smoke test against Oort Cloud (§10.3).

## 2. Goals and non-goals

Goals:

- G1. A five-line TypeScript example (0.6.0) and a five-line Python example (0.7.0) that recall
  and observe, locally and against Oort Cloud.
- G2. Every memory feature from code: temporal recall, scopes, judgments (record, apply,
  confirm, list) and consolidation, with the CLI's safety rules.
- G3. Integrating with agent frameworks and self-hosted harnesses on AWS and GCP without reading
  engine internals.
- G4. One contract that both SDKs pass, so they cannot drift apart.

Non-goals for 0.6 and 0.7:

- sharing to Constellations, invites and keys (the CLI and the dashboard keep these);
- judgment packs, import, eval, withdraw and purge;
- a browser or edge-runtime build;
- spatial recall (§12).

## 3. Architecture

```
0.6.0
TypeScript app ──► oortmem (root export, packages/cli/src/sdk) ──┬─ local: @oortmem/core + store-sqlite, in-process
                                                                └─ cloud: HTTPS ─► api.oortcloud.dev /v1
0.7.0 adds
TypeScript app ──► @oortmem/sdk (re-exported by oortmem) ──────── remote: HTTP(S) ─► oort serve
Python app ──────► oortmem (PyPI) ──┬─ local:  HTTP over the Unix socket ─► oort serve ─► core
                                    ├─ remote: HTTPS over TCP + token ─► oort serve
                                    └─ cloud:  HTTPS ─► api.oortcloud.dev /v1
```

| Layer                     | Owns                                                                                              | Stability                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `@oortmem/core`           | Engine building blocks (recall, observe, judgment, grants, scrub)                                 | No promise; for advanced use only                     |
| `oortmem` root export     | `createOort`, options, keys, wiring, transports, error mapping, result views. Lives in `packages/cli/src/sdk/` in 0.6 and moves to `@oortmem/sdk` in 0.7 | Semver (§7.4)                                         |
| `oortmem/ai-sdk`          | The Vercel AI SDK adapter                                                                         | `@experimental`                                       |
| `oort serve`              | Hook frames (unchanged); the HTTP memory protocol (§8.1) **[0.7]**                                | Protocol `v1`                                         |
| `oortmem` (PyPI)          | `Oort`, `AsyncOort`, errors, integrations, and the existing `oort` launcher **[0.7]**             | Semver, versioned in lockstep with npm                |

### 3.1 Engine and principal (resolves how wiring splits)

`wire()` today resolves config, project, agent, store and adapters in one call, all for one cwd.
The SDK splits it in two:

- **`wireEngine(opts)`** returns a principal-free `Engine`: `{ config, mode, store?, cloud?,
  embed?, rerank?, decide?, write?, unavailable, routes, warnings, close }`. It resolves config
  once, from `home`, `cwd` and `projectConfig`, then lays `options.config` on top. In cloud mode
  it reads the Oort key and returns without opening or creating anything under `OORT_HOME`.
- **`principalFor(engine, { org, user, agent, project })`** returns a `Principal`:
  `{ scope, home, filter }`. Every operation takes `(engine, principal)`.
- **`scoped({ project })`** reuses the root's resolved config. It does not resolve a project
  config file for the new project, so a derived handle can never load another repository's
  `oort.config.json`.

The CLI and the MCP server keep calling `wire()`, now a thin wrapper over the two. They behave
exactly as before.

## 4. API surface

### 4.1 Construction and configuration

TypeScript:

```ts
import { createOort } from 'oortmem';

const oort = await createOort(); // what `oort setup` chose on this machine (scripts, laptops)
const cloud = await createOort({ mode: 'cloud' }); // the Oort key, from the env or the keychain
const mine = await createOort({ mode: 'local', keys: { voyage, typesafe, anthropic } });
const offline = await createOort({ config: { embed: { provider: 'local' }, rerank: { provider: 'local' } } });
await using svc = await createOort({ mode: 'remote', url: 'https://oort.internal:7807' }); // 0.7.0

export function createOort(options?: OortOptions): Promise<Oort>;
```

Python **[0.7]**:

```python
from oortmem import Oort, AsyncOort

oort = Oort()                                   # local through oort serve, or cloud, as `oort setup` chose
cloud = Oort(mode="cloud")                      # no Node needed
svc = Oort(mode="remote", url="https://oort.internal:7807", token=os.environ["OORT_SERVE_TOKEN"])
async with AsyncOort(mode="cloud") as aoort: ...
```

`createOort` is async because a local engine opens SQLite and reads key sources. `Oort(...)`
does no I/O: Python connects on the first call. Neither makes a network request at construction.

| Option (TS / Python)         | Type                                                 | Modes                       | Default                                                                                          |
| ---------------------------- | ---------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `mode`                       | `'auto' \| 'local' \| 'cloud'` (+ `'remote'` [0.7])  | all                         | `'auto'`: the store named in `$OORT_HOME/cloud.json`, as the CLI does, else `local`              |
| `home`                       | `string`                                             | local, auto                 | `OORT_HOME`, else `~/.oort`                                                                      |
| `cwd`                        | `string`                                             | local, cloud                | `process.cwd()`; used only to find the project and its config                                    |
| `project`                    | `string \| null`                                     | all                         | derived from `cwd` (§4.1.2); `null` means global memories only                                   |
| `projectConfig`              | `boolean`                                            | local                       | `true`. `false` skips the repository's `oort.config.json`, for a server whose cwd is a checkout  |
| `agent`                      | `string`                                             | all                         | `OORT_AGENT`, else anonymous (the Planet only)                                                   |
| `user`                       | `string`                                             | local (+ remote [0.7])      | unset, meaning the person (`self`). Setting it requires `org` (§6.4)                             |
| `org`                        | `string`                                             | local                       | `'local'`. Required, and not `'local'`, whenever `user` is set                                    |
| `keys`                       | `{ voyage?, typesafe?, anthropic?, oort? }`          | local; cloud (`oort` only)  | none. Held in `#private` fields (§6.6)                                                           |
| `keySources` / `key_sources` | `('explicit' \| 'env' \| 'keychain')[]`              | local, cloud                | all three; `keychain` is dropped when `OORT_NO_KEYCHAIN=1`                                       |
| `config`                     | deep partial of the home config                      | local                       | none. Laid over the resolved config (§4.1.3)                                                     |
| `url`                        | `string`                                             | cloud (+ remote)            | `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`                                               |
| `token`                      | `string`                                             | remote [0.7]                | `OORT_SERVE_TOKEN`                                                                               |
| `judge`                      | `{ role: 'agent' \| 'expert'; operator?: string }`   | local                       | `{ role: 'agent' }` (§6.3). Python: `judge_role=`, `operator=`                                   |
| `timeoutMs` / `timeout` (s)  | `number`                                             | cloud (+ remote, Py local)  | 30 s per request                                                                                 |
| `migrate`                    | `boolean`                                            | local                       | `true`, as every CLI command. `false` refuses an older store (fix `oort doctor`); see §13.1      |
| `env`                        | `Record<string, string \| undefined>`                | all                         | `process.env`                                                                                    |
| `fetch`                      | `typeof fetch`                                       | cloud (+ remote)            | the keep-alive pool (§4.4)                                                                       |
| `autostart`                  | `boolean`                                            | Py local [0.7]              | `True` (§8.1.6)                                                                                  |

An option that a mode does not take (for example `keys.voyage` with `mode: 'cloud'`) throws
`OortUsageError` at construction. It is never silently ignored. Every input object is checked
against a strict schema at runtime, so an unknown key is a usage error too. This is what makes
the reserved `place` field safe before it exists (§12).

**Python local mode is asymmetric, on purpose.** The engine runs inside `oort serve`, which reads
its own keys and config. So Python takes no vendor `keys` and no `config` overlay in local mode.
Passing either is a usage error that points at the daemon's environment and `oort keys set`.

#### 4.1.1 Key resolution

Each role (embed, rerank, decide, write) uses the first key found. The order matches the CLI's
`credentials.ts`, with explicit keys placed first:

| Order | Source                                                                                          | Notes                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1     | `keys.<vendor>`, given explicitly                                                               | Held in memory only, and never written, logged or put into an error (§6.6)                                            |
| 2     | `VOYAGE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` (env, non-empty)                      |                                                                                                                        |
| 3     | Keychain item `oort.<vendor>`, or `credentials.json` (mode 600) where there is no Keychain      | Skipped with `OORT_NO_KEYCHAIN=1`, or when `keySources` leaves out `keychain`                                          |
| 4     | The Oort key (`keys.oort`, then `OORT_API_KEY`, then Keychain `oort.oort`)                      | Routes the role through the Oort Pro relay. It is metered (§6.5), and `whoami().routes` shows it                       |
| —     | none                                                                                            | The role is unavailable. Recall degrades (warning `lexical-only`). A write throws `OortNeedsKeyError`                  |

**A local provider is a config choice, not a fallback.** With `embed.provider` or
`rerank.provider` set to `local` (by `oort models pull`, or by `options.config`), that role uses
the local model and reads no key at all. Without that setting, a missing key never falls back to
local models.

Cloud mode needs only the Oort key, found by steps 1 to 3 for `oort`. Without one it throws
`OortNeedsLoginError` (fix `oort login`).

#### 4.1.2 Project resolution

| Input                 | Project id                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project: 'acme-web'` | `cfg:acme-web`, the same namespace as `oort project link`. Host code is trusted to choose it.                                                    |
| `project: null`       | No project: global memories only                                                                                                                 |
| omitted               | `resolveProject(cwd, home)`, exactly as the CLI. A repository's `project.id` counts only with a trust link (otherwise warning `project-id-untrusted`) |

Python cloud mode **[0.7]** ports `projectIdFor`. The id is `<basename>-<sha256(main root)[:8]>`,
with worktrees resolved to the main checkout and links read from `project-links.json`. On macOS
it canonicalises case with `fcntl.F_GETPATH`, matching Node's `realpathSync.native`. Shared
vectors pin the port (§10). Services should pass `project` explicitly.

#### 4.1.3 Config

Local mode resolves config as the CLI does: the home `config.json`, then the project's
`oort.config.json` (unless `projectConfig: false`), with `serve` and `judge` read from the home
config only. `options.config` is laid on top. The overlay may set `judge`, because the host's code
is the operator, but not `serve`.

### 4.2 Result types (TypeScript; Python mirrors them as frozen dataclasses)

Fields are camelCase in TypeScript and on the wire, and snake_case in Python, converted
mechanically (`validFrom` → `valid_from`). Ids are always full ids, and times are ISO 8601.

```ts
export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'preference' | 'judgment';
export type MemoryStatus = 'current' | 'superseded' | 'corrected' | 'expired' | 'not-yet-valid' | 'withdrawn';
export type IncludeLevel = 'self' | 'planet' | 'star' | 'constellation' | 'galaxy';
export type RecallMode = 'current' | 'as-of' | 'history' | 'known-at';

export interface MemoryView {
  id: string;
  text: string; // scrubbed again on read (§6.1)
  type: MemoryType;
  tier: 'hot' | 'warm' | 'cold';
  pinned: boolean;
  status: MemoryStatus; // mapping below
  validFrom: string;
  validTo: string | null;
  recordedAt: string; // createdAt, the transaction time
  updatedAt: string;
  entities: string[];
  origin?: { level: IncludeLevel; space: string; author?: string; overriddenBy?: string };
  judgment?: JudgmentView;
}

export interface RecalledMemory extends MemoryView {
  score: number; // the fused score, comparable only within one result
  stale?: true;
  /** @experimental Diagnostic; may change in a minor release. */
  why: { lexicalRank?: number; denseRank?: number; reranked?: number; coverage: number; dense?: number; activation: number; chain?: true };
}

export interface Warning { code: string; message: string } // the oort.v1 warning codes

export interface RecallResult {
  memories: RecalledMemory[];
  abstained: boolean;
  temporal: { mode: RecallMode; asOf?: string; knownAt?: string; inferred: boolean };
  read: string[]; // the spaces read, as labels
  degraded: string[]; // core's Degradation values, plus 'hive-unavailable' in cloud mode
  warnings: Warning[];
}

export type Outcome = 'added' | 'reinforced' | 'updated' | 'superseded' | 'corrected' | 'skipped';
export interface ObserveResult {
  outcome: Outcome;
  memories: { outcome: Outcome; id?: string; supersedes?: string; reason?: string }[];
  counts: Partial<Record<Outcome, number>>;
  duplicate?: true; // cloud mode only: this turnRef was saved before (§4.4)
  warnings: Warning[];
}
export interface RememberResult { results: { fact: number; outcome: Outcome; id?: string; supersedes?: string; reason?: string }[]; warnings: Warning[] }
export interface PinResult { id: string; pinned: boolean; changed: boolean | null } // null: cloud mode cannot tell (204)

export interface Explanation {
  memory: MemoryView & { salience: number; activation: number; source: string };
  decisions: { stage: string; question: string; answer: string; probability: number }[];
  chain: { id: string; text: string; validFrom: string; validTo: string | null; endReason: 'superseded' | 'corrected' | 'expired' | null }[];
  hiddenLinks: number;
}

export interface RecordJudgmentView { outcome: 'added' | 'corrected' | 'unchanged'; id: string; corrects?: string; status: 'agent-recorded' | 'recorded'; redacted: string[]; embedFailed?: true }

export interface Whoami {
  mode: 'local' | 'cloud' | 'remote';
  account: string | null;
  agent: string | null;
  project: string | null;
  user: string | null;
  reads: string[];
  writesTo: string;
  version: string;
  routes: Record<'embed' | 'rerank' | 'decide' | 'write', 'own-key' | 'oort-pro' | 'local' | 'cloud' | 'missing'>;
}
```

**`MemoryStatus` mapping.** The first matching rule wins. This extends the MCP server's `status()`,
which has only four values, and every transport uses the same function.

| Order | Condition                                                         | Status          |
| ----- | ----------------------------------------------------------------- | --------------- |
| 1     | `judgment.withdrawn` is set                                       | `withdrawn`     |
| 2     | `isCurrent(m, now)`                                               | `current`       |
| 3     | `endReason === 'corrected'`                                       | `corrected`     |
| 4     | `endReason === 'superseded'`                                      | `superseded`    |
| 5     | `expiredAt !== null`, or `validTo` is at or before now            | `expired`       |
| 6     | otherwise (`validFrom` is after now)                              | `not-yet-valid` |

`JudgeResult`, `JudgmentView` and `ConsolidateResult` are core's types (`judgment.ts`,
`consolidate.ts`) cut down to their documented fields. Every `Memory` becomes an id, embeddings
are dropped, and `JudgeResult.decisions` is `@experimental`. `JudgmentView` adds `status`,
`confirmed: boolean` and `agentRecorded: boolean`, where `agentRecorded` is `isAgentVia(via) &&
!confirmed`.

### 4.3 Methods

| TypeScript                                                      | Python [0.7] (`AsyncOort`: the same, `async def`)                                                                 | Returns                       | Local       | Cloud                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------- | -------------------------- |
| `recall(query: string, opts?: RecallOptions)`                   | `recall(query, *, limit=10, mode=None, as_of=None, known_at=None, include=None, budget_chars=None, include_withdrawn=False, speed="full", infer_time=True)` | `RecallResult`                | yes         | yes                        |
| `observe(turn: Turn, opts?: { signal? })`                       | `observe(turn: Turn \| Mapping)`                                                                                  | `ObserveResult`               | yes         | yes                        |
| `remember(facts: string \| readonly string[], opts?: { type? })` | `remember(facts, *, type=None)`                                                                                  | `RememberResult`              | yes         | yes                        |
| `forget(id: string, opts?: { everywhere?: boolean })`           | `forget(id, *, everywhere=False)`                                                                                 | `{ forgotten; withdrawn? }`   | yes         | yes (`everywhere` is cloud-only) |
| `pin(id)` / `unpin(id)`                                         | `pin(id)` / `unpin(id)`                                                                                           | `PinResult`                   | yes         | yes (`changed: null`)      |
| `explain(id)`                                                   | `explain(id)`                                                                                                     | `Explanation`                 | yes         | yes                        |
| `recent(opts?: { since?: string \| Date; limit?: number })`     | `recent(*, since=None, limit=20)`                                                                                 | `{ memories: MemoryView[] }`  | yes         | yes (`since` filtered on the client, §4.4) |
| `judge.record(input: JudgmentInput)`                            | `judge.record(*, subject, verdict, reason, domain, by, ref=None, verdicts=None, criteria=None, decided_at=None)` | `RecordJudgmentView`          | yes         | `refused`                  |
| `judge.apply(item: string \| JudgeItem, opts?: JudgeOptions)`   | `judge.apply(item, *, details=None, domain=None, by=None, limit=5, threshold=0.7, include_imported=False, include_agent_recorded=False)` | `JudgeResult`                 | yes         | `refused`                  |
| `judge.confirm(id)`                                             | `judge.confirm(id)`                                                                                               | `{ id; changed }`             | expert only | `refused`                  |
| `judge.list(opts?: { domain?; by?; all?; limit? })`             | `judge.list(*, domain=None, by=None, all=False, limit=100)`                                                       | `{ judgments: JudgmentView[] }` | yes       | `refused`                  |
| `consolidate(opts?: { budgetMs?; signal? })`                    | `consolidate(*, budget_ms=None)`                                                                                  | `ConsolidateResult`           | yes         | `refused`                  |
| `whoami()`                                                      | `whoami()`                                                                                                        | `Whoami`                      | yes         | yes                        |
| `scoped(s: { user?; project?; agent?; judgeRole?: 'agent' })`   | `scoped(*, user=None, project=None, agent=None, judge_role=None)`                                                 | a new handle                  | yes         | `project`, `agent` only    |
| `close()`, `[Symbol.asyncDispose]()`                            | `close()`, `__enter__`/`__exit__` (`__aenter__`/`__aexit__`)                                                      | `void`                        |             |                            |
| `formatForPrompt(r, opts?: { budgetChars? })` (a function)      | `format_for_prompt(r, *, budget_chars=None)`                                                                      | `string`                      | both        | both                       |
| `forgetAll({ confirm: 'forget-all' })` **[0.7]** `@experimental` | `forget_all(*, confirm)`                                                                                         | `{ forgotten: number }`       | yes         | `refused`                  |

```ts
export interface RecallOptions {
  limit?: number; // 1–50, default 10
  mode?: RecallMode;
  asOf?: string | Date; // valid time
  knownAt?: string | Date; // transaction time
  include?: IncludeLevel[]; // narrows only (§5 for the error codes)
  budgetChars?: number;
  includeWithdrawn?: boolean;
  speed?: 'full' | 'fast' | 'lexical'; // full: embed and rerank; fast: no rerank; lexical: no model call
  inferTime?: boolean; // default true: "on 2 April" picks as-of, as the CLI and MCP do
  signal?: AbortSignal;
}

export interface Turn {
  user: string;
  assistant: string;
  tools?: string[]; // tool-call summaries; truncated to 16 × 512 bytes, never refused
  at?: string | Date; // default now
  sessionId?: string;
  turnRef?: string; // at most 128 characters; deduplicated in cloud mode only (§4.4)
}

export interface JudgmentInput {
  subject: string; ref?: string; verdict: string; verdicts?: readonly string[];
  reason: string; criteria?: readonly string[]; domain: string; by: string; decidedAt?: string | Date;
}
export interface JudgeItem { summary: string; details?: string; ref?: string; domain?: string; by?: string }
export interface JudgeOptions { limit?: number; threshold?: number; minSimilarity?: number; minAgreement?: number; includeImported?: boolean; includeAgentRecorded?: boolean }
```

### 4.4 Semantics worth pinning down

- **Temporal rules** match the MCP server's `viewOf` exactly:
  - `mode: 'as-of'` needs `asOf`, and `'known-at'` needs `knownAt`;
  - `'current'` and `'history'` take neither date;
  - giving both `asOf` and `knownAt` is a usage error;
  - without `mode`, a single date picks the view;
  - with neither, `inferTime` decides.
- **Ids.** An id is either a full id or a unique prefix of at least 8 characters, which is Oort
  Cloud's `MIN_ID_PREFIX`. That is stricter than the CLI's any-length prefix locally, so the
  behaviour is the same everywhere.
  - Several matches throw `OortAmbiguousIdError`.
  - An id outside the handle's grant throws `OortNotFoundError`. It is indistinguishable from an
    unknown id.
- **`remember`** frames each fact as a user statement and runs it through the write path, as the
  MCP tool and the cloud backend do. Each call takes up to 5 facts of at most 500 characters.
- **`observe`** runs the full write path (scrub, gate, writer, reconcile) and can take seconds.
  - In a request handler, call it after answering.
  - In a serverless function, await it before returning.
  - `turnRef` is deduplicated by Oort Cloud only (it answers `duplicate: true`). The local engine
    records `turnRef` but does not deduplicate on it, so a local retry may write twice. Local
    deduplication is [later].
- **Abort.** An aborted `signal` stops the SDK from waiting and rejects with the abort reason. A
  write already sent (cloud) or already started (local) may still land. In cloud mode, retry with
  the same `turnRef`.
- **`recent`, cloud.** `GET /v1/memories` has no `since`, so the SDK pages through at most 500
  memories (5 pages of 100), filters on `updatedAt >= since`, sorts newest first and returns
  `limit`. When the cap cuts the scan, it adds warning `recent-truncated`.
- **Star agents in cloud mode** cannot write (`refuseStarInCloud`). `observe`, `remember`,
  `forget`, `pin` and `unpin` throw `OortRefusedError` (`star-in-cloud`).
- **`scoped()`** shares the root's engine and connections and returns a cheap, immutable handle.
  - `child.close()` does nothing. `root.close()` closes everything.
  - Calling any handle after `root.close()` throws `OortUsageError` (`closed`).
  - `judgeRole` can only go from `expert` to `agent`.
  - `scoped({ user: 'self' })` is refused, so a derived handle can never reach the person's own
    memories (§6.4).
- **Concurrency.** One handle is safe for concurrent calls. A local SQLite lock wait past
  `busyTimeoutMs` (5000) throws `OortInternalError` (`store-busy`, retryable).
- **Lifecycle [0.6].**
  - Local mode imports and builds the adapters for every role during `createOort`. The vendor
    packages load through `import()`, but eagerly, at wire time, as `wire()` does today. Lazy
    loading per role is [0.7].
  - Cloud mode imports none of them.
  - `close()` is idempotent and closes the store and the local model sessions.
- **The keep-alive pool** (`cloud-http.ts`) is process-global today. The SDK reference-counts it:
  each root handle in cloud mode takes a reference, and `closeCloudPool()` runs when the last one
  closes. Pool sockets are `unref()`'d, so a process that never calls `close()` can still exit.

### 4.5 Limits (the same on every transport)

| Input              | Limit                                                                 | Source                    |
| ------------------ | --------------------------------------------------------------------- | ------------------------- |
| `recall` query     | 2,048 UTF-8 bytes                                                     | cloud `recallTextBytes`   |
| `recall` `limit`   | 1 to 50                                                               | cloud `recallK`           |
| `observe` turn     | 128 KiB total, the only hard limit. The engine keeps 32 KiB of text after scrubbing | cloud `observeBytes`, core `cap.ts` |
| `tools` summaries  | Truncated to 16 × 512 bytes; never an error                           | core `capObservation`     |
| `turnRef`          | 128 characters                                                        | SDK                       |
| `remember`         | 5 facts × 500 characters                                              | `@oortmem/mcp`            |
| Judgment fields    | `JUDGMENT_LIMITS`                                                     | core                      |
| `recent` `limit`   | 1 to 100                                                              | cloud `listLimit`         |

Anything over a hard limit throws `OortUsageError` before any I/O. The error names the field,
never its value.

## 5. Errors

```ts
export type OortErrorCode =
  | 'usage' | 'not-found' | 'ambiguous-id' | 'needs-key' | 'needs-login'
  | 'needs-confirmation' | 'cloud-only' | 'network' | 'refused' | 'internal';

export class OortError extends Error {
  readonly code: OortErrorCode;
  readonly fix: string | null; // a runnable `oort …` command where one fixes it, else null
  readonly reason?: string; // finer, stable strings (table below)
  readonly status?: number; // HTTP status (cloud, remote)
  readonly retryable: boolean;
}
export class OortUsageError extends OortError {}
export class OortNotFoundError extends OortError {}
export class OortAmbiguousIdError extends OortError {}
export class OortNeedsKeyError extends OortError { readonly role: 'embed' | 'rerank' | 'decide' | 'write'; readonly envVar: string }
export class OortNeedsLoginError extends OortError {}
export class OortNeedsConfirmationError extends OortError {}
export class OortCloudOnlyError extends OortError {}
export class OortNetworkError extends OortError {}
export class OortRefusedError extends OortError {}
export class OortInternalError extends OortError {}
```

Python **[0.7]** uses the same class names, subclassing `OortError(Exception)`, with the
attributes `code`, `fix`, `reason`, `status` and `retryable`.

`refused` is the tenth code. CON-107's first draft did not list it, but CON-107 step 2 adds it
(docs/cli.md, "JSON output"). Without it, a plan limit or a role rule would read as `usage` and
tell an agent to change its arguments.

**Built on `describeError`.** CON-107 step 2's `describeError` (`packages/cli/src/output.ts`,
which is not on main yet) holds the cloud-kind mapping, the network-error detection and the
usage and refused error sets. The facade calls it, then:

- drops the CLI-only fixes ("again with `--yes`", `oort --help`);
- adds `reason`;
- adds the cases below that the CLI never raises.

| Source                                                                                     | Code                                                         | `reason`                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Option or argument validation, `JudgmentInputError`, `ExportFormatError`                   | `usage`                                                      | `invalid-argument`                                                     |
| `user` without `org`, `org: 'local'` with `user`, `scoped({ user: 'self' })`               | `usage`                                                      | `principal-required`, `self-not-derivable`                             |
| `EmbedderMismatchError`                                                                    | `usage` (fix `oort reembed`)                                 | `embedder-mismatch`                                                    |
| `MissingCredentialError`, or a role missing for a write                                    | `needs-key` (fix `oort models pull` or `oort keys set <p>`)  | `missing-key`                                                          |
| No Oort key; cloud or relay 401                                                            | `needs-login` (fix `oort login`)                             | `no-key`, `key-rejected`                                               |
| `include` naming `constellation` or `galaxy` in local mode                                 | `cloud-only` (fix `oort cloud use`)                          | `hive-level`                                                           |
| Any other `include` level the grant lacks (`star` for an anonymous agent or an end user), `GrantError`, `ScopeDeniedError` | `refused`                         | `scope-denied`                                                         |
| A Star agent writing in cloud mode, or a Star agent with `user` set                        | `refused`                                                    | `star-in-cloud`, `star-with-user`                                      |
| Judgments or `consolidate` in cloud mode                                                   | `refused`                                                    | `local-only`                                                           |
| Agent-role judgment rules (§6.3)                                                           | `refused`                                                    | `experts-not-listed`, `not-an-expert`, `daily-limit`, `expert-only`    |
| Cloud 402, or 403 (`cloud_not_enabled`, `hive_not_enabled`, other), or 429                 | `refused`                                                    | `payment-required`, `not-enabled`, `hive-not-enabled`, `rate-limit`    |
| Cloud 400, 413                                                                             | `usage`                                                      | `bad-request`, `too-large`                                             |
| Cloud 404, or a store miss                                                                 | `not-found`                                                  |                                                                        |
| Cloud 409 `ambiguous`, or several local prefix matches                                     | `ambiguous-id`                                               |                                                                        |
| Cloud 409 `preview_required` or `findings_unacknowledged`                                  | `needs-confirmation`. **Defined in the facade:** today `cloudErrorKind` turns any 409 other than `ambiguous` into `bad-request`, which `describeError` maps to `usage` | `preview-required`, `findings-unacknowledged`                          |
| A cloud-only option in local mode (`forget({ everywhere })`)                               | `cloud-only`                                                 |                                                                        |
| Connection refused, reset, DNS failure or timeout; cloud 5xx                               | `network`, retryable                                         | `unreachable`, `timeout`, `busy`                                       |
| `StoreMigrationRequiredError` with `migrate: false`                                        | `refused` (fix `oort doctor`)                                | `migration-required`                                                   |
| SQLite busy                                                                                | `internal`, retryable                                        | `store-busy`                                                           |
| Python local: no Node, or the daemon is too old [0.7]                                      | `usage`                                                      | `node-missing`, `daemon-outdated`                                      |
| An unknown input key such as `place`, `near` or `within` before CON-84                     | `usage`                                                      | `invalid-argument` (`spatial-unavailable` from 0.7, once the names are reserved in the schemas) |
| Anything else                                                                              | `internal`                                                   | none                                                                   |

A **degraded recall is not an error.** It returns results and fills `degraded` and `warnings`
with the `oort.v1` codes (`lexical-only`, `recall-degraded`, `time-mode-unreported`). The SDK
never prompts.

## 6. Safety parity with the CLI

### 6.1 Secrets in memory text

- **Locally,** core scrubs.
  - `observe` drops a turn that holds a secret (`scrubObservation`).
  - `recall` scrubs the query before an embedder or reranker sees it.
  - Judgments redact secrets from their text.
  - The SDK passes data straight to core, so it inherits all three.
- **On read,** every text field the SDK returns goes through `scrub()` again, like the MCP
  server's `clean`. That catches memories stored before a rule existed.
- **Cloud mode [0.6]** works as the CLI does today. Turns and queries are sent as given (`oort
  observe` and `oort recall` send them raw), and Oort Cloud scrubs before anything is stored or
  reaches a model. The hooks are the exception: they scrub before queueing, and they keep doing
  so. Client-side scrubbing in the SDK is [later] (Q3), done from one shared rule table rather
  than a port.
- **Guarantee in every mode:** a secret is never stored and never sent to a model vendor, because
  scrubbing runs wherever the engine runs. The contract suite asserts that no fixture secret ever
  comes back in a result (§10).

### 6.2 Output escaping

The SDK returns data, not rendered text. Nothing in it is escaped for HTML or a terminal, because
the caller decides where the text goes. Two exceptions:

- **`formatForPrompt`** builds the `<oort-memory>` block the hooks inject. It escapes block tags
  (`escapeBlockTags`) and space labels (`escapeLabelText`), so a stored memory cannot close the
  block or forge a label. Adapters inject memory only through it. Python ports these two
  functions [0.7].
- **Expert ids** in agent-facing strings pass through `safeExpertId`.

### 6.3 Judgment expert rules

| Rule                                         | `judge.role: 'agent'` (default)                                                                                                                                 | `judge.role: 'expert'`                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Who may appear in `by`                       | Only experts in `judge.experts`, read from the home config or the `config` overlay. With none listed: `refused`, reason `experts-not-listed`                    | Anyone, as `oort judge record --by` allows                   |
| Daily cap                                    | `MCP_JUDGMENTS_PER_DAY` (50) per Oort home, shared with MCP. Same counter and lock files (`judge-mcp-count.json`, `judge-mcp-count.lock`), names unchanged, so 0.5.x and the SDK count against one cap | None                                                         |
| Stored as                                    | `via: 'mcp'`, `source.harness: 'sdk'`. Agent-recorded and unconfirmed for every reader, 0.5.x included. It never corrects a person's judgment                    | `via: 'sdk'`, which counts as a person's, as core means today |
| `judge.confirm`                              | `refused`, reason `expert-only`                                                                                                                                 | Allowed. Records `confirmed: { by: operator }`               |
| Through framework tools                      | Always this role                                                                                                                                                | Never: adapters call `scoped({ judgeRole: 'agent' })`        |
| Over the TCP service listener [0.7]          | Allowed                                                                                                                                                         | Refused: a service token is not a person                     |

`operator` defaults to `judge.operator` in the home config, else `local-user`.

**Core change [0.6]: one `isAgentVia()` helper.** Add `isAgentVia(via: JudgmentVia): boolean`
(true for `'mcp'`) to `judgment.ts`. Replace every literal `via === 'mcp'` and `via !== 'mcp'`
with it:

- `judgment.ts`: 256, 269 (`isUnconfirmedAgentJudgment`), 453, 473 and 553;
- `commands/judge.ts`: 137, 379 and 497;
- `mcp.ts`: 532 and 562.

The helper defines agent-recorded in one place. A later agent `via` value then cannot slip past
the "an agent never retracts a person's judgment" rule at one site while the others hold it. No
new `via` value ships in 0.6.

**The cap counter** moves out of `mcp.ts` into a shared module (`reserveAgentJudgment` and
`refundAgentJudgment`) that both the MCP server and the SDK call. The file and lock names do not
change.

**Adapters never pass `includeAgentRecorded` or `includeImported` to the model.** Their judge tool
has no such parameter, so a model cannot widen what counts as precedent. A host that wants
agent-recorded precedents calls `judge.apply` itself.

**Documented limits.**

- The cap is per Oort home, not per agent or per user.
- Every process running as the same OS user can use the same home, and the same daemon socket in
  0.7, as that person. That is the same trust as the CLI and the hooks.

**Why the agent default.** The rule protects the expert's record from the model, not from the
developer. So expert mode is one explicit option, meant for host code paths where a person really
decided, such as a review UI or an import job.

### 6.4 Grants, scopes and the default principal

- Each handle has one principal: org, user (stored as `customerId`), agent and project. It is set
  at construction or by `scoped()`, and no method takes a scope argument. Reads and writes go
  through `localGrant` with the agent's home, so the store enforces isolation.
- **End users get the Planet only [0.6].** `starNode` is keyed by `(orgId, agentId)` alone
  (`grant.ts`, `starNode`). So two end users served by the same agent in one org would share one
  Star, and what the agent learned about one user would be readable for the other. Until CON-92
  adds per-user agent memory (Orbits):
  - a handle with `user` set gets a Planet-only grant: `nodeGrant` with the agent as principal and
    the user's Planet as its only read and write node, so there is no Star;
  - `include: ['star']` on such a handle throws `refused`;
  - an agent configured as a Star (`agents.json`) together with `user` is refused at construction
    (`star-with-user`);
  - the agent id is still recorded as the author.
- **Explicit principal for end users.**
  - Setting `user` requires `org` to be set and not `'local'`.
  - `scoped({ user: 'self' })` is refused.
  - So a server bug that drops the user id cannot fall back to the person's own memories. It
    fails with `usage` (`principal-required`).
- **`mode: 'auto'` stays the default** for scripts and laptops. Server docs always pass `mode`,
  `home`, `org`, `project` (or `null`), `projectConfig: false` and `keySources` explicitly.
- `include` is intersected with the grant. A hive level in local mode throws `cloud-only`, and any
  other gap throws `refused`. It is never a wider read.
- `agent` and `user` are validated: `isAgentId`, and for `user` the pattern
  `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`. They are configuration, not authentication. The trust
  boundary is the handle that host code gives to model-facing tools.
- **Cloud mode.** The Oort key's scope applies, and `agent` reads only the Constellations that
  agent is attached to. `user` is a usage error in cloud mode until CON-92.

### 6.5 Billing: which calls cost what

No model is called at construction, by `whoami`, or by any read of stored records. "Vendor" means
either your own key (billed by that vendor) or the Oort key through the Oort Pro relay (metered
against your Oort account). `whoami().routes` shows which one applies to each role.

| Call                                                                                                  | Local, own keys or Oort Pro relay                                                                                                     | Local models                  | Cloud mode                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `recall`                                                                                              | Voyage embed (skipped on a cache hit or a confident lexical answer) and Voyage rerank (skipped when confident, or with `speed: 'fast'`). `speed: 'lexical'`: no model call | none                          | Metered Oort Cloud recall                               |
| `observe`                                                                                             | TypeSafe gate, always. If kept: one Anthropic writer call, one batched Voyage embed, and a TypeSafe reconcile per fact (or one batched call) | Gate, writer and reconcile still need keys | Metered Oort Cloud observe                              |
| `remember`                                                                                            | One `observe` per fact                                                                                                                | as above                      | One metered observe per fact                            |
| `judge.record`                                                                                        | One Voyage embed                                                                                                                      | none                          | `refused`                                               |
| `judge.apply`                                                                                         | One Voyage embed and one TypeSafe judge call                                                                                          | TypeSafe judge only           | `refused`                                               |
| `forget`, `pin`, `unpin`, `explain`, `recent`, `judge.list`, `judge.confirm`, `consolidate`, `whoami` | none                                                                                                                                  | none                          | No model call. Reads and deletes are `billing: any` routes in the cloud contract |

The relay is used only when a role has no vendor key and an Oort key is present, as in the CLI.
`keySources: ['explicit']` turns off every implicit source.

### 6.6 Key and secret handling in the SDK

- **Explicit keys stay private.** TypeScript keeps them in `#private` class fields, never on an
  enumerable property. So `console.log(oort)`, `JSON.stringify` and `util.inspect` cannot show
  them, and a custom `[util.inspect.custom]` prints `Oort { mode, scope }`.
- **Wrapped vendor and constructor errors keep the error's `name` only**, as `wire.ts`'s
  `load()` does today ("could not be constructed (Name)"). They never keep a message or a cause
  that could echo an option. Cloud errors use the CLI's fixed messages (`OortCloudError`).
- **Python [0.7]** wraps the Oort key and the service token in a `_Secret` type whose `repr` and
  `str` print `'***'`. It refuses to read `credentials.json` when the file is readable by group
  or others. It autostarts the daemon with an allowlisted environment only (§8.1.6).

## 7. Packaging (TypeScript)

### 7.1 Packages and exports

**0.6.0.** `packages/cli` (`oortmem`):

```json
{
  "sideEffects": ["./dist/main.js"],
  "exports": {
    ".": { "types": "./dist/sdk/index.d.ts", "default": "./dist/sdk/index.js" },
    "./ai-sdk": { "types": "./dist/sdk/adapters/ai-sdk.d.ts", "default": "./dist/sdk/adapters/ai-sdk.js" },
    "./package.json": "./package.json"
  },
  "bin": { "oort": "dist/main.js", "oortmem": "dist/main.js" },
  "peerDependencies": { "ai": "^7" },
  "peerDependenciesMeta": { "ai": { "optional": true } }
}
```

`packages/cli/src/sdk/` holds `index.ts` (the exports), `create.ts`, `types.ts` (hand-written
public types; core's internals never leak into the `.d.ts`), `errors.ts`, `principal.ts`,
`local.ts`, `cloud.ts`, `judge.ts`, `views.ts` (the result shaping and `MemoryStatus`) and
`adapters/ai-sdk.ts`.

The SDK must not import `commands/*.ts`. `commands/recall.ts`, `explain.ts` and `inspect.ts` import
`ui.ts`, and through it `picocolors`. So `runRecall`, `timeMode` and `supersedeChain` move into
UI-free modules (`src/engine/`) that both the commands and the SDK import.

**0.7.0: `@oortmem/sdk`.** The facade and its wiring move into `packages/sdk`, and `oortmem`'s root
becomes `export * from '@oortmem/sdk'`. The modules to move form the wiring's import closure:

| File                                     | Why it moves                                   | Notes                                                                                                      |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `wire.ts`                                | Becomes `wireEngine` and `principalFor`        | Its `@oortmem/claude-code` import (`createHookLogger`) stays in the CLI wrapper                           |
| `credentials.ts`, `keychain.ts`, `credentials-file.ts` | Key resolution                   |                                                                                                            |
| `relay.ts`                               | Oort Pro routing                               |                                                                                                            |
| `local-models.ts`                        | The local provider loader                      |                                                                                                            |
| `embed-cache-disk.ts`                    | The query embedding cache (local mode)         |                                                                                                            |
| `cloud.ts`, `cloud-http.ts`              | The Oort Cloud client and the keep-alive pool  | `cloud.ts` also holds the `cloud.json` settings read and write                                             |
| `util.ts` (part)                         | `Refusal`, `echo`, `shown`, `writeGrant`, `findMemory` | Split: the prompt and confirm helpers and `Ctx` stay in the CLI                                            |
| `io.ts` (type only)                      | `Env`                                          | The type moves; `io.ts` itself stays                                                                       |
| `remember.ts`, `src/engine/*`            | Used by `remember`, `recall` and `explain`     | `remember.ts` imports `commands/observe.ts` for `turnObservation`, which moves too                         |
| `output.ts` (part)                       | `describeError` and its tables                 | The envelope and printing stay in the CLI                                                                  |

`@oortmem/sdk` takes `sideEffects: false` and `exports["."]`. Its dependencies are core,
store-sqlite, the four adapter packages and `undici`, with `@oortmem/local-models` as an optional
peer. The first publish of the new package is a manual bootstrap, before trusted publishing takes
over, so it needs its own release step.

### 7.2 What a library user pulls in

| Concern          | Decision                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load time [0.6]  | The root export never imports `commander`, `@clack/prompts`, `@modelcontextprotocol/server`, `picocolors`, `smol-toml`, `jsonc-parser` or `ui.ts`. A test walks the module graph of `import('oortmem')` and fails on any of them.                                                       |
| Cloud mode [0.6] | `@oortmem/store-sqlite` is imported dynamically, only when a local engine opens. The cloud check (`cloud.json`, the explicit `mode`) runs before any store is opened. Today `wire.ts` imports the store statically (line 25), opens `oort.sqlite` at line 395 and checks the cloud mode only at line 442. A second test asserts that cloud mode loads no `.node` binary and creates no file under a temporary `OORT_HOME`. |
| Install size     | `oortmem` still installs the CLI's dependencies, which are small and pure JS. From 0.7, `@oortmem/sdk` gives the same API without them.                                                                                                                                                 |
| Native modules   | `better-sqlite3` and `sqlite-vec` are installed with `oortmem`. Bundlers for serverless should mark `@oortmem/store-sqlite` as external (§9.1.1).                                                                                                                                       |
| Vendor SDKs      | Installed with `oortmem`, loaded by `import()` at wire time in local mode, and not at all in cloud mode.                                                                                                                                                                                |
| Tree-shaking     | `sideEffects` is limited to `dist/main.js`, the bin, so everything else can be dropped. Adapters are subpath exports, so a bundler never sees a framework the app doesn't use.                                                                                                          |
| ESM and CJS      | ESM only. Node 22.12 and later load ESM from `require()`, so with the 22.15 floor, `require('oortmem')` works as long as the graph has no top-level await. A CI test runs it. There is no dual build.                                                                                    |
| Node floor       | 22.15.0. Bun and Deno are best effort and untested.                                                                                                                                                                                                                                     |

### 7.3 `@oortmem/core`

`@oortmem/core` keeps its building-block exports for store authors and advanced users. Its README
says it carries no stability promise and that apps should use `oortmem`.

### 7.4 Stability promise

- **Before 1.0.** A breaking change to anything not marked `@experimental` lands only in a minor
  release (0.6 to 0.7). It is listed under "Breaking" in the notes, and where possible it is
  deprecated for one minor first. A patch release only adds or fixes.
- **`@experimental`, may change in any minor:**
  - the `ai-sdk` adapter and every later adapter;
  - `RecalledMemory.why` and `JudgeResult.decisions`;
  - from 0.7: `mode: 'remote'`, `forgetAll`, `Place`, and the diagnostics payloads.
- **Additive changes are always allowed.** That means new optional options, result fields,
  `reason` and warning strings, and higher limits. Callers must ignore unknown fields.
- **1.0** comes when both SDKs pass the shared suite and the stable surface has gone one minor
  without a breaking change.
- **Versions move in lockstep** on npm and PyPI (0.7.x).

## 8. Python [0.7]

Package: `oortmem` on PyPI. It keeps the `oort` and `oortmem` console scripts (the launcher) and
adds:

```
oortmem/
  __init__.py        __version__, plus lazy (PEP 562 __getattr__) access to Oort, AsyncOort, format_for_prompt, errors
  _transport.py      HTTP/1.1 over AF_UNIX and over TCP/TLS (http.client, socket, ssl); never follows redirects
  _cloud.py          the Oort Cloud mapping (§8.2)
  _project.py        project id derivation (§4.1.2)
  _keys.py           Oort key lookup: explicit, env, credentials.json (mode-checked), macOS Keychain via /usr/bin/security
  _secret.py         _Secret: repr and str print '***'
  _daemon.py         find, version-check and autostart oort serve
  types.py, errors.py, integrations/{langgraph,openai_agents,crewai}.py (frameworks imported lazily), py.typed
```

| Decision         | Choice                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies     | **None at runtime**: only `http.client`, `ssl`, `json` and `dataclasses`. Extras install frameworks only: `oortmem[langgraph]`, `oortmem[openai-agents]`, `oortmem[crewai]`.                                                                            |
| Async            | `AsyncOort` runs the sync client through `asyncio.to_thread` with a bounded pool (default 8). Cancelling stops the wait, but a request already in flight still runs. A native async transport is Q5.                                                   |
| Python floor     | **3.10** for the client. `import oortmem` must keep working on 3.9, because the launcher's entry point (`oortmem.cli:main`) imports the package. So `__init__` imports nothing 3.10-only, and its `__getattr__` raises `ImportError("oortmem.Oort needs Python 3.10 or newer")` when `Oort` is accessed on 3.9. |
| Typing           | Full annotations, `py.typed`, `Literal` modes and codes, frozen dataclasses (`slots=True`).                                                                                                                                                              |
| Windows          | Cloud and remote modes are supported. Local mode is not (§13.3).                                                                                                                                                                                        |

### 8.1 Local transport: the memory protocol on `oort serve`

#### 8.1.1 HTTP on the existing socket, plus an opt-in TCP listener

`oort serve` today speaks length-prefixed JSON frames on a Unix socket, with the methods `ping`,
`status`, `stop`, `hook` and `recall`. The SDK adds **HTTP/1.1 with JSON** rather than more frame
methods:

- **One protocol for every network shape.** The same routes serve a laptop (the socket) and a
  sidecar or VPC service (TCP), and they mirror Oort Cloud's `/v1`. Python has one HTTP client,
  TypeScript's `remote` mode reuses the cloud client's code, and `curl --unix-socket` works.
- **Hooks keep frames.** Their path has a budget of a few milliseconds and loads no HTTP parser.
- **First-byte routing on each connection.** A frame always starts with `0x00`, because its
  big-endian length is at most 4 MiB. An HTTP request starts with an ASCII method letter. For
  each connection, the daemon:
  - reads the first chunk, then `socket.unshift(chunk)`s it back;
  - hands the socket either to the frame decoder or to an internal `http.Server`
    (`server.emit('connection', socket)`);
  - never mixes the two protocols on one connection.
- **Hardened socket.**
  - The two protocols have separate connection caps: hook frames keep 64, HTTP gets 32.
  - The HTTP side sets `maxHeaderSize` 16 KiB, a 4 MiB body limit, `headersTimeout` 10 s and
    `requestTimeout` 30 s.
  - Requests with an `Origin` header are refused, so a browser page cannot reach the daemon.
  - No response carries CORS headers.

#### 8.1.2 Routes

Every route answers in the `oort.v1` envelope: `{ schema: "oort.v1", ok: true, data, warnings }`
or `{ schema: "oort.v1", ok: false, error: { code, message, fix, reason? } }`. Bodies are checked
against strict zod schemas. From 0.7, `place`, `near` and `within` are named, reserved fields that
answer `spatial-unavailable` (§12).

| Method and path                                 | SDK call            | Oort Cloud equivalent                        |
| ----------------------------------------------- | ------------------- | -------------------------------------------- |
| `GET /v1/health`                                | (handshake)         | `GET /health`                                |
| `GET /v1/whoami`                                | `whoami`            | `GET /v1/whoami`                             |
| `POST /v1/recall`                               | `recall`            | `POST /v1/recall` (`limit` → `k`)            |
| `POST /v1/observe`                              | `observe`           | `POST /v1/observe`                           |
| `POST /v1/remember`                             | `remember`          | none; the client maps it to `observe` (§8.2) |
| `GET /v1/memories?since=&limit=`                | `recent`            | `GET /v1/memories`                           |
| `GET /v1/memories/:id`                          | (used by `explain`) | `GET /v1/memories/:id`                       |
| `GET /v1/memories/:id/explain`                  | `explain`           | none; built from `GET`                       |
| `DELETE /v1/memories/:id`                       | `forget`            | `DELETE /v1/memories/:id`                    |
| `POST /v1/memories/:id/pin`, `/unpin`           | `pin`, `unpin`      | same                                         |
| `POST /v1/judgments`                            | `judge.record`      | none (`refused`)                             |
| `POST /v1/judgments/apply`                      | `judge.apply`       | none                                         |
| `POST /v1/judgments/:id/confirm`                | `judge.confirm`     | none                                         |
| `GET /v1/judgments?domain=&by=&all=&limit=`     | `judge.list`        | none                                         |
| `POST /v1/consolidate`                          | `consolidate`       | none                                         |
| `POST /v1/forget-all`                           | `forgetAll`         | none                                         |
| `GET /healthz`, `GET /readyz`, `GET /metrics`   | operations (§9.4)   |                                              |

HTTP status codes:

| Status | Codes                                       |
| ------ | ------------------------------------------- |
| 200    | success                                     |
| 400    | `usage`                                     |
| 401    | `needs-login`                               |
| 403    | `refused`, `cloud-only`                     |
| 404    | `not-found`                                 |
| 409    | `ambiguous-id`, `needs-confirmation`        |
| 413    | `usage`                                     |
| 503    | `network` (`busy`, `shutting-down`)         |
| 500    | `internal`                                  |

The envelope's `code` wins over the status.

#### 8.1.3 Scope on each request

| Header                    | Meaning                                                                                                                                                                                                   | Unix socket        | TCP listener                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------- |
| `Oort-Cwd`                | Absolute path that selects the project, as the hook's `cwd` does. Like the hooks, the daemon then **reads that project's `oort.config.json`** (only its non-home keys; `serve` and `judge` are ignored there) and its trust link. No header names a file to write. | yes                | refused                       |
| `Oort-Project`            | An explicit project id (becomes `cfg:<id>`), or `-` for none. Uses the home config only                                                                                                                  | yes                | yes (required; `-` allowed)   |
| `Oort-Agent`              | Agent id                                                                                                                                                                                                  | yes                | yes                           |
| `Oort-User`, `Oort-Org`   | End user and org, under the §6.4 rules. On TCP, `Oort-Org` is refused because the token decides it                                                                                                        | yes                | `Oort-User` only              |
| `Oort-Judge-Role`         | `agent` or `expert`, plus `Oort-Operator`                                                                                                                                                                 | yes                | `agent` only                  |
| `Authorization`           | `Bearer <token>`                                                                                                                                                                                          | not used           | required                      |

The daemon keeps engines warm per configuration (up to `ENGINE_MAX`) and builds each request's
principal on a warm engine, so `principalFor` costs microseconds.

#### 8.1.4 Auth

- **Unix socket:** file permissions, as today. The socket has mode 600, inside a 700 directory
  owned by this user, checked with `lstat`, and no symlink is followed. The client runs the same
  `inspectDir` check before connecting. **Same-user trust:** any process of this OS user can
  connect and act as the person, including in expert mode. That is the CLI's trust model, and the
  docs state it.
- **TCP:** a bearer token (§9.4). There is no anonymous TCP access.

#### 8.1.5 Versioning

- The path carries the protocol major (`/v1`). `GET /v1/health` returns `{ version, protocol: 1,
  mode, capabilities: string[] }`, where `capabilities` lists `judgments`, `consolidate`,
  `forget-all` and later `spatial`.
- The SDK accepts any daemon that speaks protocol 1 at version 0.7.0 or newer. A non-additive
  change moves to `/v2`, and the daemon serves both for one minor.
- **A daemon older than 0.7.0** reads `GET ` as a frame length of about 1.2 GB, over
  `MAX_FRAME_BYTES`. It answers with one length-prefixed frame, `{ v: 1, id: null, ok: false,
  error: { code: 'bad-frame' } }`, then ends the connection. The client treats any reply that
  does not start with `HTTP/` as an outdated daemon and throws `OortUsageError`
  (`daemon-outdated`, fix `oort serve stop`). It never stops another version's daemon itself.

#### 8.1.6 Autostart, idle exit and life without Node

- **Starting the daemon.** If the socket does not answer and `autostart=True` (the default), the
  client starts `oort serve --detach` once, then waits up to 5 s for `GET /v1/health`.
  - **Version check.** Today's launcher runs any `oort` found on `PATH`, whatever its version.
    For autostart, the client first runs `oort --version` and uses that `oort` only if it is
    0.7.0 or newer. Otherwise it runs `npx oortmem@<its own version>`.
  - **Minimal environment.** The child gets only an allowlist:
    - `PATH`, `HOME`, `LANG`, `TMPDIR`, `XDG_RUNTIME_DIR`;
    - the `OORT_*` variables except `OORT_SERVE_TOKEN`;
    - `VOYAGE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`;
    - `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, `NO_PROXY`.

    The Python app's other secrets never reach the daemon.
- **Idle exit.** SDK requests count as activity for `--idle` (30 minutes by default). A long-lived
  service should run `oort serve` under its own supervisor instead of relying on autostart.
- **Without Node 22.15,** local mode throws `OortUsageError` (`node-missing`). The message says to
  install Node, or to use `mode="cloud"` or `mode="remote"`.
- **Migration.** The daemon never migrates the store (unchanged). It answers `refused`
  (`migration-required`, fix `oort doctor`), unless service mode was started with `--migrate`.

### 8.2 Cloud transport

Python calls `https://api.oortcloud.dev`, or `OORT_CLOUD_URL`. A key is never sent over plain
`http://` to a host that is not loopback, and redirects are never followed. The source of truth is
`packages/cli/test/cloud-contract.json`:

| SDK call                                | Cloud request                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall`                                | `POST /v1/recall` `{ text, project?, projectPrivate?, k, mode?, asOf?, knownAt?, include?, agent?, rerank?, embed? }`. `speed: 'fast'` → `rerank: false`; `'lexical'` → also `embed: false` |
| `observe`                               | `POST /v1/observe` `{ project?, turnRef?, observation: { user, assistant, at?, session?, tools? } }`                                                |
| `remember`                              | One `observe` per fact, framed as `cloudBackend.remember` frames it                                                                                 |
| `forget`                                | `DELETE /v1/memories/:id`, or `?everywhere=1`                                                                                                       |
| `pin` / `unpin`                         | `POST /v1/memories/:id/pin` / `unpin`, with `changed: null`                                                                                         |
| `explain`                               | `GET /v1/memories/:id`, shaped as `cloudBackend.explain` shapes it                                                                                  |
| `recent`                                | `GET /v1/memories?project=&limit=`, with paging, a client-side `since` and a cap (§4.4)                                                             |
| `whoami`                                | `GET /v1/whoami?agent=`                                                                                                                             |
| judgments, `consolidate`, `forgetAll`   | Not sent: `OortRefusedError` (`local-only`)                                                                                                         |

`projectPrivate` is sent only when the project's own config states it (`privacyStatement`).

## 9. Running in your own infrastructure

### 9.1 Deployment shapes

| Shape                                                  | Works today (0.5.4)                                                     | 0.6.0                                                                                                                         | 0.7.0                                                                                                                       | Missing or later                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Library in the agent process** (Node)                | Only by hand-wiring `@oortmem/core`                                     | `createOort()`: local engine in-process (SQLite on a volume), or cloud mode                                                   | unchanged                                                                                                                   | Python cannot embed the engine; it uses the daemon                                                       |
| **Long-running service** (ECS, Cloud Run, GKE, EKS)    | `oort mcp` over stdio only                                              | A Node service embedding the SDK, **one replica**, with the store on a block volume                                           | `oort serve --listen` as the memory service for any language (token, TLS, probes, metrics); the official image              | More than one replica needs a server-grade store (§9.2). Cloud Run has no block volumes: use cloud mode or GKE |
| **Serverless** (Lambda, Cloud Functions)               | No: the CLI expects a writable home and a keychain                      | **TS cloud mode** (§9.1.1)                                                                                                    | Python cloud mode, and either SDK in remote mode against an Oort service in the VPC                                         | A local store in serverless is unsupported: `/tmp` is ephemeral and per instance                         |
| **Sidecar daemon**                                     | `oort serve` for hooks only                                             | none                                                                                                                          | `oort serve` in the same pod: a shared-volume socket (§9.1.2), or `--listen 127.0.0.1:7807` with a token                    | none                                                                                                     |

#### 9.1.1 Serverless details [0.6, TS cloud mode]

- **No disk writes, even with a read-only or unset `HOME`.** `mode: 'cloud'` reads `OORT_HOME`
  (`cloud.json`, `config.json`, `credentials.json`) only if those files exist. It never creates
  the directory, a store, the hook log or the query embedding cache.
- **Keys.** Pass `keySources: ['explicit', 'env']` (or set `OORT_NO_KEYCHAIN=1`). There is no
  `security` binary to spawn in Lambda.
- **Handle lifetime.** Create the handle at module scope, so warm invocations reuse its
  connection. The pool's sockets are `unref()`'d, so a function that never calls `close()` does
  not hang the runtime.
- **Bundling.** Mark `@oortmem/store-sqlite`, `better-sqlite3` and `sqlite-vec` as external in
  esbuild or webpack. Cloud mode never imports them, so the native build never has to match the
  Lambda architecture. Making `@oortmem/store-sqlite` an optional dependency of `@oortmem/sdk` is
  [0.7] (Q14).
- **Await `observe` before returning.** The runtime freezes after the response.

#### 9.1.2 The Kubernetes socket directory

An `emptyDir` is created world-writable (mode 1777 or 777), and the daemon refuses to put its
socket in a directory that others can write. So mount the `emptyDir` at `/run/oort` and set
`OORT_HOME=/run/oort/home` (or `XDG_RUNTIME_DIR=/run/oort`). The daemon then creates its own 0700
subdirectory.

Both containers must run as the same uid, through `securityContext.runAsUser` and a matching
`fsGroup`. The daemon's `inspectDir` check refuses a socket directory owned by another uid, and so
does the client.

### 9.2 Storage

**SQLite on a persistent block volume is the supported self-hosted store for 0.6 and 0.7.**

- Use EBS (an EKS StatefulSet with the EBS CSI driver, or ECS on EC2) or a GCE persistent disk (a
  GKE StatefulSet). `OORT_HOME` on the volume holds `oort.sqlite` with its WAL, `cold/`,
  `models/` and the key-free config.
- **One host per store.** SQLite WAL needs shared memory on a single host.
  - Several processes on that host are fine, as with the CLI, hooks, MCP and the daemon.
  - Several hosts are not: run one replica per store (`replicas: 1`, `ReadWriteOnce`), and roll
    out with `maxSurge: 0` or `Recreate`.
- **No network filesystems.** EFS, Filestore and other NFS, SMB and FUSE mounts (GCS FUSE
  included) break WAL's shared memory and its locking. In 0.7, `openSqliteStore` checks
  `fs.statfsSync(dir).type` against the NFS, SMB and FUSE magic numbers:
  - `oort serve --listen` refuses to start on one;
  - the CLI and the SDK warn (`network-filesystem`).
- **ECS on Fargate with EBS** is unverified for a long-lived store (Q13). The AWS recipe uses ECS
  on EC2 or EKS.
- **Backups.** Take volume snapshots (EBS or persistent-disk snapshots of the volume holding
  `OORT_HOME`), with the service stopped or the SQLite file checkpointed. `oort export` is not a
  full backup of a multi-user store: it acts as the person, so end users' Planets are left out, and
  `oort import` imports Claude Code transcripts, not an export.

**A server-grade store (Postgres with pgvector, on RDS or Cloud SQL) is not built for 0.6 or
0.7.** The seam is ready for it:

- **`MemoryStore` enforces grants inside the store,** and `storeConformance`
  (`@oortmem/core/store-conformance`) runs the contract and isolation suites against any store.
  So `@oortmem/store-postgres` means passing that suite, not a redesign.
- **The mapping.**
  - One `memories` table with the address columns and schema v3's `CHECK`s.
  - A `tsvector` column for `lexical`. Recall fuses by rank, so `ts_rank` instead of `bm25`
    does not break fusion.
  - pgvector for `dense`, filtered by node.
  - Cold blobs in a table, or in S3 or GCS.
  - Row-level security per `org_id` as a second line of defence, never the first.
- **When to build it:** for the first self-hosting user who needs more than one replica, or high
  availability, that Oort Cloud does not meet (Q8).

### 9.3 Multi-tenant use

| Option                                                                 | Isolation                                                                  | Use when                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scopes in one store:** `org` is your tenant, `user` is the end user  | Grants enforced in the store, covered by the conformance and isolation suites | **The default:** many end users per tenant                                                                                                            |
| **One store per tenant** (one `OORT_HOME` per org)                     | Physical: separate files, backups and deletion                             | Contractual separation, per-tenant residency                                                                                                          |
| **One store per end user**                                             | Physical                                                                   | Only when lexical *score* independence matters. FTS5 `bm25` statistics are per table (store contract, "Known limit"), but results never cross tenants either way |

```ts
const oort = await createOort({ mode: 'local', home: '/data/oort', org: tenantId, project: null, projectConfig: false, keySources: ['env'] });
const mem = oort.scoped({ user: req.user.id, agent: 'support-bot' }); // hand only this handle to the model's tools
```

- **`org`** is the owner: the storage, key and deletion boundary.
- **`user`** gives each end user their own Planet. Per §6.4, an end user's handle has no Star.
  What an agent learns about one user (Orbits, the `agent-user` level) and promoting knowledge to
  a Galaxy belong to **CON-92 (B2B2C)**. The SDK exposes them only when that epic ships.
- **The CLI acts as the person.** Memories written for a `user` are invisible to the `oort` CLI.
  An operator `--user`/`--org` flag is Q9.
- **Cloud mode cannot separate end users** until CON-92. One Oort key is one account, so `user`
  is a usage error in cloud mode.
- **Erasure.** `forgetAll` [0.7] erases what an end user's handle can write (their Planet). It is
  built from `list` and `forget`, so it needs no store change, and it gives self-hosted apps an
  erasure path ahead of CON-92's `forgetCustomer`.
- **Who consolidates.** Consolidation (tiers, expiry, cold eviction) runs per grant. The hooks'
  drain consolidates only the person's own principal, so nothing consolidates other users'
  Planets on its own. A multi-tenant host calls `scoped({ user }).consolidate({ budgetMs })` at
  the end of each user's session, or from a scheduled job over its active users. It is cheap and
  calls no model. In 0.7, service mode adds `oort serve --consolidate-every 1h`, which sweeps the
  users seen since the last sweep, from an in-memory set that is never persisted.

### 9.4 Service mode: `oort serve --listen` [0.7]

**Decision: yes.** Python's `remote` transport is this API. Its local transport stays on the Unix
socket, with the same HTTP protocol.

```sh
oort serve token                                     # prints a new 256-bit token (base64url, 43 characters)
oort serve --listen 0.0.0.0:7807 --tls-cert /run/tls/tls.crt --tls-key /run/tls/tls.key [--tls-client-ca /run/tls/ca.crt]
oort serve --listen 127.0.0.1:7807 --plaintext        # sidecar on loopback
oort serve --listen 0.0.0.0:8080 --plaintext --behind-tls-proxy --migrate   # behind an ALB, a Cloud Run front end or a mesh
```

| Concern            | Decision                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opt-in             | TCP opens only with `--listen`, or with `serve.listen` in the home config or `OORT_CONFIG`. A repository config cannot set it, because `serve` is home-only. The daemon's "no TCP listener, ever" becomes "none unless `--listen` is given".                                                                                                                                                 |
| Token              | `OORT_SERVE_TOKEN`, or `OORT_SERVE_TOKEN_FILE` (a mounted secret: AWS Secrets Manager through ECS `secrets` or the Secrets Store CSI driver; GCP Secret Manager through Cloud Run secret env vars or the CSI driver). It must be **at least 43 base64url characters** (256 bits), and `oort serve token` makes one. The daemon refuses to start without one. Up to two comma-separated tokens are accepted for rotation, compared with `timingSafeEqual` on SHA-256 digests. The token variables are **removed from the environment of every child the daemon spawns** (the drain, autostarted processes). |
| What a token may do | Everything in its org (`OORT_SERVE_ORG`, which must not be `local`): any `user`, `project` and `agent`. Judgments in agent role only, and no `Oort-Cwd` or `Oort-Org`. Treat the token like a database password. Per-token scopes are Q10.                                                                                                                                              |
| TLS                | Built-in TLS (`node:https`) with `--tls-cert` and `--tls-key`, reloaded on `SIGHUP`. `--tls-client-ca` requires client certificates (mTLS) in addition to the token. **A non-loopback `--listen` without TLS refuses to start unless it has both `--plaintext` and `--behind-tls-proxy`.** A loopback listener needs `--plaintext`.                                                          |
| Clients            | Both SDKs refuse to send a token over `http://` to a host that is not loopback, never follow redirects, and pin nothing beyond the system or `NODE_EXTRA_CA_CERTS` trust store (Python: `ssl.create_default_context(cafile=…)`).                                                                                                                                                              |
| Browsers           | No CORS headers. Any request with an `Origin` header is refused. That blocks cross-site requests and DNS rebinding against a loopback listener.                                                                                                                                                                                                                                              |
| Health             | `GET /healthz`: 200 when the process serves (no auth, no store access). `GET /readyz`: 200 when the store is open and current, else 503 with `{ ready: false, store: 'migration-required' \| 'locked' \| 'network-filesystem' }` (no auth, no data).                                                                                                                                          |
| Migration          | `--migrate` lets the service migrate the store on start, because it is the only writer. Otherwise `/readyz` reports `migration-required` until `oort doctor` has run, for example as a one-off job.                                                                                                                                                                                          |
| Limits             | 256 TCP connections, 16 KiB of headers, 4 MiB bodies, 30 s per request, 60 s keep-alive. Rate limiting is the platform's job (ALB, Cloud Armor, a mesh).                                                                                                                                                                                                                                     |
| Idle exit          | Off with `--listen`.                                                                                                                                                                                                                                                                                                                                                                         |

### 9.5 Model keys, local models and egress

- **Keys come only from the environment on servers.** Inject the vendor keys, or `OORT_API_KEY`
  for the relay, from AWS Secrets Manager or GCP Secret Manager. The image sets
  `OORT_NO_KEYCHAIN=1`, and keys are never written to the volume.
- **Local models in containers.** `@oortmem/local-models` (ONNX Runtime, CPU only, about 115 MB)
  plus the default models (about 58 MB) give embedding and reranking with no egress.
  - Saving memories still needs the decision and writer models. A local decision model is CON-16.
  - So an air-gapped deployment can recall and judge by precedent, but it cannot observe.
  - The large multilingual models (more than 600 MB each, about 1 GB of memory) suit a long-lived
    service, not serverless.
- **Egress list.** One of three, depending on how keys are set up:
  - the Voyage, TypeSafe and Anthropic APIs, with your own keys;
  - the Oort Pro relay, with an Oort key;
  - `api.oortcloud.dev`, in cloud mode.

  Plus the model mirror at pull time only (`OORT_MODELS_URL`).
- **Data residency.** Oort Cloud stores memories in the EU. A self-hosted store lives wherever
  your volume is. Text still reaches the model vendors your keys point at, under your agreements
  with them. For EU-only processing of embeddings, use local models.

### 9.6 Packaging for servers

| Item                         | Decision                                                                                                                                                                                                                                                                                       | Release |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Official image               | `ghcr.io/oortmem/oort:<version>`, multi-arch (amd64 and arm64), from `gcr.io/distroless/nodejs22-debian12:nonroot` (glibc, for the `better-sqlite3` prebuilds). It runs as uid 65532 with a read-only root filesystem, `OORT_HOME=/data` as the one writable volume, `OORT_NO_KEYCHAIN=1`, and the entrypoint `oort serve`. Signed, with build provenance. | 0.7     |
| Local-models variant         | `…:<version>-local`: the runtime and the two default models baked in, pinned by SHA-256                                                                                                                                                                                                        | 0.7     |
| Env-only config              | `OORT_CONFIG`: a JSON overlay of the home config, read after `config.json`. It may set `serve` and `judge`, because the operator owns the environment.                                                                                                                                          | 0.7     |
| Examples                     | `docs/self-hosting.md`: docker-compose, a Kubernetes StatefulSet (`replicas: 1`, PVC, probes, Secret, the §9.1.2 socket note), an ECS-on-EC2 task definition, and a Cloud Run example in cloud mode                                                                                           | 0.7     |
| Helm chart, Terraform module | Later, together with the Postgres store, when more than one replica makes a chart worth maintaining                                                                                                                                                                                            | later   |

### 9.7 Observability

- **Never in logs or metrics:** memory, query, turn or judgment text; keys or tokens; scope values
  (user, project and agent ids can be personal data); memory ids.
- **Service logs [0.7]:** one JSON line per request on stdout:
  `{ ts, level, msg: "request", route, status, ms, mode, degraded, counts, requestId }`. Start,
  stop and migration lines follow the same shape.
- **Metrics [0.7]:** `GET /metrics` in Prometheus text, behind the token or on a separate
  `--metrics-listen 127.0.0.1:9464`. It exports:
  - `oort_requests_total{route,status}`;
  - `oort_request_duration_seconds{route}`;
  - `oort_recall_degraded_total{reason}`;
  - `oort_model_calls_total{role,via}`, so model costs are visible;
  - `oort_observe_outcomes_total{outcome}`;
  - `oort_store_bytes`.
- **The hook log** is unchanged: counts and timings, never text.
- **TypeScript diagnostics [0.7]:** `node:diagnostics_channel` `oortmem:call` events, `{ op, mode,
  ms, outcome, degraded, modelCalls }`, with no text and an `@experimental` payload. In 0.6, a host
  times calls itself and reads `warnings` and `degraded` from the results.

### 9.8 What lands when

| Release   | Self-hosting scope                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.6.0** | The TS SDK embedded in a one-replica service on a block volume, and TS cloud mode in serverless. `docs/sdk.md` covers library and serverless use.                                                                                                                                                   |
| **0.7.0** | `@oortmem/sdk`. The HTTP protocol (socket and `--listen`): token, TLS, mTLS option, probes, metrics, `--migrate`, `--consolidate-every`. Network-filesystem refusal, `OORT_CONFIG`, the image and its `-local` variant, `forgetAll`, diagnostics, TS `remote`, Python, and `docs/self-hosting.md`. |
| **Later** | `@oortmem/store-postgres` (on demand), Helm and Terraform, per-token scopes, a server-side observe queue, OpenTelemetry, multi-tenant cloud (CON-92).                                                                                                                                              |

## 10. Shared contract tests

### 10.1 Layout and format

```
contract/sdk/
  cases/*.json          by area: recall, temporal, observe, remember, ids, judge, scope, errors, scrub, format, limits
  seeds/*.json          starting stores: export-format v2 lines plus judgments
  vectors/project-id.json   cwd layouts and their expected project ids (the Python port, 0.7)
  schema.json           JSON Schema of a case
```

Secrets come from `packages/core/test/fixtures/secrets.b64.txt` (base64, so `check-public` stays
clean). The runner decodes them at runtime.

```json
{
  "id": "judge.agent-record-is-unconfirmed",
  "transports": ["local"],
  "seed": "empty",
  "options": { "agent": "bot", "config": { "judge": { "experts": ["ada"] } } },
  "now": "2026-11-06T12:00:00Z",
  "steps": [
    {
      "call": "judge.record",
      "args": { "subject": "Post claims a cure", "verdict": "rejected", "reason": "No source.", "domain": "content", "by": "ada" },
      "expect": { "result": { "outcome": "added", "id": { "$type": "string" }, "status": "agent-recorded" } },
      "save": { "judgment": "$.id" }
    },
    {
      "call": "judge.list",
      "args": {},
      "expect": { "result": { "judgments": { "$some": { "id": "${judgment}", "via": "mcp", "agentRecorded": true, "confirmed": false } } } }
    },
    { "call": "judge.confirm", "args": { "id": "${judgment}" }, "expect": { "error": { "code": "refused", "reason": "expert-only" } } }
  ]
}
```

- `call` names a method; dotted names reach the `judge` namespace. `args` are the method's
  arguments in camelCase wire names: for `recall`, `{ query, ...options }`; for one-argument
  methods, the argument's fields.
- `save` binds JSONPath values from the result, and `${name}` substitutes them in later steps.
- The matchers are `$type`, `$len`, `$some`, `$every`, `$absent`, `$regex` and `$approx`. Unknown
  result fields are ignored (the additive rule, §7.4).
- The Python runner converts names mechanically, so one file serves both SDKs.

### 10.2 Determinism and transports

- **Fakes.** Core's test helpers supply a hash embedder, a rule-based decider and an echo writer,
  with a fixed `now` and seeded stores. Real models are never called.
- **`local` [0.6].** The in-process engine with the fakes, through an internal `createOort` test
  hook. The hook is not exported from the package root.
- **`cloud` [0.6].** The fake cloud server that the CLI's tests use today, moved to a shared
  helper (`packages/cli/test/helpers/fake-cloud.ts`) that follows `cloud-contract.json`. Each
  case can force an error per route, `{ "cloud": { "fail": { "POST /v1/recall": 429 } } }`, so
  every cloud row of the §5 table is exercised.
- **`remote` and Python `local` [0.7].** `packages/sdk/test/fixture-daemon.ts` starts `oort
  serve` with the fakes, on a temporary socket or port. It is test-only and never in the npm
  `files`, so no shipped binary can swap in fake models.
- **Runners.** `packages/cli/src/sdk/contract.test.ts` (vitest) runs in `pnpm verify` [0.6].
  `python/tests/test_contract.py` (pytest on Python 3.10 and 3.13, with Node 22.15 for the fixture
  daemon) is added in 0.7. The release workflow runs both and blocks publishing on a failure.

### 10.3 0.6.0 must-haves

- **Inputs:** every §4.5 limit and every §4.4 temporal rule.
- **Errors:** each error code at least once, including the facade-defined `needs-confirmation` and
  the `cloud-only` versus `refused` split for `include`.
- **Scope isolation:**
  - two users in one org, and the same agent for both: neither sees the other, and no Star exists
    for either;
  - two agents;
  - `include` narrowing;
  - `user` without `org`, and `scoped({ user: 'self' })`.
- **Judgments:** every §6.3 rule, including the daily cap (with the counter seeded at 49), the
  `via` and `harness` values, and a 0.5.x-style reader (core's `isUnconfirmedAgentJudgment`)
  agreeing on the result.
- **Secrets:** every fixture secret, whether observed, remembered or used as a query, never
  appears in a result.
- **Escaping:** `formatForPrompt` escapes a memory containing `</oort-memory>`.
- **Unknown keys:** `place` on a turn is refused (`usage`).
- **Gated live smoke test, before the launch tag.** `OORT_LIVE_SMOKE=1` with a test account's key
  runs `recall`, `observe` (with a unique `turnRef`), `pin`, `unpin` and `forget` against
  `api.oortcloud.dev`. It runs in the release workflow and never on pull requests.

## 11. Framework integrations

**What was checked.** Context7 (`ctx7`) docs on 2026-11-06. The library ids:

- Vercel AI SDK: `/websites/ai-sdk_dev`, including the v6 to v7 migration guide.
- LangGraph.js: `/websites/langchain_oss_javascript_langgraph` and
  `/websites/reference_langchain_javascript_langchain-langgraph`.
- LangGraph (Python): `/websites/reference_langchain_python_langgraph` and
  `/langchain-ai/langgraph` (`store/base`).
- OpenAI Agents SDK: `/websites/openai_github_io_openai-agents-js` and
  `/openai/openai-agents-python`.
- CrewAI: `/llmstxt/crewai_llms_txt` (docs v1.15.23) and `/crewaiinc/crewai`.
- Mastra: `/llmstxt/mastra_ai_llms_txt` and `/mastra-ai/mastra`.

Re-check each one before its adapter ships.

| Framework                   | Interface as checked                                                                                                                                                                                                | Thinnest good adapter                                                                                                                                                                                                 | Release                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Vercel AI SDK** (TS, v7)  | `tool({ description, inputSchema, execute })` (`parameters` became `inputSchema` in v5), passed as `tools` to `generateText` and `streamText`. In v7, approval is set per call (`toolApproval`). No memory interface. | `oortTools(oort)` → `{ recall, remember, forget }` (with `judge: true`, also `judge` and `record_judgment`). `oortObserve(oort, prompt)` returns an `onFinish` callback that calls `observe`. `formatForPrompt` output goes in `system`. | **0.6.0 adapter**, `oortmem/ai-sdk` |
| **LangGraph.js**            | `BaseStore`: `batch(ops)`, `put`, `get`, `search(namespacePrefix, { query, filter, limit, offset })` and `delete`. Passed with `compile({ store })`, read in a node as `runtime.store`.                            | `OortStore extends BaseStore`: `search` with a query → `recall`, `put` → `remember`, `delete` → `forget`, `get` by Oort id. A host-written `namespaceToScope(ns)` picks `scoped({ user, project })`.                 | 0.6 docs example; adapter 0.7       |
| **OpenAI Agents JS**        | `Session`: `getSessionId`, `getItems(limit?)`, `addItems`, `popItem` and `clearSession`, passed with `run(agent, input, { session })`. `tool({ name, description, parameters, execute })`.                        | `oortSession(inner, oort)` wraps any `Session`: storage is delegated, and `addItems` pairs the user and assistant items and calls `observe`. Recall goes through dynamic `instructions` and tools, never by rewriting history. | 0.6 docs example; adapter 0.7       |
| **LangGraph (Python)**      | `BaseStore(ABC)`: abstract `batch` and `abatch`; `get`, `put`, `search`, `delete` and `list_namespaces` are built on them. `Item` and `SearchItem` (with a score).                                                 | `OortStore(BaseStore)`, dispatching `GetOp`, `PutOp` and `SearchOp` as in TypeScript, with async through `AsyncOort`                                                                                                 | **0.7.0**                           |
| **OpenAI Agents (Python)**  | `Session` protocol: `get_items`, `add_items`, `pop_item` and `clear_session`, passed with `Runner.run(..., session=)`. `@function_tool`; the docs also show `@tool`.                                                | `OortSession(inner, oort)`, `oort_instructions(oort)` and `oort_tools(oort)`                                                                                                                                         | **0.7.0**                           |
| **CrewAI**                  | `Memory(storage=StorageBackend)`, whose `search` receives a `query_embedding`, not text. `BaseTool` (with `args_schema` and `_run`) or `@tool`.                                                                   | **Tools only:** `OortRecallTool`, `OortRememberTool` and `OortForgetTool`. A storage backend would bypass Oort's ranking                                                                                               | **0.7.0**                           |
| **Mastra**                  | `createTool({ id, description, inputSchema, outputSchema?, execute(inputData, context) })`. Memory storage is built on threads and messages.                                                                     | Tools via `createTool`, as a docs example                                                                                                                                                                            | after launch                        |

Rules for every adapter:

- **Agent role only.** It calls `scoped({ judgeRole: 'agent' })`.
- **Prompt injection.** It injects memory only through `formatForPrompt`.
- **Judgment tools are opt-in.** They appear only with `judge: true`. Their schema never includes
  `includeAgentRecorded` or `includeImported`, and the expert role is unreachable through them.
- **Separate install.** Each adapter lives in a subpath (TypeScript) or an extra (Python).

Any MCP-capable framework can also use `oort mcp` today, with no code.

## 12. Spatial readiness

**0.6 reserves the names in the docs only.**

- `docs/sdk.md` says that `place` (on turns, `remember` and memory views) and `near` and `within`
  (on recall) are reserved for spatial memory (CON-84), and that no other field will use those
  names.
- There is no `Place` type in 0.6.
- Because every input is checked by a strict schema (§4.1), passing `place` today is a usage
  error, never a silent drop. A robot must not believe it stored a location.

**0.7** adds the type, marked `@experimental`, and names the fields as reserved in the daemon's
schemas. They then answer `spatial-unavailable`.

```ts
/** @experimental [0.7] Reserved for CON-84. */
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

After CON-84:

- `Turn.place` and `remember(…, { place })` store a place.
- `RecallOptions` gains `near: { pose, radius, mapId }` and `within: { nodeId } | { box, mapId }`.
- `MemoryView.place` is filled, and `why` gains `placePath`, `distanceM` and `stalePose`.
- `/v1/health` lists `spatial`.

Going from refused to accepted, and filling an optional field, are additive changes (§7.4). The
export format and the store contract gain their optional `place` field in CON-84 itself.

## 13. Compatibility

### 13.1 Version skew on one machine

One `OORT_HOME` can be shared by an app's `oortmem` dependency (say 0.6.x), a global CLI (0.5.x or
0.7), the Claude Code hooks, `oort mcp` and `oort serve`.

| Shared thing                        | Rule                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store schema                        | 0.6 ships no schema change. When a future version migrates the store, older binaries refuse to open it until they are upgraded (the store copies itself before migrating, and `downgradeSqliteStore` exists). Hosts that share a developer's home and want no surprise migration pass `migrate: false`, and get `refused`/`migration-required` instead. |
| Judgments                           | Agent-role SDK judgments are stored as `via: 'mcp'`, which 0.5.x readers already treat as unconfirmed. No new `via` value is introduced.                                                                                                                                     |
| Daily cap                           | The same counter and lock files, so every version counts against one cap.                                                                                                                                                                                                    |
| Config                              | The SDK never writes `config.json`. An overlay passed in code stays in that process.                                                                                                                                                                                         |
| Daemon                              | The hooks use only a daemon of their exact version (unchanged). The Python SDK accepts protocol 1 at 0.7.0 or newer (§8.1.5).                                                                                                                                                |
| `cloud.json`, `credentials.json`    | Read only. Login and `cloud use` stay CLI commands.                                                                                                                                                                                                                          |

### 13.2 Migration notes for 0.6.0 (in the release notes and `docs/sdk.md`)

- **The CLI's `--json` output changes shape** to the `oort.v1` envelope (CON-107 step 2). Scripts
  that parse the old arrays and objects must read `data`.
- **The new `exports` map blocks deep imports** such as `oortmem/dist/wire.js`. These paths were
  never documented. Use the root export, or `@oortmem/core` for engine pieces.
- **`oortmem` gains a root export.** `import 'oortmem'` used to resolve to nothing useful. It now
  returns the SDK. The bin is unchanged.

### 13.3 Windows

- **TypeScript 0.6.** Cloud mode is supported. Local mode is best effort, at the same level as the
  CLI on Windows: SQLite works, there is no Keychain (`credentials.json`), and it is not in CI.
- **The daemon's HTTP protocol and Python local mode are not supported on Windows** in 0.7.
  `process.getuid` is undefined there, so the uid and permission checks in `inspectDir` pass
  without checking anything. The socket would not be a real trust boundary. On Windows, the
  daemon refuses HTTP on its socket, and Python points to `mode="cloud"` or `mode="remote"`. A
  TCP `--listen` with TLS and a token works the same on every OS.

### 13.4 Known performance limits

- **Id prefixes.** `findMemory` resolves a prefix by listing every memory in the grant (O(n)).
  The SDK tries an exact `get` first, so full ids stay O(1).
- **`recent`, local.** It lists the grant's memories and sorts them in JS, as the MCP server's
  `list_recent` does (O(n)). In cloud mode it is capped at 500 memories (§4.4).
- **`judge.list` and `judge.apply`** scan the active judgments of the home node.
- **Expected scale.** These are fine up to tens of thousands of memories per principal. A store
  `list` with `orderBy` and `limit`, and a prefix index, are [later] (§14).
- **Multi-tenant scaling.** Every scan above is per grant, so tenants in one store do not slow
  each other down. Only file size and lexical statistics are shared.

## 14. Changes by release

| Package or file                           | Change                                                                                                                                                                                                                                                       | Release |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| CON-107 step 2                            | Merged first: `describeError`, `refused`, the `--json` envelope                                                                                                                                                                                             | 0.6.0   |
| `@oortmem/core`                           | `isAgentVia()`, used at every agent-`via` site (§6.3). No new `JudgmentVia` value                                                                                                                                                                            | 0.6.0   |
| `oortmem` (CLI)                           | `src/sdk/` facade and the `ai-sdk` adapter. The `exports` map and `sideEffects`. `wire()` split into `wireEngine` and `principalFor`, with the cloud check before the store and a dynamic store import. `runRecall`, `timeMode` and `supersedeChain` moved to UI-free `src/engine/`. The cap counter moved to a shared module (file names kept). The fake cloud moved to a test helper | 0.6.0   |
| `docs/`                                   | `docs/sdk.md`. In `docs/cli.md`, the judgment `via` table adds `sdk` (expert-recorded from code), and notes that `mcp` also covers SDK agent records (`source.harness: 'sdk'`)                                                                              | 0.6.0   |
| `@oortmem/sdk` (new)                      | The facade and wiring move here (§7.1), and `oortmem` re-exports it. Lazy per-role adapter loading. `@oortmem/store-sqlite` as an optional dependency (Q14)                                                                                                 | 0.7.0   |
| `oortmem` (CLI)                           | `oort serve`: HTTP on the socket (first-byte routing, separate caps, limits, no `Origin`), `--listen`, `oort serve token`, TLS and `--tls-client-ca`, `--plaintext --behind-tls-proxy`, probes, metrics, `--migrate`, `--consolidate-every`, token stripped from child processes. `OORT_CONFIG`. `forgetAll`. `remote` mode. Diagnostics channel. `Place` type. `judge.agentDailyLimit` | 0.7.0   |
| `@oortmem/store-sqlite`                   | Network-filesystem detection (§9.2)                                                                                                                                                                                                                          | 0.7.0   |
| `python/`                                 | The client, integrations, contract runner, `_Secret`, credential-file mode check, autostart version check and minimal environment                                                                                                                           | 0.7.0   |
| `docs/`                                   | `docs/self-hosting.md` and the Python half of `docs/sdk.md`                                                                                                                                                                                                  | 0.7.0   |
| Later                                     | `@oortmem/store-postgres`, Helm and Terraform, per-token scopes, an observe queue, client-side scrubbing from a shared rule table, store `list` ordering, OpenTelemetry, Orbits in the SDK (CON-92), spatial (CON-84)                                         | later   |

## 15. Out of scope (0.6 and 0.7)

- Constellation sharing, invites, members, keys and Galaxies from the SDK. These need a person's
  confirmed preview.
- Judgment packs, bulk import, `judge eval`, `judge withdraw` and `judge purge`.
- `export`, `import`, `reembed`, `models pull` and `project link`, which are CLI tasks.
- A browser or edge-runtime build (Q7).
- Orbits and end-user Planets in the cloud (CON-92), and spatial recall (CON-84 onwards).

## 16. Open questions, with recommendations

| #   | Question                                                                                   | Recommendation                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Should `refused` be part of the SDK, although CON-107's issue lists nine codes?            | **Yes.** It is in the `oort.v1` branch and its docs. Update CON-107's notes to match.                                                                                                                 |
| Q2  | Does the SDK depend on CON-107 step 2 landing first?                                       | **Yes.** Merge it before the SDK branch; the facade builds on `describeError`.                                                                                                                       |
| Q3  | Should the client scrub before calling the cloud (TS and Python)?                          | **Later.** Generate the scrub rule table from `scrub.ts` as JSON, so both languages run one rule set, checked by the shared fixtures. Oort Cloud scrubs server-side meanwhile.                        |
| Q4  | Should the agent-role daily cap be configurable?                                           | **Yes, in 0.7:** `judge.agentDailyLimit` (home config or `OORT_CONFIG`), default 50, maximum 5,000. The counter file stays the same.                                                                   |
| Q5  | Should `AsyncOort` get native async?                                                       | **Threads in 0.7.** Add an optional `httpx` extra only if benchmarks show the need.                                                                                                                   |
| Q6  | Should there be a server-side observe queue?                                               | **0.8:** `POST /v1/observe?async=1` → 202, drained like the hooks' queue.                                                                                                                            |
| Q7  | Should cloud mode run in edge runtimes?                                                    | **After 0.7:** an `oortmem/cloud` subpath with no `node:` imports.                                                                                                                                   |
| Q8  | When should the Postgres store be built?                                                   | **At the first real need** for more than one replica or HA in self-hosting, against `storeConformance`.                                                                                               |
| Q9  | Should the CLI get `--user` and `--org` for operators of multi-tenant stores?              | **Yes, in 0.7**, for `recall`, `inspect`, `forget` and `export`.                                                                                                                                     |
| Q10 | Should service mode get per-token scopes?                                                  | **Later:** a file of hashed tokens, each bound to an org and optionally to users, read-only access or a judge role.                                                                                 |
| Q11 | Should the cloud gain a `POST /v1/remember` route?                                         | **Yes, at the next cloud contract change**, so the framing lives in one place.                                                                                                                       |
| Q12 | Should a no-option `createOort()` keep CLI parity?                                         | **Yes**, for scripts. Server docs always pass explicit options. With `user` set, `org` is required anyway (§6.4).                                                                                    |
| Q13 | Is ECS Fargate with EBS fit for a long-lived store?                                        | **Verify before the 0.7 AWS recipe.** Until then, recommend ECS on EC2 or EKS.                                                                                                                       |
| Q14 | Should `@oortmem/store-sqlite` become optional for cloud-only installs?                    | **Yes, in `@oortmem/sdk` (0.7)** as an optional dependency, with local mode throwing `usage` (`store-not-installed`) when it is absent. `oortmem`, which ships the CLI, keeps it as a regular dependency. |
| Q15 | Should local mode deduplicate on `turnRef`?                                                | **Later:** a unique index on `(principal, turnRef)` in store-sqlite, behind a schema bump. In 0.6 it is documented as cloud-only.                                                                    |
