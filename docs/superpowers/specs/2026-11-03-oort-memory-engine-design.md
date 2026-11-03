# Oort: tiered open-source agent memory engine — design

Date: 2026-11-03
Status: draft for builder review
Source: Gemini PRD conversation (`~/Documents/open-source-agent-memory.pdf`), brainstorming with Marcus on 2026-11-03.

## 1. Intent

Agent memory products today (Mem0, Zep, Letta, Supermemory, the native ChatGPT and
Claude memories) keep every memory as a full-precision vector in a hot index forever.
The index grows to gigabytes, stale facts pollute recall, every turn pays an LLM
extraction pass, and multi-tenant isolation is a filter predicate rather than a
cryptographic boundary.

Oort is an open-source memory engine that behaves like human memory consolidation:
memories have an activation temperature that rises with use and decays with time, and
that temperature decides where they live (hot RAM, a quantized warm index, or
compressed cold storage). Retrieval is hybrid (lexical + dense), reranked by a
cross-encoder, and stays fast even when it has to reach into cold storage. A cheap
System One decision model gates what becomes memory; a generative LLM is only invoked
for the minority of turns that actually produce a new fact.

Two use cases must both work from day one, with the same core:

1. **Personal / developer memory.** Marcus in a Claude Code (or other agent harness)
   session wants it to remember last week's decisions, project conventions, and past
   incidents across sessions, locally, with bounded RAM and no required network calls.
2. **Customer-facing multi-tenant memory.** One deployment serves thousands of end
   customers through an agent. Each customer's memory is cryptographically isolated and
   hosted in Oort Cloud with a usage-based pricing model.

Oort grows out of Smelt (`github.com/smeltjs/smelt`, `/Users/mjnong/repos/smelt`),
Marcus's earlier reversible context-elision tool. Smelt's "elision stub that hydrates
losslessly on demand" primitive becomes Oort's cold-tier representation. Smelt itself
stays a separate project; Oort reuses ideas and, where the code is clean, extracts code.

## 2. Naming (decided)

- Product, repo, CLI, domains: **Oort**. Domains `oortcloud.dev` (docs, cloud console)
  and `oortmem.dev` (short links, package namespace) are registered on Cloudflare
  Registrar as of 2026-11-03.
- Package namespace: `@oortmem/*` on npm, `oortmem` on PyPI.
- Linear team: **Constellation** (key `CON`), workspace CellarNode. Constellation is
  the umbrella codename for the whole programme; it is not a product name.
- Tier names in code are plain: `hot`, `warm`, `cold`. The astrophysical names
  (Photosphere, Kuiper Belt, Oort Cloud, "comet hydration" for cold promotion) are
  documentation and marketing vocabulary only. *My call: code reads better with plain
  words, and "Oort" meaning both the product and the cold tier would be confusing in
  identifiers.*
- License: Apache 2.0 for every open-source package. Cloud control plane code may be
  source-available or private; see §9.

## 3. Goals, non-goals, anti-goals

### Goals

- G1. Bounded footprint: local vector index RAM stays under ~150 MB regardless of total
  history size, via Matryoshka truncation, int8/binary quantization, and cold eviction.
- G2. Fast hybrid retrieval: p95 under 100 ms for a warm-tier hit on a laptop, under
  200 ms when a cold stub must be hydrated. Sub-15 ms for hot-tier injection.
- G3. High long-horizon precision: recall of facts stated 10+ sessions ago does not
  degrade the way flat vector stores degrade; superseded facts are not returned as
  current.
- G4. Memory formation that does not call a generative LLM on most turns. Target:
  System Two writer invoked on 15–25% of turns; the rest handled by the decision gate.
- G5. Zero-network local mode: embedded store, local embedder, local reranker, local
  decision model, all optional swaps for the cloud equivalents.
- G6. Cryptographic multi-tenancy in cloud mode: per-customer envelope encryption,
  BYOK-compatible, crypto-shredding for deletion.
