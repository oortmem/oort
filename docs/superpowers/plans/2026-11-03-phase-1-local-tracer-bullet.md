# Oort Phase 1: Local Tracer Bullet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marcus's Claude Code sessions remember decisions, conventions and incidents across sessions through a local, tiered, inspectable memory engine installed as Claude Code hooks.

**Architecture:** A pnpm/TypeScript monorepo. `@oortmem/core` owns the memory model, the activation math, the `recall`/`observe`/`consolidate` pipelines, and the five adapter contracts (`MemoryStore`, `Embedder`, `Reranker`, `DecisionController`, `MemoryWriter`). Each adapter is its own package; only the `*-voyage`, `decide-jev` and `writer` packages make network calls. `@oortmem/claude-code` turns hook stdin into pipeline calls and parses transcripts; the `oort` CLI wires everything from `oort.config.json`. Phase 1 hooks run in-process (no daemon); the daemon is Phase 2.

**Tech Stack:** Node 22+ (developed on 26), pnpm 12, TypeScript 7.x strict (the native compiler; 5.9 is the fallback if a tool cannot load it), vitest 5 (root `vitest.config.ts` with `test.projects`), oxlint, prettier, zod, better-sqlite3 13 + sqlite-vec 0.1.x, `node:zlib` zstd, `voyageai` 0.4, `@typesafe-ai/sdk` 0.7, `ai` 7 + `@ai-sdk/anthropic` 4, commander.

**Spec:** `docs/superpowers/specs/2026-11-03-oort-memory-engine-design.md`

## Global Constraints

- License: Apache 2.0 on every package; `LICENSE` at the repo root, `"license": "Apache-2.0"` in every `package.json`.
- Package names: `@oortmem/<name>`; the CLI package is `oort` with bin `oort`.
- Engines: `"node": ">=22.15.0"` (`node:zlib` zstd, used for cold blobs, arrived in 22.15.0). ESM only (`"type": "module"`).
- No `@smeltjs/*` dependency anywhere. Code adapted from Smelt carries a one-line attribution comment at the top of the file.
- Zero network calls from `core`, `store-sqlite`, `claude-code`, `cli` (except through injected adapters). Only `embed-voyage`, `rerank-voyage`, `decide-jev`, `writer` may import a network client.
- Tier names in identifiers are `hot` | `warm` | `cold`. No astro names in code.
- Store location: `~/.oort/oort.sqlite` and `~/.oort/cold/`; overridable with `OORT_HOME`.
- Config: `oort.config.json` in the project root (walk up from cwd), then `~/.oort/config.json`, then defaults. Project `private: true` keeps that project's memories out of every other project's recall.
- Embedding default: `voyage-3.5-lite`, `outputDimension: 512`, `outputDtype: "int8"` for both documents and queries. Reranker default: `rerank-3-lite`, `topK: 10`. Writer default: Anthropic `claude-haiku-5-5` through the AI SDK (model id is config). All three are config, never hard-coded in the pipeline.
- Activation: `A = ln(Σ t_j^-d) + w_s·S`, `d = 0.5`, `w_s = 1.0`, `t_j` in hours with a floor of `1/60`. Thresholds: `hotTopN = 50`, `coldBelow = -2.0`. All config.
- Recall candidate counts: 50 lexical, 50 dense, rerank top 30, return ≤ 10. Default injection budget 1500 tokens (≈ 6000 chars).
- Every stored memory records `source.decisions[]` (stage, question, answer, probability).
- `pnpm verify` = `format:check && lint && build && typecheck && test` and must pass before every commit.

## Review Focus

1. Prompt that is a slash command or under 12 characters: hook must emit nothing and exit 0 in under 50 ms (Task 5 test `gate.skips-trivial`).
2. Transcript rows that are not `user`/`assistant` messages (`attachment`, `api-request`, `system`, `file-history-snapshot`): parser must skip them without throwing (Task 12 test `parser.skips-non-message-rows`).
3. Voyage or TypeSafe unreachable or missing key during `UserPromptSubmit`: hook must degrade to lexical-only recall and still exit 0, logging to `~/.oort/logs/hooks.log` (Task 12 test `hook.degrades-without-network`).
4. A memory superseded twice (A → B → C): `recall` returns only C by default and `inspect` shows the chain (Task 6 test `observe.supersede-chain`).
5. Private project: a memory observed in a `private: true` project never appears in another project's recall even on an exact lexical match (Task 8 test `store.private-project-isolation`).

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.oxlintrc.json`, `.prettierrc`, `.gitignore`, `LICENSE`, `README.md`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/index.test.ts`