- G7. Open source, pluggable, no lock-in: a `MemoryStore` adapter contract with at least
  the local SQLite driver and the Convex driver shipped by the project.
- G8. First-class Claude Code integration as the first harness, then MCP for every other
  agent.

### Non-goals (for now)

- Replacing the agent runtime (Letta-style). Oort is a memory layer the agent calls.
- Knowledge-graph entity extraction and graph traversal on the write path.
- A chat UI. The cloud console is for keys, tenants, usage, and inspection only.
- Fine-tuning any models.
- Python SDK parity with TypeScript in Phase 1. Python comes as a thin client later.

### Anti-goals (would make this a failure even if it works)

- A1. The index grows without bound on disk or RAM. The whole point is tiering.
- A2. Retrieval that is "fast on hot, slow on cold". Cold hydration must be
  sub-200 ms or the tiering is a demotion to "archive".
- A3. Multi-tenant isolation that depends only on a `WHERE tenant_id = ?` filter.
- A4. A write path that silently calls an LLM per turn and bills the customer for it.
- A5. A required cloud dependency for the local developer case.
- A6. Opaque memory. Every stored memory must be inspectable, explainable (why it was
  stored, why it was retrieved, what it superseded), and deletable by hand.
- A7. A secret becoming a memory. API keys, tokens, passwords, private keys, and
  connection strings pasted into a conversation must never be stored, embedded, sent
  to a model, or injected back. Scrubbing happens at the observation boundary, before
  any adapter sees the text (decided by Marcus, 2026-11-03).

## 4. Constraints

- TypeScript-first. Node 22+ runtime. pnpm workspace, mirroring Smelt's conventions
  (oxlint, prettier, vitest, `pnpm verify`). *My call.* Phase 1 `verify` is format,
  lint, build, typecheck, test; Smelt's mutation runner and import-graph guards arrive
  in Phase 2 with the zero-network guarantee.
- No runtime dependency on `@smeltjs/*`. Code reused from Smelt (harness registry,
  config-seam resolver, hook command round-trip, elision stub shape) is copied and
  adapted under Apache 2.0 with attribution, because Smelt's Claude Code profile is
  built around `PreToolUse` and Oort needs `UserPromptSubmit`, `Stop`, and
  `SessionStart`. *My call.*
- Rust is reserved for a later high-performance index (RaBitQ / binary ANN) via napi-rs
  once the TypeScript engine has proven the design. Phase 1 ships no Rust. *My call:
  one language until the shape is settled; the adapter seam makes swapping the index
  internal.*
- Cloud control plane and hot tier on **Convex**. Warm tier at scale on **MongoDB Atlas**
  (native scalar/binary quantization, Lucene BM25, `$rankFusion`). Cold blobs on
  **Cloudflare R2** (domains already live on Cloudflare). *Marcus named Convex and
  MongoDB in the PRD; R2 over Convex file storage is my call for egress cost and
  because the domains and DNS are already there.*
- Cloud model defaults: Voyage AI embeddings (`voyage-3.5` / `voyage-3.5-lite`, with
  `voyage-code-3` for code), Voyage reranker, TypeSafe AI **Jev** as the System One
  decision model, a small generative model (Claude Haiku class) as the System Two
  writer through the Vercel AI SDK so the provider is swappable.
- Local model defaults: Qwen3-Embedding-0.6B (ONNX) for embeddings, bge-reranker-v2-m3
  (ONNX) for reranking, a tiny local LLM with logprob extraction over bracketed choices
  as the "LLM-as-Jev" fallback. Local models are downloaded on first use, never bundled.
- Every open-source package other than the explicit `*-voyage`, `*-jev`, and
  `*-convex` adapters makes zero network calls, and the test suite proves it the way
  Smelt's import-graph guards do.