**Interfaces:**
- Produces: workspace scripts `build`, `test`, `typecheck`, `lint`, `format`, `format:check`, `verify`; a package template every later task copies.

- [ ] **Step 1: Write the failing test** `packages/core/src/index.test.ts`: `expect(VERSION).toBe("0.0.0")`.
- [ ] **Step 2: Run** `pnpm -r test` → fails (no workspace yet).
- [ ] **Step 3: Create the workspace.** Root `package.json` private, `packageManager: "pnpm@10"`, scripts as in Global Constraints. `pnpm-workspace.yaml` with `packages/*`. `tsconfig.base.json`: `strict`, `module: NodeNext`, `target: ES2022`, `declaration`. `packages/core` builds with `tsc -p` to `dist/`. Export `const VERSION = "0.0.0"`.
- [ ] **Step 4: Run** `pnpm verify` → PASS.
- [ ] **Step 5: Commit** `chore: scaffold oort monorepo`.

### Task 2: Memory model, scope, and config

**Files:**
- Create: `packages/core/src/model.ts`, `packages/core/src/scope.ts`, `packages/core/src/config.ts`, tests beside each.

**Interfaces:**
- Produces:
  - `type MemoryType = "semantic" | "episodic" | "procedural" | "preference"`
  - `type Tier = "hot" | "warm" | "cold"`
  - `interface Scope { orgId: string; customerId: string; agentId: string; projectId?: string }`
  - `interface Memory { id: string; scope: Scope; type: MemoryType; text: string; stub: string; entities: string[]; salience: number; pinned: boolean; tier: Tier; accessLog: AccessLog; validFrom: string; validTo: string | null; supersedes: string | null; supersededBy: string | null; source: MemorySource; embedding?: Int8Array; createdAt: string; updatedAt: string }`
  - `interface AccessLog { count: number; recent: string[]; compactedSum: number; compactedAt: string | null }` (`recent` ≤ 32 ISO timestamps)
  - `interface MemorySource { harness: string; sessionId?: string; turnRef?: string; decisions: Decision[] }`, `interface Decision { stage: string; question: string; answer: string; probability: number }`
  - `localScope(projectId?: string): Scope` → `{ orgId: "local", customerId: "self", agentId: "claude-code", projectId }`
  - `projectIdFor(cwd: string): string | undefined` — git root basename + short hash of its absolute path, undefined outside a git repo
  - `OortConfig` zod schema and `resolveConfig(cwd: string, env = process.env): ResolvedConfig` with fields `{ home, embed: { provider, model, dimension, dtype }, rerank: { provider, model, topK }, decide: { provider }, writer: { provider, model }, activation: { d, ws, hotTopN, coldBelow }, recall: { lexicalK, denseK, rerankK, returnK, budgetChars }, project: { id?, private } , sources: string[] }` where `sources` names which file supplied each key.

- [ ] **Step 1: Write failing tests**: `scope.projectIdFor-git-root` (temp git repo → defined, stable across calls; temp non-git dir → undefined), `config.precedence` (project file overrides home file overrides defaults; `sources` names the winner), `config.rejects-unknown-keys`.
- [ ] **Step 2: Run** `pnpm --filter @oortmem/core test` → FAIL.
- [ ] **Step 3: Implement** the three modules. Config lookup: walk up from `cwd` to the first `oort.config.json`, then `$OORT_HOME/config.json` (default `~/.oort`), merge shallowly per top-level key.
- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** `feat(core): memory model, scope, config`.

### Task 3: Activation and tiering

**Files:**
- Create: `packages/core/src/activation.ts`, `packages/core/src/activation.test.ts`

**Interfaces:**
- Produces:
  - `activation(log: AccessLog, salience: number, now: Date, p: { d: number; ws: number }): number`
  - `appendAccess(log: AccessLog, at: Date, p: { d: number }): AccessLog` (append; `d` is required because `compactedSum` is only valid for the `d` it was folded with; when `recent.length > 32`, fold the oldest 16 into `compactedSum` as `Σ t^-d` evaluated at `compactedAt`, which `activation` re-ages)
  - `tierFor(a: number, rank: number, pinned: boolean, p: { hotTopN: number; coldBelow: number }): Tier`

- [ ] **Step 1: Failing tests**: `activation.recent-beats-old` (one access 1 h ago > one access 100 h ago), `activation.frequency-adds` (five accesses > one access, same ages), `activation.salience-weight` (same log, salience 1 vs 0 differs by exactly `ws`), `activation.compaction-preserves-order` (ranking of two logs unchanged after `appendAccess` compacts one of them), `tierFor.pinned-is-hot`, `tierFor.below-threshold-is-cold`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS. Step 5: Commit** `feat(core): ACT-R activation and tier assignment`.

### Task 4: Adapter contracts, in-memory store, fusion

**Files:**
- Create: `packages/core/src/adapters.ts`, `packages/core/src/fusion.ts`, `packages/core/src/memory-store.ts` (in-memory `MemoryStore`), `packages/core/src/store-conformance.ts` (exported test suite), tests.

**Interfaces:**
- Produces:
  - `interface Embedder { readonly dimension: number; embed(texts: string[], kind: "query" | "document"): Promise<Int8Array[]> }`
  - `interface Reranker { rerank(query: string, docs: { id: string; text: string }[], topK: number): Promise<{ id: string; score: number }[]> }`
  - `interface DecisionController { gate(obs: Observation): Promise<GateDecision>; reconcile(obs: Observation, candidates: Memory[]): Promise<ReconcileDecision[]> }`
    - `interface Observation { userText: string; assistantText: string; toolSummaries: string[]; sessionId?: string; turnRef?: string; projectId?: string; at: string }`
    - `interface GateDecision { shouldStore: number; salience: number; types: Partial<Record<MemoryType, number>>; decisions: Decision[] }`
    - `type ReconcileAction = "NOOP" | "REINFORCE" | "ADD" | "UPDATE" | "SUPERSEDE"`; `interface ReconcileDecision { candidateId: string | null; action: ReconcileAction; probability: number; decisions: Decision[] }`
  - `interface MemoryWriter { write(obs: Observation, action: "ADD" | "UPDATE" | "SUPERSEDE", prior?: Memory): Promise<{ text: string; stub: string; entities: string[]; type: MemoryType }> }`
  - `interface MemoryStore { upsert(m: Memory): Promise<void>; get(id: string): Promise<Memory | null>; forget(id: string): Promise<void>; lexical(q: string, scope: ScopeFilter, k: number): Promise<Hit[]>; dense(v: Int8Array, scope: ScopeFilter, k: number): Promise<Hit[]>; recordAccess(ids: string[], at: Date): Promise<void>; list(scope: ScopeFilter, opts?: { tier?: Tier; validOnly?: boolean }): Promise<Memory[]>; coldPut(m: Memory): Promise<void>; coldGet(id: string): Promise<Memory | null>; setTier(id: string, tier: Tier): Promise<void>; getCursor(key: string): Promise<string | null>; setCursor(key: string, value: string): Promise<void>; close(): Promise<void> }`
    - `interface ScopeFilter { orgId: string; customerId: string; agentId: string; projectIds: (string | null)[] }` (`null` = global/no project)
    - `interface Hit { id: string; score: number; tier: Tier }`
  - `rrf(lists: Hit[][], k = 60): Map<string, number>` and `fuse(hits: Hit[][], memories: Map<string, Memory>, now: Date, p): { id: string; score: number }[]` which applies `validTo === null` filtering and adds `0.1 * activation`.
  - `storeConformance(name: string, make: () => Promise<MemoryStore>)` registering a vitest `describe` that every store implementation must pass (upsert/get round-trip, lexical finds exact identifier `auth-service-8080`, dense returns nearest, scope filter excludes other customer, `projectIds: [null, "p1"]` includes global and p1 but not p2, cold round-trip, cursor round-trip).