- Secrets never leave the server side in cloud mode; the TypeScript SDK talks to Oort
  Cloud with scoped keys, never with Voyage/Jev/Anthropic keys.

## 5. The memory model

### 5.1 Atomic Memory Unit (AMU)

A memory is one self-contained claim, de-contextualized so it is true without the
conversation around it ("On 2026-11-04 the auth service port changed from 3000 to
8080", not "yeah let's switch it to 8080 tomorrow").

Fields:

- `id`, `scope` (see 5.2), `type` ∈ {`semantic`, `episodic`, `procedural`, `preference`}
- `text` (the claim), `stub` (≤ 35-token summary + entity keywords, written at the same
  time as the claim so cold demotion needs no LLM call), `entities[]`
- `salience` ∈ [0,1] (assigned at creation), `activation` (computed, see 5.3),
  `access_log[]` (timestamps of retrievals, capped and compacted)
- `valid_from`, `valid_to` (null while current), `supersedes` / `superseded_by`
- `source` (harness, session id, turn pointer, tool call id) for explainability
- `tier` ∈ {`hot`, `warm`, `cold`}, `embedding` (present in hot/warm only), `vector_dims`,
  `vector_dtype`
- `pinned` (never demoted below hot)

### 5.2 Scope

Every read and write carries a scope: `org_id`, `customer_id` (end customer or
"self" for personal mode), `agent_id`, optional `project_id`. Local mode fills these
with defaults. Cloud mode binds them into a signed context token checked at the store
adapter boundary, not in application code. Memories are never shared across
`customer_id` unless explicitly written to an `org`-level shared scope.

### 5.3 Activation and tiers

ACT-R style base-level activation:

    A(m) = ln( Σ_j t_j^(-d) ) + w_s · S(m)

with `t_j` = seconds since the j-th access (log compacted to a bounded summary), decay
`d ≈ 0.5`, salience weight `w_s` tuned later. Activation is recomputed lazily on read and
by a periodic consolidation job, never synchronously in the request path beyond a
cheap increment.

| Tier | Entry rule | Vector representation | Where (local) | Where (cloud) |
| --- | --- | --- | --- | --- |
| hot | top N by activation or pinned | int8 / fp16, in RAM | process memory | Convex reactive table |
| warm | activation above cold threshold | int8 (Phase 1), binary + rescoring (Phase 2) | sqlite-vec + FTS5 | MongoDB Atlas (quantized vector + BM25) |
| cold | activation below threshold | none; stub + entity hashes only | zstd blob on disk | zstd blob on R2 |

Transitions run in a background consolidation job (local: a scheduled task in the
daemon; cloud: a Convex cron). Cold promotion ("hydration") happens inline when a
stub matches a query: decompress, re-embed if the stored embedding was evicted,
re-insert into warm, bump activation. Cold blobs use zstd with a per-scope trained
dictionary; target ≥ 6× compression and < 3 ms decompression per memory.

### 5.4 Temporal validity

Contradictions are handled by time, not by graph traversal: a SUPERSEDE sets
`valid_to = now` on the old memory and links the new one. Retrieval filters to
`valid_to IS NULL` by default; a caller can ask "what was true at time T".

## 6. The two paths

### 6.1 Read path (`recall`, synchronous, budgeted)

1. **Gate.** A System One check (Jev, or local fallback): does this turn need memory at
   all, what modality (code identifier vs. natural language vs. temporal question),
   what token budget. Sub-10 ms target; skips the store entirely on trivial turns.
2. **Hot injection.** Pinned and top-activation memories in scope are available
   without search (the harness can inject them every turn under a small budget).
3. **Parallel first-stage recall.** BM25 over text+stub+entities, and quantized ANN over
   embeddings, both scoped, top 50 each.
4. **Cold hydration.** Any cold stub in the candidate set is hydrated in parallel.
5. **Fusion.** Reciprocal rank fusion of lexical and dense, then re-weighted by
   activation and temporal validity.
6. **Rerank.** Cross-encoder on the top 30–50; return top 5–10 within budget, each with
   an explanation (which stage matched, activation, tier, age).
7. **Adaptive stop.** A System One check on whether the result set is sufficient or the
   search should widen into cold. Phase 2.
8. Access log increments are written asynchronously.

### 6.2 Write path (`observe`, asynchronous, zero added latency to the agent)

Input: a turn observation (user text, assistant text, structured tool-call summaries
captured Smelt-style: file edits, exit codes, API responses).

- **Stage 0, secret scrub (pure code, local, always).** Before anything else, the
  observation passes a scrubber: pattern rules for known key shapes (AWS, GitHub,
  Anthropic, OpenAI, Voyage, Stripe, JWTs, PEM blocks, `postgres://` and similar
  URLs with credentials, `Authorization:` headers) plus a high-entropy token
  detector. Matches are replaced with `[REDACTED:<kind>]`; if a turn is mostly
  secret material the observation is dropped and logged as `skipped: secret`. The
  same scrubber runs on transcript import and on the read-path injection as a last
  line of defence. Nothing leaves the machine before Stage 0.

- **Stage A, gate and type (System One).** `should_store` probability, initial
  salience, memory type(s). ~75% of turns stop here, optionally reinforcing existing
  memories' activation instead.
- **Stage B, candidate lookup.** Fast ANN + lexical for the top 5 related existing
  memories in scope.
- **Stage C, reconciliation (System One, batched).** For each candidate pair choose
  NOOP/REINFORCE, ADD, UPDATE/MERGE, SUPERSEDE.
- **Stage D, writer (System Two).** Only for ADD/UPDATE/SUPERSEDE: a small generative
  LLM authors the de-contextualized claim and its stub in one call, with structured
  output validated before storage.
- Embed, store in warm (or hot if salience is high / pinned), link supersession.

Every stage's decision is recorded on the memory (`source.decisions`) so A6 holds.

### 6.3 System One interface

`DecisionController` is the interface: typed questions over structured state returning
calibrated probabilities. Two implementations ship: `@oortmem/decide-jev` (TypeSafe
Jev HTTP API, Choice/Noul/Score primitives) and `@oortmem/decide-local` (logprob
extraction over bracketed options on a tiny local LLM). Thresholds are config, tuned
on Marcus's own transcripts first.

## 7. Integration surfaces

- **Claude Code hooks (first harness, the tracer bullet).** `UserPromptSubmit` runs
  `recall` and injects results as additional context; `Stop` reads the transcript tail
  and enqueues `observe`; `SessionStart` injects hot memories. Smelt's harness registry
  (`packages/core/src/harness/claude-code.ts`) is the pattern to reuse for installing
  hooks into `.claude/settings.json`.
- **MCP server** exposing `recall`, `observe`, `pin`, `forget`, `explain`, `inspect`
  for every other harness (Cursor, Codex, Cline, custom agents).
- **TypeScript SDK** `@oortmem/sdk`. Two public contracts, deliberately distinct:
  - `Memory` is what agents and harnesses call: `{ recall, observe, consolidate,
    inspect, forget, pin }`. Self-hosters get one from `createMemory({ store, embed,
    rerank, decide, write })`; cloud users get one from `oortCloud({ apiKey, scope })`,
    a thin HTTP client.
  - `MemoryStore` is the low-level storage contract (upsert, lexical search, ANN,
    cold get/put, access-log updates) that self-hosters and the project's own drivers
    implement. In cloud mode the whole pipeline (gate, embed, rerank, decide, write)
    runs server-side against a server-side `MemoryStore`; the SDK never sees model
    keys. *My call, resolving a contradiction the builder check found: in managed
    mode the cloud is a `Memory`, not a `MemoryStore`.* In `zero-knowledge` mode
    (§9) the cloud additionally exposes an encrypted `MemoryStore` so the pipeline
    can run client-side with `createMemory({ store: oortCloudStore(key, dek), … })`.
- **CLI** `oort`: `init`, `install claude-code`, `recall "<query>"`, `inspect`, `stats`,
  `consolidate`, `forget`, `export`, `serve` (local daemon + MCP).
- **Python** later: thin client over the local daemon's HTTP and over Oort Cloud.

## 8. Local engine (Phase 1 target)

- **One global store per machine**, under `~/.oort/`, project-aware (decided by
  Marcus). Memories carry `project_id` (derived from the repo root, overridable in
  `oort.config.json`). `recall` searches the current project plus global memories by
  default. A project can set `private: true` in its `oort.config.json`, after which its
  memories never surface in any other project and are never promoted to global.
  Claude Code hooks therefore install at user scope (`~/.claude/settings.json`), with
  the project-scope install kept as an option.
- Single SQLite file for that store: `memories` table, FTS5 virtual table over
  `text, stub, entities`, sqlite-vec `vec0` table for int8 embeddings (512-d Matryoshka
  truncation of a 1024-d model by default), `access_log` compacted summaries.
- Cold blobs: `cold/<scope>/<id>.zst` on disk with a trained dictionary per scope;
  index row keeps stub, entities, and blob pointer. The blob includes the original
  embedding so hydration never re-embeds. *My call, so cold promotion stays local and
  under the latency target even when the embedder is remote.*
- Daemon: a long-lived local process (`oort serve`) so hooks pay no startup cost;
  hooks fall back to in-process if the daemon is down.
- Embedding/rerank/decide adapters resolved from `oort.config.json` the way Smelt
  resolves its rerank seam, with explicit refusal (and the exact command to fix it)
  when a configured adapter is missing.

## 9. Cloud (Phase 3 target, designed now so the adapter seam is right)

- Control plane on Convex: orgs, API keys, scoped context tokens, usage metering,
  consolidation crons, hot-tier reactive tables.
- Warm tier adapter on MongoDB Atlas; Convex-only adapter for small deployments.
- Cold tier on R2 with per-customer encrypted zstd blobs.
- Envelope encryption: per-customer DEK (AES-256-GCM) wrapped by a KEK in a KMS
  (BYOK supported). Deleting a DEK shreds the customer.
- Two cloud deployment modes, selected per org, because "operators can see nothing"
  and "the cloud runs the pipeline" pull in opposite directions (Marcus, 2026-11-03):
  - `managed`: the cloud runs the full pipeline. Per-customer DEKs, KEK in our KMS by
    default or the customer's KMS with BYOK. With BYOK every unwrap is in the
    customer's own audit log and they can revoke us; but plaintext exists in server
    memory during embed, rerank, decide, and write. Honest label: "we cannot read your
    data at rest without your key", not zero-knowledge.
  - `zero-knowledge`: the pipeline runs on the customer's side (their SDK, worker, or
    enclave) with their own model keys; the cloud is an encrypted `MemoryStore`
    holding ciphertext, quantized embeddings, and HMAC blind-index tokens only. We
    never hold a DEK. Caveat documented to customers: quantized embeddings still leak
    some information under inversion attacks; this mode is "cannot read", not
    "cannot infer anything". This mode is why the cloud exposes both a `Memory`
    (managed) and an encrypted `MemoryStore` (zero-knowledge); see §7.
  - Operator access in both modes: no console or support path ever renders memory
    text; inspection tools operate on metadata and counts only, and every privileged
    action is audit-logged.
- Two per-org index isolation modes, because full encryption and full-text search
  pull in opposite directions. *My call; Marcus's requirement was "encrypted in many
  cases", not all.*
  - `encrypted` (default): text, stub, metadata, and cold blobs are encrypted with the
    DEK before disk. The warm index holds only quantized embeddings plus HMAC
    blind-index tokens over entities, so the lexical leg of retrieval is exact-match
    over entity tokens rather than BM25.
  - `searchable`: text, stub, and entities are plaintext inside tenant-scoped
    documents (encryption at rest by the database only), enabling full BM25 and
    MongoDB `$rankFusion`.
  - Consequence for the core: `lexicalSearch` is an optional `MemoryStore` capability
    and the fusion step must work with a dense-only or entity-only lexical leg.
- Pricing (from the PRD, to validate before launch): free developer tier (50k
  recalls, 10k observes, 1 GB warm, 10 GB cold), Pro $49/mo usage-based, Enterprise
  BYOK/VPC $999/mo. Priced on active operations + tiered storage, never per seat.
- Docs and landing on `oortcloud.dev` served from Cloudflare; console on
  `app.oortcloud.dev`.

## 10. Phasing

1. **Phase 1, local tracer bullet.** Monorepo, `@oortmem/core` types and pipeline,
   SQLite store, Voyage embed + rerank adapters, Jev decide adapter, AI SDK writer,
   Claude Code hooks, CLI, and `oort import claude-code` (decided by Marcus: an
   explicit import of existing `~/.claude/projects` transcripts that shows an
   estimated token cost and asks before running; it seeds real memories and doubles
   as the long-horizon eval corpus). Marcus's Claude Code sessions remember across
   sessions, on his machine. Benchmarks for RAM, latency, and recall exist from the
   first week.
   Decided by Marcus: Phase 1's synchronous read path may be network-bound (Voyage
   embed + rerank over HTTPS, roughly 300–600 ms per turn) and requires Voyage,
   TypeSafe and Anthropic keys. The sync path uses a cheap heuristic gate (no Jev
   call); Jev runs only on the async write path in Phase 1. The G2 latency targets
   and A5 (no required cloud dependency) are Phase 2 acceptance criteria.