- [ ] **Step 1: Failing tests**: `fusion.rrf-prefers-both-lists`, `fusion.drops-superseded`, plus `storeConformance("memory", ...)` against the in-memory store.
- [ ] **Step 2 → 5** as usual. Commit `feat(core): adapter contracts, in-memory store, RRF fusion`.

### Task 5: Heuristic gate and `recall`

**Files:**
- Create: `packages/core/src/gate.ts`, `packages/core/src/recall.ts`, tests.

**Interfaces:**
- Produces:
  - `shouldRecall(prompt: string): { recall: boolean; reason: string }` — false for prompts starting with `/`, shorter than 12 chars, or matching an acknowledgment list (`ok`, `yes`, `thanks`, `continue`, `go ahead`, `lgtm`, …); true otherwise.
  - `recall(q: RecallQuery, deps: { store: MemoryStore; embed?: Embedder; rerank?: Reranker; config: ResolvedConfig; now?: Date }): Promise<RecallResult>`
    - `interface RecallQuery { text: string; scope: ScopeFilter; budgetChars?: number; asOf?: string }`
    - `interface RecallResult { memories: RecalledMemory[]; skipped?: string; degraded?: ("no-embedder" | "no-reranker" | "embed-failed" | "rerank-failed")[]; timings: Record<string, number> }`
    - `interface RecalledMemory extends Memory { explanation: { lexicalRank?: number; denseRank?: number; fused: number; reranked?: number; activation: number; hydrated: boolean } }`
  - `formatForInjection(r: RecallResult, budgetChars: number): string` — a `<oort-memory>` block, one line per memory: `- [type, age] text`, cut at budget on whole memories.

- [ ] **Step 1: Failing tests** with in-memory store + fake embedder (hash → vector) + fake reranker: `gate.skips-trivial` (`/model`, `ok`, `yes please` → false; `what port did we move auth to?` → true), `recall.hybrid-finds-lexical-only-match` (identifier only in text, not semantically close), `recall.hydrates-cold` (a cold memory whose stub matches lexically is returned with `hydrated: true` and promoted to warm), `recall.degrades-without-embedder` (no embedder → lexical-only, `degraded` contains `no-embedder`), `recall.respects-asOf`, `recall.records-access` (store access log count incremented for returned ids only), `format.budget-cuts-whole-memories`.
- [ ] **Step 2 → 5.** Commit `feat(core): heuristic gate and hybrid recall`.

### Task 6: `observe` pipeline

**Files:**
- Create: `packages/core/src/observe.ts`, `packages/core/src/observe.test.ts`

**Interfaces:**
- Produces: `observe(obs: Observation, scope: Scope, deps: { store: MemoryStore; embed: Embedder; decide: DecisionController; write: MemoryWriter; config: ResolvedConfig; now?: Date }): Promise<ObserveResult>` where `ObserveResult = { outcome: "skipped" | "reinforced" | "added" | "updated" | "superseded"; memoryId?: string; decisions: Decision[] }`.
  - Flow: `decide.gate` → if `shouldStore < 0.5` return `skipped` (if any candidate from a quick lexical lookup exists, `recordAccess` it and return `reinforced`); else embed `userText + assistantText` → `store.dense` + `store.lexical` top 5 → `decide.reconcile` → take the highest-probability non-NOOP action → `write` → upsert new memory (tier `warm`, or `hot` if `salience ≥ 0.8`), on `UPDATE` set `validTo` on prior and link `supersedes`, on `SUPERSEDE` same plus `type` from prior; append all decisions to `source.decisions`.

- [ ] **Step 1: Failing tests** with fake decide/write/embed: `observe.skips-low-salience`, `observe.reinforce-increments-access`, `observe.add-stores-warm`, `observe.high-salience-is-hot`, `observe.supersede-chain` (A→B→C; `list(validOnly)` returns only C; C.supersedes = B, B.supersededBy = C), `observe.records-decisions`.
- [ ] **Step 2 → 5.** Commit `feat(core): observe pipeline with reconciliation`.

### Task 6b: Secret scrubbing at the observation boundary