2. **Phase 2, local completeness and quality.** Local ONNX embed/rerank, local decide
   fallback, binary quantization with rescoring, adaptive stopping, MCP server,
   consolidation tuning, long-horizon recall eval harness, zero-network guard tests,
   and **Observatory** (§13) against the local daemon: `oort ui` first, Tauri shell
   second. Cloud connection in Observatory lands with Phase 3.
3. **Phase 3, cloud.** Convex control plane and hot tier, MongoDB warm adapter, R2
   cold, envelope encryption, usage metering, console, docs site, pricing.
4. **Phase 4.** Python client, Rust index, more harnesses, public launch.

## 11. Left to the builder

- Exact SQLite driver (`better-sqlite3` vs `node:sqlite`) and how sqlite-vec is loaded.
- Exact zstd binding and dictionary training strategy.
- Internal module layout within `@oortmem/core`, as long as the adapter seams in §7 hold.
- Exact activation thresholds, decay constants, Matryoshka dimension, and candidate
  counts; all config with sensible defaults and a benchmark that justifies them.
- Transcript parsing details for the Claude Code `Stop` hook.
- Eval dataset construction for long-horizon recall.
- Choice of ONNX runtime for local models.

## 12. Decisions log

Answered by Marcus on 2026-11-03 after the builder check:

- Phase 1 read path may be network-bound; latency targets are Phase 2 criteria.
- One global, project-aware store per machine with a per-project `private` flag.
- Transcript import is a Phase 1 deliverable, explicit, with a cost estimate.
- Secrets are scrubbed at the observation boundary before any adapter (A7, §6.2
  Stage 0); Phase 1.
- Cloud ships `managed` (BYOK) and `zero-knowledge` (client-side pipeline) modes;
  operators never see memory text in either (§9).

Calls made by the author (Claude) rather than Marcus, for him to check:

- Plain `hot`/`warm`/`cold` names in code; astro names in docs only (§2).
- TypeScript only in Phases 1–2; Rust deferred (§4).
- Cloudflare R2 for cold blobs rather than Convex file storage (§4).
- No runtime dependency on Smelt; copy and adapt with attribution (§4).
- Cloud is a `Memory`, not a `MemoryStore`; pipeline runs server-side (§7).
- Cold blobs carry the embedding so hydration never re-embeds (§8).
- Two per-org isolation modes, `encrypted` (default) and `searchable` (§9).
- Mutation runner and import-graph guards start in Phase 2, not Phase 1 (§4).

## 13. Observatory: the visual memory viewer (added 2026-11-03)

Marcus wants people to *see* their memory, not only query it, in a dark, space-themed
view like the seven reference frames in `docs/design/reference/` (a star map of
clusters, a timeline of entries, a "dive" query with orbiting results, a three-item
bottom nav). We adhere to that visual language and add our own touch with purposeful
animation; it must be really simple to run, small, and efficient, and it must work
against a local store and against Oort Cloud so cloud customers can manage memory from
the same app.