**Files:**
- Create: `packages/core/src/scrub.ts`, `packages/core/src/scrub.test.ts`, fixtures `packages/core/test/fixtures/secrets.txt` and `packages/core/test/fixtures/lookalikes.txt`
- Modify: `packages/core/src/observe.ts` (call `scrub` first)

**Interfaces:**
- Produces: `scrub(text: string): { text: string; redactions: { kind: string; count: number }[]; secretRatio: number }` and `scrubObservation(obs: Observation): { obs: Observation; dropped: boolean; redactions: ... }`. `dropped` is true when `secretRatio > 0.5`. Kinds: `aws-access-key`, `aws-secret-key`, `github-token`, `anthropic-key`, `openai-key`, `voyage-key`, `typesafe-key`, `stripe-key`, `jwt`, `pem-private-key`, `url-credentials`, `auth-header`, `env-secret`, `high-entropy` (base64/hex ≥ 32 chars with Shannon entropy ≥ 4.0 bits/char). Replacement is `[REDACTED:<kind>]`. Pure code, no dependencies, no network.
- `observe()` runs `scrubObservation` before the gate; a dropped observation returns `{ outcome: "skipped", reason: "secret", decisions: [] }` and never reaches any adapter.

- [ ] **Step 1: Failing tests**: `scrub.redacts-all-fixture-secrets` (every line of `secrets.txt` contains `[REDACTED:` after scrub and none of the original secret substrings), `scrub.leaves-lookalikes` (every line of `lookalikes.txt` is byte-identical: commit SHAs, UUIDs, short hex ids, ordinary URLs, version strings), `scrub.idempotent`, `scrub.keeps-surrounding-text`, `observe.never-sends-secret-to-adapters` (fake embedder/decider/writer throw if their input contains the planted key; observe succeeds with the redacted text), `observe.drops-mostly-secret-turn`.
- [ ] **Step 2 → 5.** Commit `feat(core): secret scrubbing at the observation boundary`.

### Task 6c: Temporal validity hardening (from `docs/research/2026-11-03-temporal-knowledge.md`)

**Files:**
- Modify: `packages/core/src/model.ts` (add `expiredAt: string | null`, `endReason: "superseded" | "corrected" | "expired" | null`, `lastConfirmedAt: string | null`), `fusion.ts`, `observe.ts`, `memory-store.ts`, `store-conformance.ts`, and their tests.

**Interfaces:**
- Produces: `isCurrent(m: Memory, at: Date): boolean` in `model.ts` = `m.expiredAt === null && m.validFrom <= at && (m.validTo === null || at < m.validTo)`; `MemoryStore.list(scope, { validOnly })` and `fuse()` use `isCurrent(m, now)` (or `asOf`) instead of `validTo === null`.
- `observe()` SUPERSEDE/UPDATE: the prior is closed at the new fact's `validFrom` (`prior.validTo = newMemory.validFrom`, `prior.expiredAt = now`, `prior.endReason = "superseded"`), not at `obs.at` when they differ. Out-of-order guard: if the new fact's `validFrom` is earlier than the prior's `validFrom`, the NEW memory is stored already closed (`validTo = prior.validFrom`, `expiredAt = now`, `endReason = "superseded"`, `supersededBy = prior.id`) and the prior stays current. REINFORCE sets `lastConfirmedAt = now`.
- A memory may be stored with a future `validTo` (explicit expiry) and remains current until then; consolidation (Task 7) sets `expiredAt = now`, `endReason = "expired"` once `validTo` has passed.

- [ ] **Step 1: Failing tests**: `model.isCurrent-future-validTo-is-current`, `model.isCurrent-past-validTo-is-not`, `fusion.keeps-future-expiry`, `observe.supersede-closes-prior-at-new-validFrom`, `observe.out-of-order-older-fact-closes-itself` (prior current, new memory stored closed, chain links both ways), `observe.reinforce-sets-lastConfirmedAt`, `consolidate.expires-past-validTo` (in Task 7), conformance `list-valid-only-uses-isCurrent` (a future-validTo memory is listed; a past-validTo one is not).
- [ ] **Step 2 → 5.** Commit `feat(core): bitemporal validity, out-of-order supersede guard, lastConfirmedAt`.

### Task 7: `consolidate`

**Files:**
- Create: `packages/core/src/consolidate.ts`, test.

**Interfaces:**
- Produces: `consolidate(scope: ScopeFilter, deps: { store: MemoryStore; config: ResolvedConfig; now?: Date }): Promise<{ promoted: string[]; demoted: string[]; evicted: string[]; expired: string[] }>` — first mark memories whose `validTo` has passed as `expiredAt = now`, `endReason = "expired"` (Task 6c); then recompute activation for every current memory, rank, assign `tierFor`, `setTier` on change, `coldPut` + drop embedding for new cold, and demote superseded and expired memories straight to cold.

- [ ] **Step 1: Failing tests**: `consolidate.top-n-hot`, `consolidate.stale-goes-cold-and-keeps-stub`, `consolidate.pinned-never-cold`, `consolidate.superseded-goes-cold`, `consolidate.idempotent`.
- [ ] **Step 2 → 5.** Commit `feat(core): consolidation job`.

### Task 8: SQLite store

**Files:**
- Create: `packages/store-sqlite/package.json`, `src/index.ts`, `src/schema.ts`, `src/cold.ts`, `src/index.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `storeConformance` from core.
- Produces: `openSqliteStore(opts: { path: string; coldDir: string; dimension: number }): Promise<MemoryStore>`; `ColdCodec { encode(m: Memory): Uint8Array; decode(b: Uint8Array): Memory }` using `node:zlib` `zstdCompressSync` level 19 / `zstdDecompressSync`, JSON payload including the embedding as base64 (so hydration never re-embeds). Dictionary support is a Phase 2 extension of `ColdCodec`.
  - Schema: `memories` (all `Memory` fields except embedding, JSON columns for `accessLog`, `entities`, `source`), `memories_fts` FTS5 over `text, stub, entities` with `content=memories`, `memories_vec` `vec0(id TEXT PRIMARY KEY, embedding int8[D])`, `cursors(key, value)`, `meta(key, value)` holding `dimension` (refuse to open when it differs). Scope filtering is done in SQL on `org_id, customer_id, agent_id, project_id IN (...)` with `project_id IS NULL` for global.

- [ ] **Step 1: Failing tests**: `storeConformance("sqlite", …)` on a temp dir, plus `store.private-project-isolation` (memory with projectId `p-private` not returned for `projectIds: [null, "p-other"]` on exact lexical match), `store.refuses-dimension-mismatch`, `cold.roundtrip-compresses` (encoded size < 60% of JSON for a 400-char memory), `cold.decode-under-3ms` (median over 100 decodes).
- [ ] **Step 2 → 5.** Commit `feat(store-sqlite): sqlite-vec + FTS5 store with zstd cold tier`.

### Task 9: Voyage embed and rerank adapters

**Files:**
- Create: `packages/embed-voyage/{package.json,src/index.ts,src/index.test.ts}`, `packages/rerank-voyage/{package.json,src/index.ts,src/index.test.ts}`

**Interfaces:**
- Produces: `voyageEmbedder(opts: { apiKey?: string; model: string; dimension: number; fetch?: typeof fetch }): Embedder` (batches ≤ 128, `input_type` from `kind`, `output_dtype: "int8"`, `output_dimension`); `voyageReranker(opts: { apiKey?: string; model: string; fetch?: typeof fetch }): Reranker`. Missing key throws `MissingCredentialError("VOYAGE_API_KEY")` whose message names the env var and the config key.

- [ ] **Step 1: Failing tests** with an injected `fetch` stub: `embed.batches-128`, `embed.sends-int8-and-dimension`, `embed.missing-key-names-fix`, `rerank.maps-scores-to-ids`.
- [ ] **Step 2 → 5.** Commit `feat: voyage embed and rerank adapters`.

### Task 10: Jev decision adapter

**Files:**
- Create: `packages/decide-jev/{package.json,src/index.ts,src/questions.ts,src/index.test.ts}`

**Interfaces:**
- Produces: `jevDecider(opts: { apiKey?: string; client?: { systemOne: Function } }): DecisionController`.
  - `gate`: one `systemOne` call, state `{ user, assistant, tools }`, questions: `shouldStore: noul("Does this exchange contain a fact, decision, preference, or procedure worth remembering in future sessions?")`, `salience: score(..., ["trivial","useful","important","critical"])` mapped to 0.1/0.4/0.7/1.0, and one `noul` per `MemoryType`.
  - `reconcile`: one call, state `{ observation, candidates: [{id, text}] }`, one `choice(..., { NOOP, REINFORCE, ADD, UPDATE, SUPERSEDE })` per candidate plus `novel: choice` when no candidates.
  - Every answer becomes a `Decision { stage, question, answer, probability }`.

- [ ] **Step 1: Failing tests** with a stubbed `client`: `gate.maps-answers`, `gate.one-call-per-observation`, `reconcile.one-call-for-all-candidates`, `reconcile.no-candidates-asks-novel`, `missing-key-names-fix`.
- [ ] **Step 2 → 5.** Commit `feat(decide-jev): TypeSafe Jev decision controller`.

### Task 11: System Two writer

**Files:**
- Create: `packages/writer/{package.json,src/index.ts,src/prompt.ts,src/index.test.ts}`

**Interfaces:**
- Produces: `aiSdkWriter(opts: { model: LanguageModel }): MemoryWriter`. Output validated with zod `{ text: string.max(600), stub: string.max(200), entities: string[].max(12), type: MemoryType }`. Prompt rules (exact copy in `prompt.ts`): de-contextualize, resolve coreferences, include the absolute date when the observation implies one, stub ≤ 35 tokens as summary + entity keywords, on `UPDATE`/`SUPERSEDE` receive the prior text and write the new current claim.

- [ ] **Step 1: Failing tests** with the AI SDK mock language model: `writer.returns-validated-shape`, `writer.rejects-overlong-stub` (retries once, then throws `WriterOutputError`), `writer.includes-prior-on-supersede`.
- [ ] **Step 2 → 5.** Commit `feat(writer): AI SDK memory writer`.

### Task 12: Claude Code integration

**Files:**
- Create: `packages/claude-code/{package.json,src/transcript.ts,src/hooks.ts,src/install.ts,src/import.ts}` and tests; fixtures under `packages/claude-code/test/fixtures/*.jsonl` (sanitised copies of real rows: text, tool_use, tool_result, thinking, and the non-message types `attachment`, `api-request`, `system`, `file-history-snapshot`, `queue-operation`).

**Interfaces:**
- Produces:
  - `parseTranscript(jsonl: string): Turn[]` where `Turn = { uuid: string; parentUuid: string | null; role: "user" | "assistant"; text: string; toolSummaries: string[]; timestamp: string; sessionId: string; cwd: string }`. Tool summaries: `tool_use` → `"<name>(<first 120 chars of input>)"`, `tool_result` → `"result: <first 200 chars>"`. Skips rows whose `type` is not `user`/`assistant`, rows with `isSidechain: true`, and user rows that are only `tool_result` blocks are merged into the previous turn's summaries.
  - `turnsToObservations(turns: Turn[]): Observation[]` — one observation per user→assistant pair, at the assistant's timestamp.
  - `handleUserPromptSubmit(input: { prompt: string; cwd: string; session_id: string }, deps): Promise<{ stdout: string; exitCode: 0 }>` — emits `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext": "<formatted>"}}` or empty stdout when skipped/empty; never non-zero.
  - `handleStop(input: { transcript_path: string; session_id: string; cwd: string; stop_hook_active: boolean }, deps)` — returns immediately when `stop_hook_active`; reads turns after the cursor `claude-code:<session_id>`, observes each, advances the cursor to the last processed uuid. Must finish within 30 s; if more than 20 unprocessed observations, process the newest 20 and log.
  - `handleSessionStart(input: { cwd: string; session_id: string }, deps)` — injects hot-tier memories under half the budget.
  - `installHooks(settingsPath: string, cmd: string): { changed: boolean }` — merges `hooks.UserPromptSubmit`, `hooks.Stop`, `hooks.SessionStart` entries whose command is `<cmd> hook <event>` into `~/.claude/settings.json`, idempotent, never removes other hooks. `uninstallHooks` reverses.
  - `importTranscripts(opts: { projectsDir: string; since?: Date; estimateOnly: boolean }, deps): Promise<{ sessions: number; observations: number; estimatedTokens: number; results?: ObserveResult[] }>` — estimated tokens = Σ (chars/4 + 400 writer overhead) × `writerFraction` where `writerFraction = 0.25` is config.
  - Every handler writes one line to `$OORT_HOME/logs/hooks.log` and catches every error.

- [ ] **Step 1: Failing tests**: `parser.skips-non-message-rows`, `parser.merges-tool-results`, `parser.skips-sidechain`, `hook.prompt-emits-additional-context`, `hook.prompt-skips-trivial-silently`, `hook.degrades-without-network` (embedder throws → stdout still produced from lexical hits, exit 0, log line written), `hook.stop-advances-cursor`, `hook.stop-noop-when-active`, `install.idempotent`, `install.preserves-other-hooks`, `import.estimate-only-writes-nothing`.
- [ ] **Step 2 → 5.** Commit `feat(claude-code): hooks, transcript parser, installer, importer`.

### Task 13: `oort` CLI

**Files:**
- Create: `packages/cli/{package.json,src/main.ts,src/wire.ts,src/commands/*.ts}`, tests via `execa` against the built bin.

**Interfaces:**
- Consumes: everything above. `wire(cwd): Promise<{ store, embed?, rerank?, decide?, write?, config, scope }>` builds adapters from `ResolvedConfig`; a missing adapter package or key produces the Smelt-style refusal: one sentence naming the config key, the env var, and the exact `pnpm add`/`export` to fix it.
- Produces commands: `oort init` (writes `~/.oort/config.json` with defaults and a project `oort.config.json` on `--project`), `oort install claude-code [--project]`, `oort uninstall claude-code`, `oort hook <UserPromptSubmit|Stop|SessionStart>` (stdin JSON → handler), `oort recall "<text>" [--json]`, `oort inspect [<id>]` (table: id, type, tier, activation, age, text; with id: full record incl. decisions and supersede chain), `oort explain "<query>"` (recall with explanations), `oort stats` (counts per tier, store size, cold dir size, RSS after loading), `oort consolidate`, `oort forget <id>`, `oort pin <id>`, `oort import claude-code [--since 30d] [--yes]` (prints estimate, asks for confirmation unless `--yes`), `oort export [--json]`.

- [ ] **Step 1: Failing tests**: `cli.init-creates-config`, `cli.recall-without-key-names-fix`, `cli.import-estimate-asks-before-running`, `cli.hook-exit-zero-on-garbage-stdin`.
- [ ] **Step 2 → 5.** Commit `feat(cli): oort command line`.

### Task 14: Benchmarks and long-horizon eval scaffold

**Files:**
- Create: `packages/core/bench/{ram.ts,latency.ts}`, `packages/core/eval/{format.md,run.ts}`, root script `bench`.

**Interfaces:**
- Produces: `pnpm bench` prints a table: memories count, RSS MB after `recall`, sqlite file MB, p50/p95 `recall` ms (lexical-only with fake embedder, and with real adapters when keys are present). Eval format: JSONL `{ question, expectedMemoryIds[], asOf }`; `pnpm eval <file>` prints recall@5 and recall@10. A 10k-memory synthetic generator seeds the bench.

- [ ] **Step 1:** Test `bench.synthetic-10k-under-150mb` (RSS delta < 150 MB, lexical-only). **Step 2 → 5.** Commit `chore: bench and eval scaffold`.

### Task 15: Dogfood install and README

**Files:**
- Modify: `README.md`; create `docs/claude-code.md`.

- [ ] **Step 1:** `pnpm build && node packages/cli/dist/main.js init && oort install claude-code` on Marcus's machine; run `oort import claude-code --since 14d` (estimate first, then confirm).
- [ ] **Step 2:** Start a new Claude Code session, ask a question about a decision from an imported session, verify the `<oort-memory>` block appears in the hook output log and the answer uses it.
- [ ] **Step 3:** `oort stats` and `pnpm bench` output pasted into `docs/claude-code.md` as the Phase 1 baseline.
- [ ] **Step 4:** Commit `docs: phase 1 baseline and claude code guide`.