Decided:

- **One UI codebase, two shells.** `apps/observatory` is a web app (React + Vite,
  `motion` for UI animation, a hand-written canvas 2D star field for the map; no
  three.js, no heavy charting). It is served locally by `oort ui` (a tiny static server
  plus the daemon's HTTP API) and wrapped unchanged in a **Tauri** desktop shell for the
  "small and efficient desktop app" case (Tauri binaries are a few MB and use the
  system webview; Electron is excluded). *My call: one codebase keeps it simple to run
  and to maintain; Tauri satisfies small and efficient.*
- **Data source is the `Memory` API over HTTP**, never the SQLite file directly: the
  local daemon (Phase 2, CON-18) for local stores, Oort Cloud for cloud stores,
  switchable in Settings. In zero-knowledge mode the desktop app holds the DEK and runs
  the pipeline, which is the only way the viewer can show cloud memory text without the
  cloud seeing it.
- **Three destinations** (mirroring the reference nav): **Discover** (star map +
  dive), **Timeline** (chronological entries with supersede trails), **Settings**
  (store/cloud connection, keys, privacy, forget/export). No fourth tab.
- **Mapping to the memory model**: cluster = project (default) or entity topic
  (toggle); star = memory; brightness = activation; size = salience; distance from
  cluster centre = tier (hot central, warm mid, cold faint on the rim); a query lights
  the matching stars blue and draws them into orbit around the query body; hydration
  of a cold memory is an inward drift-and-brighten animation; supersede chains are a
  short trail. Every star opens the memory's explanation and decisions (A6).
- **Animation rules**: every animation explains a state change (recall, hydration,
  consolidation, supersede); nothing loops for decoration except the slow background
  star drift; respects `prefers-reduced-motion`; 60 fps on a 2020 laptop with 10k
  stars (canvas, not DOM nodes).
- **Operator blindness holds in the viewer**: the viewer is the customer's, not ours;
  there is no admin viewer that renders text.

Left to the builder: exact layout at desktop widths (the references are phone
frames), cluster layout algorithm (a force layout seeded by project, then entity
co-occurrence), Tauri plugin set, and how the desktop app stores the cloud API key
(OS keychain via Tauri).

## 14. Data lifecycle, billing states, export, deletion, and legal (added 2026-11-03)

Marcus's requirement: a cloud customer who misses a payment or stops paying must be
able to export their data or regain access by resuming payment; deletion must be
real and GDPR-compliant; terms of service, terms of use, privacy policy and related
documents must exist. These are product rules, designed now so Phase 3 builds them in.

### 14.1 Principles

- **Export is never gated.** A customer can export everything they own at any time,
  in any billing state short of "deleted", through the API, the CLI (`oort export
  --cloud`), and the console. Export includes memories (text, stub, entities, type,
  salience, validity window, supersede links, decisions), access logs, cold blobs
  (decompressed), per-customer scopes, and account metadata, as a documented JSON
  Lines format plus a manifest, importable into a self-hosted Oort with `oort import
  oort-export`. In `zero-knowledge` mode the export is ciphertext plus the customer's
  own key material reference; the CLI decrypts locally.
- **Resuming payment restores everything instantly** at any point before deletion.
  Nothing is thrown away while the account is in a recoverable state.
- **Deletion is cryptographic first, physical second.** Deleting a customer or an
  org destroys the DEK (and the KEK grant for BYOK), which makes every copy of the
  data, including backups, unreadable at once; physical purge of ciphertext and
  backups follows on a fixed schedule and is confirmed to the customer.
- **No surprise deletion.** Every state transition that moves toward deletion sends
  notice to the account owners with the date it will happen and how to stop it.

### 14.2 Billing states (proposed defaults, Marcus to set the numbers)

| State | Entered when | Reads | Writes | Export | Console | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | paid | yes | yes | yes | yes | payment fails → `grace` |
| `grace` (14 days) | payment fails | yes | yes | yes | yes, with banner | payment succeeds → `active`; day 14 → `read-only` |
| `read-only` (60 days) | grace expires | yes | no (`402 Payment Required` with a link) | yes | yes | payment → `active`; day 74 → `suspended` |
| `suspended` (30 days) | read-only expires | no (`402`) | no | yes | export and billing only | payment → `active`; day 104 → `pending-deletion` |
| `pending-deletion` (7 days) | suspended expires, or owner requests deletion | no | no | yes | export and cancel-deletion only | cancel → `active` (if paid) or `suspended`; day 111 → `deleted` |
| `deleted` | window expires | no | no | no | account closed | none; DEK destroyed, purge schedule starts |

Free developer tier accounts have no payment and skip to `read-only` only on
abuse or inactivity rules defined later. Enterprise contracts override the table.
*Window lengths are my proposal; they are configuration, not code.*

### 14.3 Deletion and GDPR

- **Right to erasure.** An owner can delete a single customer scope, a project, an
  org, or the whole account. Customer-scope deletion (the B2B2C case: our customer's
  end-user asks to be forgotten) is an API call and a console action that destroys
  that customer's DEK immediately; the API returns a deletion receipt with a
  timestamp and the purge deadline.
- **Purge schedule.** Ciphertext rows and cold blobs are physically deleted within
  30 days; backup snapshots containing them expire within 90 days; the receipt
  states both. These numbers go into the privacy policy.
- **Roles.** For account data (owners, billing, keys) Oort is the data controller.
  For memory content Oort is a data processor on behalf of the customer, who is the
  controller for their end-users' data; this needs a Data Processing Agreement with
  standard contractual clauses, a subprocessor list (Convex, MongoDB Atlas,
  Cloudflare, Voyage AI, TypeSafe AI, Anthropic, the payment provider), and an EU
  hosting option before any EU customer in `managed` mode. `zero-knowledge` mode
  reduces but does not remove the processor role (we still store ciphertext and
  metadata).
- **Data subject requests.** Access, rectification, erasure and portability map to
  `inspect`/`export`, `forget`/`observe`, delete, and export respectively; the
  console exposes them per customer scope so our customers can serve their users.
- **Audit.** Every deletion, export, key destruction and billing-state transition
  is written to an append-only audit log kept for the legal retention period even
  after account deletion (it contains identifiers and timestamps, never memory
  text).

### 14.4 Legal documents (Infra & brand; lawyer review required)

Terms of Service (cloud), Terms of Use / Acceptable Use Policy, Privacy Policy
(with the purge schedule and subprocessors), Data Processing Agreement with SCCs,
Cookie notice for the console and site, Security overview (encryption modes,
BYOK, zero-knowledge caveats), SLA for Pro and Enterprise, and the open-source
license notice (Apache 2.0) with a trademark policy for the Oort name and mark.
Drafts are produced by us from reputable templates; a lawyer reviews before launch;
nothing in this section is legal advice.
