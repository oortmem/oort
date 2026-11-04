# Temporal knowledge in Oort: modelling, updating, retrieving and expiring facts that change

Date: 2026-11-03
Status: research note for Marcus to accept or reject item by item (see the last section)
Question: how should Oort model, update, retrieve and expire facts that change over time, and how does that fit the existing design?

> **Where this file lives.** This is the repo's first research note. Design docs live under
> `docs/superpowers/specs/` and plans under `docs/superpowers/plans/`. There was no folder for
> research, so this note starts `docs/research/`. Later notes should follow the same
> `YYYY-MM-DD-<topic>.md` naming.

Inputs read: design doc §5 (memory model), §5.4 (temporal validity), §6.1–6.2 (read and write
paths); Phase 1 plan Tasks 4–6, 10, 11 and 14. Where it matters, I also read the Phase 1 code in
`.worktrees/phase-1/packages/core/src/` (`observe.ts`, `fusion.ts`, `model.ts`), because some
findings depend on what the code does today and not only on what the plan says.

Source snapshots (shallow clones made on 2026-11-03; every code citation below refers to these commits):

| Repo | Commit | Commit date |
| --- | --- | --- |
| getzep/graphiti | `7e0342a49ce5` | 2026-11-03 |
| mem0ai/mem0 | `753496cf1435` | 2026-10-30 |
| letta-ai/letta (`archive` branch, the retired V1 server) | `56ba9c255526` | 2026-08-13 |
| letta-ai/letta-code (current Letta) | `9df436cffa58` | 2026-11-02 |
| langchain-ai/langmem | `839c3fa0fc2c` | 2026-10-30 |
| wanasit/chrono (chrono-node 2.10.3) | `59d0b2b3004a` | 2026-11-03 |
| xiaowu0162/LongMemEval | `9e0b455f4ef0` | 2026-05-11 |
| snap-research/locomo | `3eb6f2c585f5` | 2024-08-12 |

---

## Summary of the recommendation

Oort should become **bitemporal in the cheap, Graphiti-style way**, not the SQL:2011
system-versioned way. Each memory keeps its valid-time interval (`validFrom`, `validTo`). It adds a
transaction-time pair: `createdAt`, which already exists and becomes immutable, and a new
`expiredAt`. It also adds an `endReason` that separates "the world changed" (*superseded*) from "we
were wrong" (*corrected*). Tiering and access bookkeeping are never versioned. The write path
resolves relative times ("yesterday", "until Friday") against the observation timestamp in code,
with `chrono-node` (no LLM). It asks Jev only for judgments: is this a change of state, is the fact
time-bounded, what temporal kind is it. Ordering and supersession direction are decided in code from
the dates, because both Jev's own docs and Graphiti's source keep date arithmetic out of the model.
Reconciliation splits today's UPDATE/SUPERSEDE (which behave the same in code) into REFINE,
SUPERSEDE and CORRECT. REINFORCE now also records `lastConfirmedAt`, and a temporally misordered
SUPERSEDE (an older observation arriving late, which `oort import` will produce) closes the *new*
memory, not the old one. The read path classifies temporal intent into four modes, borrowed from
Snodgrass's current/sequenced/nonsequenced split: current (the default), as-of time T, history, and
known-at transaction time X. Validity is a hard **filter** and recency stays a soft **ranking
prior** (ACT-R activation already does this). Volatile facts get a staleness annotation and a
re-validation hook instead of silent decay. The Phase 1 items are small and protect data: correct
supersession intervals, an out-of-order guard, `expiredAt`/`endReason`, and chrono-based date
resolution. They should land before Marcus runs `oort import claude-code` on real transcripts,
because without them the import can write inverted validity intervals.

---

## 1. Bitemporal modelling: valid time vs transaction time

### 1.1 What the primary sources define

- Snodgrass names three kinds of time: user-defined time, valid time ("when a fact was true in the
  modeled reality") and transaction time ("when a fact was stored in the database"). He says they
  are orthogonal.
  Source: R. T. Snodgrass, *Developing Time-Oriented Database Applications in SQL* (Morgan Kaufmann, 2000), ch. 1, p. 4. Author's free PDF: https://www2.cs.arizona.edu/~rts/tdbbook.pdf
- Snodgrass also names three kinds of temporal statement: **current** ("now"), **sequenced** ("at
  each instant of time") and **nonsequenced** ("ignoring time"). He applies the split to queries,
  modifications, views and constraints. Section 7 below maps it onto Oort's recall modes.
  Source: same, ch. 1, p. 4.
- A valid-time table "capture[s] a history of reality". A transaction-time table "capture[s] a
  history of the changing state of a table": it grows monotonically, and rows are logically
  deleted, never physically. "We cannot ask the LOT table what its state was three days ago, but we
  can ask the LOT CONTAINS table that question."
  Source: same, ch. 2 §2.2, pp. 18–19.
- A table with both kinds of time is a *bitemporal table*. The worked example has four timestamps
  per row (FROM/TO for valid time, START/STOP for transaction time). A correction closes the
  transaction-time STOP of the old row and inserts a new row; it does not edit the old row.
  Source: same, ch. 2 §2.3, Table 2.10, pp. 20–21.
- SQL:2011 does not add a period data type. It adds **period definitions** over two ordinary
  columns, with **closed-open** semantics: the start instant is included and the end is excluded.
  Transaction time comes from *system-versioned tables*, whose period is named `SYSTEM_TIME`. Valid
  time comes from an *application-time period* with a user-chosen name.
  Source: K. Kulkarni, J.-E. Michels, "Temporal features in SQL:2011", *SIGMOD Record* 41(3), 2012, §2.1, pp. 34–35. https://sigmodrecord.org/publications/sigmodRecord/1209/pdfs/07.industry.kulkarni.pdf
- Application-time tables let the user set both period bounds to any past or future value.
  `UPDATE ... FOR PORTION OF` splits an overlapping row into up to three rows. `PRIMARY KEY (..., P
  WITHOUT OVERLAPS)` forbids two versions of the same key whose valid periods overlap.
  Source: same, §2.2–2.2.1, pp. 35–37.
- System-versioned tables: users cannot set or change `Sys_start`/`Sys_end`. Those columns must be
  `GENERATED ALWAYS`. An `UPDATE` first copies the old row as a *historical system row* ending at
  the transaction timestamp. A `DELETE` closes the row's system-time end rather than removing it. A
  query without a temporal clause behaves as `FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP`. Past state
  is read with `FOR SYSTEM_TIME AS OF`, `FROM ... TO` or `BETWEEN ... AND`.
  Source: same, §2.3–2.3.2, pp. 38–41.
- A bitemporal table "is very useful for capturing both the periods during which facts were
  believed to be true in the real world as well as the periods during which those facts were
  recorded in the database".
  Source: same, §2.4, p. 41.
- XTDB 2.x is bitemporal by default, with columns `_valid_from`, `_valid_to`, `_system_from` and
  `_system_to`. System time is "the immutable system-time timeline", and "users (rightly) have no
  control over system-time". By default a query sees system time "as best known" and valid time "as
  of now". Past state is read with `FOR VALID_TIME AS OF ...` or `FOR SYSTEM_TIME AS OF ...`, and
  `FOR ALL VALID_TIME` / `FOR ALL SYSTEM_TIME` read the whole history. XTDB's own example: on
  13 August, Mike reports an address change effective 1 September. That is a *future-dated*
  valid-time update, and the old address stays visible through system time.
  Source: XTDB docs, "Time in XTDB", https://docs.xtdb.com/about/time-in-xtdb.html

### 1.2 Where Oort is today

- The design keeps `valid_from`/`valid_to` plus `supersedes`/`superseded_by` (§5.1). "Retrieval
  filters to `valid_to IS NULL` by default; a caller can ask 'what was true at time T'" (§5.4).
- Phase 1 `observe` sets `validFrom = obs.at`, the observation timestamp. On UPDATE or SUPERSEDE it
  writes `{ ...prior, validTo: obs.at, supersededBy: id }`, and both actions run the same code.
  `createdAt`/`updatedAt` are set to the wall clock `now`.
  Source: `.worktrees/phase-1/packages/core/src/observe.ts`, `observe()`, lines ~111–148.
- `asOf` in fusion is valid time only: `validFrom <= asOf < validTo`. With no `asOf`, a memory
  counts as current only when `validTo === null`.
  Source: `.worktrees/phase-1/packages/core/src/fusion.ts`, `isValid()`.

So Oort has a valid-time interval, though it is filled with *observation* time rather than *event*
time. It also has a de facto transaction-time start (`createdAt`). It has no transaction-time end.
And `validTo` mixes three meanings: "stopped being true in the world", "we learned it stopped" and
"it was never true".

### 1.3 What transaction time would cost, and what it unlocks

There are two ways to add transaction time.

1. **Full system versioning (SQL:2011 / XTDB style).** Every change to a row copies the old version.
   In Oort that includes the access-log, tier, activation and embedding-eviction updates, which run
   constantly (design §5.3, plan Task 7). That would multiply rows several times over, conflict with
   goal G1 (bounded footprint), and record bookkeeping that is not knowledge. **Not recommended.**
2. **Four timestamps on the row, changed in place (the Graphiti model; see §2).** Add `expiredAt`
   (transaction-time end) and keep `createdAt` immutable as the transaction-time start (call it
   `recordedAt` in docs). Only *knowledge* events touch these fields: create, supersede, correct and
   retract. Access, tier and embedding changes never do. The storage cost is one nullable timestamp
   column plus one small enum column (`endReason`), and a partial index on `expiredAt IS NULL` in
   SQLite. No extra rows are written, because supersession already updates the prior row in place.

With option 2 and one invariant, Oort can answer both questions. The invariant: **`validTo` is set
only when the row is created (an explicit bound such as "valid until Dec 15"), or in the same write
that sets `expiredAt` because of supersession.**

| Question | Query |
| --- | --- |
| "What was true on date X?" (valid time, per current knowledge) | `endReason IS DISTINCT FROM 'corrected' AND endReason IS DISTINCT FROM 'retracted' AND validFrom <= X AND (validTo IS NULL OR X < validTo)` |
| "What did the agent believe on date X?" (transaction time) | `createdAt <= X AND (expiredAt IS NULL OR X < expiredAt)`. Treat `validTo` as open-ended whenever it was set at expiry (`endReason = 'superseded'`), since at time X the agent did not yet know the fact would end |
| "What is true now?" (default) | `expiredAt IS NULL AND validFrom <= now AND (validTo IS NULL OR now < validTo)` |

The second query matters for A6 (explainability) and for debugging the agent: "why did Claude use
port 3000 on 4 Nov? Because on 4 Nov Oort still believed it." It also matters in cloud mode for
customer-facing audit ("what did your agent know about me when it made that offer?"). This is
inference from the sources above, not a feature any source ships under this name.

One semantic fix comes free: SQL:2011 uses closed-open periods, and the Phase 1 `isValid()` already
uses `validFrom <= t < validTo`. Keep that convention in every store adapter and document it in the
`MemoryStore` contract.

---

## 2. Zep / Graphiti's temporal knowledge graph

### 2.1 The four timestamps

- The Zep paper describes "a bi-temporal model". Timeline *T* holds the chronological order of
  events, and *T′* holds the order in which Zep ingested data. Each edge tracks four timestamps:
  `t′created`/`t′expired` on *T′* and `t_valid`/`t_invalid` on *T*.
  Source: P. Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory", arXiv:2501.13956, §2.1 and §2.2.3. https://arxiv.org/abs/2501.13956
- In code, `EntityEdge` has `created_at`, `expired_at` ("datetime of when the node was
  invalidated"), `valid_at` and `invalid_at`. The `valid_at` description reads "future-tense
  plans/promises use the episode reference time rather than the future occurrence date". The
  `invalid_at` description reads "soft deadlines are not invalid_at". There is also a
  `reference_time` copied from the source episode.
  Source: `graphiti_core/edges.py`, class `EntityEdge`. https://github.com/getzep/graphiti/blob/7e0342a49ce5/graphiti_core/edges.py
- Episodes (the raw input) carry `valid_at`, described as "datetime of when the original document
  was created". That is the reference time that relative expressions resolve against.
  Source: `graphiti_core/nodes.py`, class `EpisodicNode`.

### 2.2 How contradictions invalidate edges

- An LLM call (`dedupe_edges.resolve_edge`) gets EXISTING FACTS (same endpoints) and FACT
  INVALIDATION CANDIDATES (a broader set), and returns `duplicate_facts` and `contradicted_facts`.
  The prompt guards hard against false contradictions. "Only mark a fact as contradicted when the
  NEW FACT and the existing fact cannot both be true." "Do NOT infer contradiction from recency
  alone, episode dates, meeting dates, weekly snapshots ... or a new event involving the same
  entities." Work done on a project does not contradict ownership of it.
  Source: `graphiti_core/prompts/dedupe_edges.py`, `resolve_edge()`.
- The *direction and the dates* of invalidation are decided in code, not by the LLM.
  `_apply_temporal_invalidation()` works in three steps. (a) If the new edge arrived with an
  `invalid_at`, it is already historical, so it gets `expired_at = now`. (b) If any candidate's
  `valid_at` is *later* than the new edge's, the **new** edge is closed: `invalid_at =
  candidate.valid_at`, `expired_at = now`. This is how late-arriving old facts are handled. (c)
  Then `resolve_edge_contradictions()` skips candidates whose intervals don't overlap. For any
  candidate that started earlier it sets `edge.invalid_at = resolved_edge.valid_at` and
  `edge.expired_at = now`.
  Source: `graphiti_core/utils/maintenance/edge_operations.py`, `_apply_temporal_invalidation()` and `resolve_edge_contradictions()`.
- The paper summarizes this: on temporally overlapping contradictions, "it invalidates the affected
  edges by setting their t_invalid to the t_valid of the invalidating edge".
  Source: arXiv:2501.13956, §2.2.3.
- Search does **not** filter out expired or invalidated edges by default. `SearchFilters` has
  optional `valid_at`, `invalid_at`, `created_at` and `expired_at` date filters, all defaulting to
  `None`, and the caller has to opt in.
  Source: `graphiti_core/search/search_filters.py`, class `SearchFilters`.

### 2.3 Temporal extraction in Graphiti

- Timestamps come from a separate small-model LLM call (`extract_edges.extract_timestamps`,
  `ModelSize.small`). It receives the fact and its REFERENCE TIME. Its rules: resolve "last week",
  "2 years ago" and "yesterday" against the reference time. Present tense means `valid_at =
  reference time`. A future plan, promise or deadline gets `valid_at = reference time`, with the
  future date kept in the fact text. A soft deadline ("by March 2026") is not `invalid_at`. A
  future `invalid_at` is used only for an ongoing state that ends then ("unavailable until December
  25"). A date with no time means 00:00:00. "Do NOT hallucinate."
  Source: `graphiti_core/prompts/extract_edges.py`, `extract_timestamps()`; caller `_extract_edge_timestamps()` in `edge_operations.py`.
- After the LLM call, a regex post-pass in code enforces the future-tense rule. If the fact matches
  `will|going to|plans to|scheduled to|...|'ll` and `valid_at` is after the reference time, it
  resets `valid_at` to the reference time. A deadline word (`by|before|due by`) without an
  ongoing-end word (`until|expires|ends|no longer`) clears `invalid_at`.
  Source: `graphiti_core/utils/maintenance/temporal_edge_utils.py`, `normalize_future_temporal_bounds()`.

### 2.4 Results that bear on Oort

- On LongMemEval, Zep raised temporal-reasoning accuracy over full-context baselines: gpt-4o-mini
  went from 36.5% to 54.1% and gpt-4o from 45.1% to 62.4%. Knowledge-update was mixed: gpt-4o-mini
  went from 76.9% to 74.4%, gpt-4o from 78.2% to 83.3%. The authors note that "additional
  development may be needed to improve less capable models' understanding of Zep's temporal data".
  Source: arXiv:2501.13956, §4.3.2, Table 3.

### 2.5 What Oort can borrow without a graph

The graph is not what makes the temporal handling work. The fact-level fields and the code-side
ordering rules do. Oort's AMU already plays the role of an edge: one de-contextualized claim.

1. The four-timestamp row (§1.3).
2. "Contradiction is decided by a model; the dates and the direction are decided by code." In Oort
   terms, Jev's `reconcile` answers "can both be true?", and code compares `validFrom` to choose
   which memory closes.
3. The out-of-order guard from `_apply_temporal_invalidation()` step (b).
4. The future-tense rule: a plan is a fact that is true *now* (the plan exists). Its occurrence date
   is metadata, not `validFrom`.
5. The anti-false-contradiction wording, for Jev's reconcile question text (plan Task 10).

Oort does not need entity resolution or graph traversal for any of these. Candidate lookup (design
§6.2 Stage B) already finds the related memories.

---

## 3. Mem0's update logic

- The **classic** Mem0 update prompt (`DEFAULT_UPDATE_MEMORY_PROMPT`) offers four operations per
  retrieved fact: ADD, UPDATE (keep the same id and replace the text, or "keep the fact which has
  the most information"), DELETE ("If the retrieved facts contain information that contradicts the
  information present in the memory, then you have to delete it") and NONE. Nothing in it mentions
  validity time.
  Source: `mem0/configs/prompts.py`, `DEFAULT_UPDATE_MEMORY_PROMPT` and `get_update_memory_messages()`. https://github.com/mem0ai/mem0/blob/753496cf1435/mem0/configs/prompts.py
- The Mem0 paper describes the same four operations (ADD, UPDATE, DELETE, NOOP), chosen by the LLM
  rather than a classifier. Its graph variant Mem0g instead marks conflicting relationships
  "invalid rather than physically removing them to enable temporal reasoning". On LoCoMo's temporal
  category it reports J scores of 58.13 for Mem0g, 55.51 for Mem0 and 49.31 for Zep.
  Source: P. Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory", arXiv:2504.19413, §2.1, §2.2, Table 1. https://arxiv.org/abs/2504.19413
- **Current Mem0 (SDK v2.0.0 / "V3 pipeline", 2026-04-14) no longer updates or deletes on write.**
  The changelog says: "Single-Pass Extraction: Replaced 2-LLM-call pipeline with additive
  extraction using `ADDITIVE_EXTRACTION_PROMPT`. Memories accumulate via `linked_memory_ids`: no
  more UPDATE/DELETE events." The migration guide says: "When information changes, the new fact is
  stored alongside the old one. Retrieval handles ranking". `DEFAULT_UPDATE_MEMORY_PROMPT` remains
  only in tests.
  Source: `docs/changelog/sdk.mdx` (v2.0.0 entry); `docs/migration/oss-v2-to-v3.mdx`; `mem0/memory/main.py`, `Memory._add_to_vector_store()` (uses `ADDITIVE_EXTRACTION_PROMPT`, hash-dedups, inserts only).
- The additive prompt pushes time *into the text*. It resolves relative references against an
  "Observation Date" ("CRITICAL: 'User went to Paris last week' is useless 6 months later"), never
  against the current date. It requires transitions to be captured as "what the new state is AND
  what it replaces" ("User switched from almond milk to oat milk lattes ..."). A contradiction is a
  reason to *link* (`linked_memory_ids`), not to delete.
  Source: `mem0/configs/prompts.py`, `ADDITIVE_EXTRACTION_PROMPT` (sections "Observation Date", "Contextually Rich, Not Atomic", "Memory Linking").
- What Mem0 does temporally:
  - `expiration_date` (YYYY-MM-DD) on `add`/`update`. In OSS, `search()`/`get_all()` hide expired
    memories, `get(id)` still returns them, and "Malformed dates fail open".
    Source: `mem0/memory/main.py`, `_normalize_expiration_date()`, `_payload_is_expired()`, `search(show_expired=False)`; `docs/platform/features/memory-expiration.mdx`.
  - A custom `timestamp` on add, for imports (Platform).
    Source: `docs/platform/features/timestamp.mdx`.
  - "Temporal Reasoning" (Platform v3 only): a ranking boost for memories whose event dates match
    time expressions in the query ("last week", "as of March 2025"), with `reference_date` to anchor
    "now". The docs say it is "not available in the OSS SDK", and OSS `search()` raises an error if
    `reference_date` is passed.
    Source: `docs/platform/features/temporal-reasoning.mdx`; `mem0/memory/main.py`, `search()` (`reference_date` → `get_temporal_feature_error_message`).
  - "Memory Decay" (Platform, opt-in per project): a multiplicative factor between 0.3× and 1.5× from
    access history. It is a "soft ranking bias, never a filter", and each returned result counts as a
    reinforcement.
    Source: `docs/platform/features/memory-decay.mdx`.
  - A SQLite `history` table (`memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role`), exposed as `Memory.history(id)`.
    Source: `mem0/memory/storage.py`, `SQLiteManager` schema; `mem0/memory/main.py`, `history()`.
- **What Mem0 does not do temporally** (from the code and docs above): no valid-time interval per
  memory; no record of when a fact stopped being true; no "as of T" filter in OSS; no supersession
  link that says which memory is current. With ADD-only, ranking alone has to stop the old and new
  versions from both surfacing as current. No temporal kinds (recurring, scheduled). No
  re-validation.
- Mem0's own changelog claims the V3 pipeline improves "Temporal reasoning: 'Where did I live before
  SF?' ... from 51% to 93%". That is a vendor claim in a changelog, and the source does not give the
  benchmark protocol. **Unverified.**
  Source: `docs/changelog/highlights.mdx`, 2026-04-14 entry.

Takeaway for Oort: Mem0 dropped destructive UPDATE/DELETE because it lost history. It now leans on
ranking to sort old from new. Oort's design (supersede, keep history, filter by validity) is the
stronger position, but only if validity intervals are *correct*. §6 and §10 cover that.

---

## 4. Letta / MemGPT and LangMem

### Letta

- Active Letta development has moved to `letta-ai/letta-code`. The V1 server lives on the
  `archive` branch.
  Source: `README.md` of letta-ai/letta (main). https://github.com/letta-ai/letta
- In the V1 server, core memory is edited in place by agent tools: `core_memory_replace`,
  `memory_replace`, `memory_insert`, `memory_apply_patch`, and `memory_rethink` ("completely
  rewrite the contents of a memory block"). Each calls `update_block_value`.
  Source: `letta/functions/function_sets/base.py` on `archive`, the functions named. https://github.com/letta-ai/letta/blob/archive/letta/functions/function_sets/base.py
- V1 has a `block_history` table ("Stores a single historical state of a Block for undo/redo
  functionality") with a per-block `sequence_number`, plus `BlockManager.checkpoint_block_async`,
  `undo_checkpoint_block` and `redo_checkpoint_block`. A grep of the archive branch finds these
  called only from `block_manager.py` itself and from tests, not from the memory tools. So agent
  edits overwrite the block without a history row unless something checkpoints it. **Partly
  unverified:** an external API client could call them, and I did not trace every route.
  Source: `letta/orm/block_history.py`, class `BlockHistory`; `letta/services/block_manager.py`.
- Archival memory search takes `start_datetime`/`end_datetime`, filtering on *creation* time
  ("Only return memories created after this time"). That is a transaction-time filter, not
  valid time.
  Source: `letta/functions/function_sets/base.py` (archive), `archival_memory_search()` docstring.
- Current Letta Code (MemFS): memory is Markdown files in a per-agent git repo, and "Every memory
  edit is committed to the MemFS git repository", which gives "version history, conflict
  resolution". Background "dreaming" subagents review recent conversations and update memory,
  triggered by a step count or by context compaction. The docs do not say whether outdated facts
  are rewritten or kept, and they do not mention staleness.
  Source: https://docs.letta.com/letta-code/memfs ; https://docs.letta.com/letta-code/memory ; letta-code `README.md`.

### LangMem

- `create_memory_manager(..., enable_inserts=True, enable_updates=True, enable_deletes=False)`.
  Updates cover existing memories "that are outdated or contradicted by new information". Deletes
  are off by default.
  Source: `src/langmem/knowledge/extraction.py`, `create_memory_manager()` docstring. https://github.com/langchain-ai/langmem/blob/839c3fa0fc2c/src/langmem/knowledge/extraction.py
- The default instructions tell the model to "Consolidate and compress redundant memories ...
  strengthen based on reliability and recency" and to "Remove incorrect or redundant memories".
  Source: same file, `_MEMORY_INSTRUCTIONS`.
- `MemoryStoreManager.ainvoke` writes updates as `store.aput(namespace, key=<same key>, value=...)`
  and removals as `store.adelete`. An update **overwrites** the item and keeps no prior version.
  Source: same file, class `MemoryStoreManager`, `ainvoke()` (final `asyncio.gather` of puts and deletes).
- The only time metadata comes from LangGraph's `Item`: `created_at` and `updated_at`.
  Source: langgraph `libs/checkpoint/langgraph/store/base/__init__.py`, class `Item`. https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/store/base/__init__.py

Takeaway: neither system models valid time. Letta keeps *text history*: undo/redo in V1, git in
Letta Code. LangMem keeps none. Oort's A6 ("what it superseded") is already ahead of both. The idea
worth borrowing is Letta's background "dreaming": consolidation runs revise memory off the request
path. §8 uses this for re-validation.

---

## 5. Temporal extraction: relative expressions to absolute `validFrom`

### 5.1 What the sources do

- Graphiti: an LLM call with a reference time, then a regex normalizer in code (§2.3).
- Mem0: a single extraction prompt resolves against "Observation Date" and writes the absolute date
  into the memory text (§3).
- The Phase 1 Oort writer prompt already says "include the absolute date when the observation
  implies one" (plan Task 11), but the result lands only in `text`. `validFrom` is always `obs.at`
  (`observe.ts`).

### 5.2 chrono-node as the zero-LLM resolver

- API: `chrono.parse(text, ref?, option?)`, where `ref` is a `Date` or `{ instant, timezone }`
  ("The instant when the input is written or mentioned"). `forwardDate: true` makes results fall
  after the reference. Each result has `start`/`end` components with `isCertain(component)`. There
  is a `chrono.strict` mode, and 17 locales ship (en, de, fr, ja, zh, sv, ...).
  Source: chrono `README.md` (sections "Parsing Reference", "Parsing Options", "Parsed Results"); `src/locales/`. https://github.com/wanasit/chrono/blob/59d0b2b3004a/README.md
- I tested chrono-node 2.10.3 locally with reference instant `2026-11-03T10:00Z`, `timezone: "UTC"`
  and default options. This is my own measurement, not a claim from the docs:

  | Input | chrono result | Verdict |
  | --- | --- | --- |
  | "we switched the port to 8080 yesterday" | 2026-11-02, day certain | correct |
  | "two weeks ago I moved to Berlin" | 2026-10-20 | correct |
  | "the token is valid until Dec 15" | 2026-12-15 (the "until" is not interpreted) | date right; the bound semantics need a rule |
  | "the sprint ends Friday" | 2026-11-06, day *not* certain | plausible; flag as uncertain |
  | "from Jan 5 to Jan 9" | start 2027-01-05, end 2027-01-09 | correct range |
  | "migration planned for next month" | 2026-12-03 (month certain, day implied) | needs month granularity |
  | "next quarter we move to Postgres" | 2027-02-03 (+3 months, not quarter-aligned) | wrong granularity |
  | "since March" | 2027-03-01 (nearest March, *future*) | **wrong direction**: "since" is past |
  | "standup every Monday" | a single Monday, 2026-11-02 | **no recurrence semantics** |

  Conclusion: chrono reliably handles deictic day and week expressions and explicit dates and
  ranges, which covers most "changed yesterday / until Dec 15" cases. Oort must add (a) tense and
  direction from the surrounding words ("since", "until", "ago", "will"), (b) granularity (keep
  "month" or "quarter" rather than a fake day), and (c) recurrence. The `isCertain()` flags give
  the granularity directly.
- Recurrence: the `rrule` package (2.8.1) converts English to RFC 5545 RRULE. `RRule.fromText("every
  Monday")` returns `FREQ=WEEKLY;BYDAY=MO`, and `"every 2 weeks on Friday"` returns
  `INTERVAL=2;FREQ=WEEKLY;BYDAY=FR`. But `"standup every Monday"` returns an empty rule, so the
  `every ...` span has to be cut out first. My local test.
  Source for the format: RFC 5545 §3.3.10 "Recurrence Rule", https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10 ; library: https://github.com/jakubroztocil/rrule

### 5.3 What Jev should and should not decide

- TypeSafe's own "Model jaggedness" page: "Jev reads dates as text, not as ordered quantities.
  Asking which of two dates comes first, how far apart they are, or whether one falls inside a
  window is unreliable." Its advice is to "Extract components; compare in code".
  Source: https://docs.typesafe.ai/model-jaggedness.md (section "Date and time comparison").
- TypeSafe's date-extraction cookbook asks seven `Choice` questions in one call (`mode` absolute,
  relative or none; `month`; `day`; `year`; `day_anchor`; `weekday`; `week_offset`) and resolves
  them in code: "The model reads what the text says and never does the calendar math." It routes
  low-confidence reads (`REVIEW_BELOW = 0.60`) for review.
  Source: https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md
- Choice and Score answers carry `probabilities` and a derived `confidence`. Noul answers are a
  single probability, with starting thresholds of 0.7 for yes and 0.3 for no. Several questions can
  go in one request (speculative fan-out).
  Source: https://docs.typesafe.ai/confidence.md ; https://docs.typesafe.ai/patterns/fan-out.md (listed in https://docs.typesafe.ai/llms.txt)

So these are the cheap judgments Jev can make. They can be added to the *existing* Stage A gate
call (plan Task 10 already makes one `systemOne` call per observation), so they add no extra
round trip:

| Key | Primitive | Question (draft wording) |
| --- | --- | --- |
| `stateChange` | Noul | "Does this exchange state that something *changed* (a value, decision, owner, location or preference is now different from before)?" |
| `timeBounded` | Noul | "Does the exchange say the fact is only true until a specific time, or only for a limited period?" |
| `temporalKind` | Choice | `state` (true until changed) / `event` (happened at a time) / `scheduled` (planned or promised for a future time) / `recurring` (repeats on a schedule) |
| `tense` | Choice | `past` / `present` / `future`. Fixes chrono's direction errors ("since March") |
| `volatility` | Score | "How likely is this fact to change within months?" with levels `stable`, `slow`, `volatile` |

Code then combines the chrono candidates with `tense` and `temporalKind` to set `validFrom`,
`validTo`, `dueAt` and `recurrence`. Jev never compares dates. **Unverified:** how well Jev
calibrates on these specific questions. They need tuning on Marcus's transcripts, as the design
already plans for thresholds (§6.3).

### 5.4 Recommended Oort extraction flow

1. Stage 0 scrub (unchanged).
2. **New, pure code:** run `chrono.parse(userText + assistantText, { instant: obs.at })` and the
   `every ...` recurrence span finder. This yields candidate times with spans, certainty and
   granularity. It costs no network and roughly microseconds.
3. Stage A gate: the existing Jev call plus the five temporal keys above.
4. Stage D writer (only for ADD/SUPERSEDE/CORRECT/REFINE): give the writer the resolved candidates
   ("yesterday = 2026-11-02") so the claim text carries absolute dates, as Mem0's prompt requires.
   Validate in code that every date in the writer's output appears among the chrono candidates or
   in `obs.at`. If not, drop the date or flag it. This closes the "hallucinated date" hole that
   Graphiti fights with prompt wording.
5. Code sets the time fields from the table in §6.

---

## 6. Kinds of temporal facts and how Oort should handle each

Field names refer to the proposals in §10. "Obs" is the observation timestamp `obs.at`.

| Kind | Developer example | Customer-agent example | Fields at write | Reconciliation | Read path |
| --- | --- | --- | --- | --- | --- |
| **Point state, superseded** | "auth service port changed from 3000 to 8080 yesterday" | "I moved to Gothenburg last month" | `temporalKind=state`, `validFrom` = resolved event time (else Obs), `validTo=null` | **SUPERSEDE**: prior `validTo = new.validFrom`, prior `expiredAt = now`, `endReason='superseded'`, links. Out-of-order guard: if `new.validFrom < prior.validFrom`, close the *new* one instead (Graphiti step b) | Current: only the new one. "Before the migration": walk the `supersedes` chain (history mode) |
| **Explicit expiry** | "this deploy token is valid until Dec 15"; "the sprint ends Friday" | "my Pro trial ends 2030-01-31"; "I'm away until the 20th" | `temporalKind=state`, `validTo` = resolved future bound (set at creation) | ADD. Nothing to supersede when the bound passes; it simply stops being current | Current filter must be `validTo IS NULL OR now < validTo`. **Phase 1 code drops any memory with a non-null `validTo`, so this kind is invisible today even while valid** (`fusion.ts isValid()`). Consolidation demotes it after `validTo` (as Mem0 hides expired memories without deleting) |
| **Recurring** | "standup every Monday 09:30" | "I pay rent on the 25th" | `temporalKind=recurring`, `recurrence` = RRULE, `validFrom` = Obs, `validTo=null` | A change of schedule is a SUPERSEDE of the recurrence ("standup moved to Tuesdays") | Treated as a current state. Code expands `recurrence` (rrule) to show the next occurrence in the injected line ("next: Mon 2026-11-09") |
| **Scheduled future** | "we'll migrate to Postgres next month" | "my wedding is on 14 June" | `temporalKind=scheduled`, `validFrom` = Obs (the plan exists now; Graphiti's rule), `dueAt` = resolved date at its granularity | ADD. When the event is later reported done, SUPERSEDE the plan with a `state` or `event` memory. If it is cancelled, SUPERSEDE with the cancellation | Current while `dueAt` is in the future. After `dueAt` it is shown as "planned for 2026-12; not confirmed as done" and flagged `needsRevalidation` (§8). It is never silently assumed true |
| **Decaying truth** | "Marcus prefers pnpm over npm"; "the team leans toward Convex" | "I'm vegetarian"; "prefers email over phone" | `temporalKind=state`, `volatility` from Jev, `lastConfirmedAt = Obs` | REINFORCE when restated: bump `lastConfirmedAt` (and access). A stated change is a SUPERSEDE | Always current until superseded, but the injected line shows age since confirmation ("stated 2026-03, may be outdated") once it passes the volatility threshold. Optional re-validation hook (§8) |
| **Event / episodic** | "the 2026-10-28 outage was caused by a bad migration" | "customer reported a double charge on 2 Nov" | `temporalKind=event`, `type=episodic`, `validFrom` = event time, `validTo = null` (a historical fact never stops being true) | Usually ADD. A later report about the *same* event that disagrees is CORRECT, not SUPERSEDE | Never filtered by validity. Ranked by relevance plus activation. Time-range queries ("what broke last week") filter on `validFrom` |
| **Correction (never was true)** | "sorry, it was 8081, not 8080" | "I said Malmö, I meant Lund" | New memory inherits prior's `validFrom` | **CORRECT**: prior `expiredAt = now`, `endReason='corrected'`, `validTo` untouched; links | Excluded from current *and* from as-of valid-time queries. Visible in known-at (transaction-time) queries and in `inspect` |

Note on events and §5.4 of the design doc: "Retrieval filters to `valid_to IS NULL` by default" is
right for states but harmless for events only because events never get a `validTo`. Saying that
rule out loud prevents a later "expire old episodes" change from silently deleting history.

---

## 7. Retrieval: point-in-time, ranges, recency vs validity, and fusion

### 7.1 Evidence

- LongMemEval's "time-aware query expansion": values are "additionally indexed by the dates of the
  events they contain". At query time an LLM pulls a time range out of time-sensitive questions,
  and that range is "used to filter out a large number of irrelevant values". This improved
  temporal-reasoning recall by 6.8% to 11.3% depending on value granularity (Recall@5 on rounds
  with key=value+fact went from 0.489 to 0.526 with GPT-4o as the expander). It **only worked with
  a strong LLM**: Llama 3.1 8B "often hallucinat[es] or miss[es] temporal cues".
  Source: D. Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", arXiv:2410.10813 (ICLR 2025), §4.2 and §5.4, Table 4. https://arxiv.org/abs/2410.10813
- TempRALM adds a temporal score to the semantic score: `TempRet = s(q,d) + τ(qt,dt)`, with `τ =
  α / (qt − dt)`, z-scored and rescaled to the semantic score's range. Documents later than the
  query time are masked to −∞. It reports "up to 74%" improvement over a baseline RALM on a
  tennis-results dataset.
  Source: A. Gade, J. Jetcheva, "It's About Time: Incorporating Temporality in Retrieval Augmented Language Models", arXiv:2401.13222, Eqs. 2–5. https://arxiv.org/abs/2401.13222
- TimeQA: facts "evolve with respect to time", for example presidents. The best model (FiD) reached
  46% against 87% for humans.
  Source: W. Chen, X. Wang, W. Y. Wang, "A Dataset for Answering Time-Sensitive Questions", NeurIPS 2021 Datasets track, arXiv:2108.06314. https://arxiv.org/abs/2108.06314
- Generative Agents score retrieval as a weighted sum of recency, importance and relevance, each
  min-max normalized. Recency is "an exponential decay function over the number of sandbox game
  hours since the memory was last retrieved" with a factor of 0.995, and all weights are 1.
  Source: J. S. Park et al., "Generative Agents", arXiv:2304.03442, §4.1. https://arxiv.org/abs/2304.03442
- Mem0 Platform's decay is bounded at 0.3× to 1.5× and is explicitly "never a filter" (§3).
- Mem0 Platform's temporal reasoning *re-ranks* by matching query time expressions against memory
  event dates, and does not filter (§3).

### 7.2 Synthesis for Oort

Evidence above shows two kinds of time signal, and they should not share one knob:

1. **Validity is a filter.** A superseded port is *wrong* as an answer to "what is the current
   port", no matter how often it was used. ACT-R activation (design §5.3) measures use, not truth.
   A heavily used old fact has high activation, so validity has to be applied before or apart from
   activation weighting. Today's `fuse()` does this (it drops invalid memories, then adds `0.1 ×
   activation`), and that order should stay.
2. **Recency is a prior.** Oort already has one, activation. Its time decay is the same kind of
   signal as Generative Agents' recency and Mem0's decay. A *separate* recency boost is not
   recommended. For temporal *questions*, the TempRALM and LongMemEval results argue for
   query-time-aware scoring: a range filter when the query names a period, and distance to the
   query's reference time when it names a point.

Recommended **recall modes**, set by a temporal-intent step in the read gate. The step is cheap: run
chrono on the query to find explicit times, and use a keyword list for "current / now / still /
before / after / used to / history / changed / when did". Jev comes in only in Phase 2, when the
sync path is allowed to call it.

| Mode | Snodgrass analogue | Trigger examples | Filter | Ranking change |
| --- | --- | --- | --- | --- |
| `current` (default) | current | "what's the auth port" | `expiredAt IS NULL AND validFrom <= now AND (validTo IS NULL OR now < validTo)` | none (RRF + activation) |
| `asOf(T)` | sequenced at one instant | "what port did we use on Oct 1", "as of the migration" | valid at T, excluding `corrected`/`retracted` | none |
| `range(T1,T2)` | sequenced over a period | "what broke last week", "decisions in October" | interval overlaps `[T1,T2)` | small bonus for overlap (LongMemEval-style). Events are filtered on `validFrom` |
| `history` | nonsequenced | "what was the port *before* the migration", "how has X changed" | none on validity; includes superseded | after rerank, expand each hit's `supersedes`/`supersededBy` chain and order it by `validFrom` |
| `knownAt(X)` | transaction-time AS OF | `oort inspect --known-at`, audit | `createdAt <= X AND (expiredAt IS NULL OR X < expiredAt)` | none |

"What was the port before the migration" is the hard case. There may be no memory whose text says
"before the migration". The right answer is the predecessor, in the `supersedes` chain, of the
memory that matches "port". So history mode retrieves by topic and then walks the chain in code.
That is one indexed lookup per hop, with no graph. If the question names the migration and a
migration memory (event or scheduled) exists, code can choose the chain member valid at the
migration memory's `validFrom`. This is a combination of the Graphiti and LongMemEval ideas, not a
technique any source ships.

Formatting: the injected line already shows `[type, age]`. It should show the validity window
whenever it is not open-ended or not current, for example `[semantic, 2026-10-02 → 2026-11-02,
superseded]` or `[preference, stated 2026-03, may be outdated]`. That lets the agent reason about
time even when retrieval is imperfect. This is the same move as Mem0's prompt and Graphiti's rule of
keeping dates in the text.

---

## 8. Updating memory beyond contradiction: re-validation, decay, "last confirmed"

Primary-source evidence on how production systems handle this:

- Mem0 Platform: *ranking* decay from access history, bounded and never a filter (§3). *Expiry*
  that hides and does not delete, and fails open on bad dates (§3). No re-validation flow is
  documented.
- MemoryBank: an Ebbinghaus-curve mechanism that lets the system "forget and reinforce memory based
  on time elapsed and the relative significance of the memory".
  Source: W. Zhong et al., "MemoryBank: Enhancing Large Language Models with Long-Term Memory", arXiv:2305.10250, abstract. https://arxiv.org/abs/2305.10250
- LongMemEval's study of commercial assistants: ChatGPT (GPT-4o) scored 0.5773 against 0.9184 for
  offline reading on a 97-question sample, and the authors observed that "ChatGPT tended to
  overwrite crucial information as the chat continues". That is evidence *against* destructive
  update.
  Source: arXiv:2410.10813, §3.4, Fig. 3a.
- Letta Code "dreaming" revises memory in background subagents, triggered by step counts or
  compaction (§4).
- HTTP caching gives a well-specified model for "serve, then revalidate". `stale-while-revalidate`
  "indicates that caches MAY serve the response ... after it becomes stale, up to the indicated
  number of seconds". `stale-if-error` allows a stale response on error.
  Source: RFC 5861 §3–4, https://www.rfc-editor.org/rfc/rfc5861.html
- **Unverified / not found:** I found no primary source (docs or code) for a production agent-memory
  system that *asks the user or agent to re-confirm* a stale fact. ChatGPT, Claude, Zep, Mem0,
  Letta and LangMem docs and code describe no such flow. Treat the design below as new.

Recommendation:

1. **Separate "used" from "confirmed".** Activation counts retrievals (design §5.3). A new
   `lastConfirmedAt` changes only when an observation *re-states* the fact (REINFORCE from the write
   path) or the user or agent confirms it. Retrieval must not touch it. Without this split, a
   frequently recalled but outdated preference looks fresh.
2. **Volatility classes, not a learned decay curve.** `volatility ∈ {stable, slow, volatile}` from
   the Jev `Score` at write time, with config defaults per class for a "confirm after" age (for
   example: never; 180 days; 30 days). A memory past its age is a *stale candidate*. It is not
   deleted and not filtered. This is the Mem0 "never a filter" stance, applied to truth rather than
   ranking.
3. **Annotate, then revalidate asynchronously** (the stale-while-revalidate model): inject stale
   candidates with an age annotation (§7.2). Consolidation (plan Task 7) collects stale candidates
   in scope and exposes them three ways. Through the MCP and SDK: `inspect --stale`. As a
   `SessionStart` hint: "3 memories may be outdated: …". In cloud: a list endpoint the
   customer-facing agent can turn into a natural question ("Are you still on the Pro plan?"). The
   answer comes back through `observe` as REINFORCE (confirmed), SUPERSEDE (changed) or CORRECT.
4. **Scheduled facts past `dueAt`** are a special stale case. The question is "did it happen?",
   not "is it still true?".
5. **Do not decay confidence numerically in Phase 1–2.** No source gives a validated decay constant
   for fact truth, as opposed to retrieval likelihood. An annotation plus a question is
   inspectable (A6). A hidden confidence curve is not.

---

## 9. Benchmarks: LongMemEval and LoCoMo, and what Oort's eval harness should adopt

### LongMemEval

- 500 questions across five abilities: Information Extraction, Multi-Session Reasoning, Knowledge
  Updates, Temporal Reasoning, Abstention. `question_type` is one of `single-session-user`,
  `single-session-assistant`, `single-session-preference`, `temporal-reasoning`,
  `knowledge-update` or `multi-session`, and question ids ending in `_abs` are abstention questions.
  Each instance has a `question_date`, `haystack_dates` (session timestamps), evidence session ids,
  and turn-level `has_answer` labels.
  Source: LongMemEval `README.md` (sections "Overview", "Data"). https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0/README.md
- Counts in the cleaned oracle file (`longmemeval-cleaned/longmemeval_oracle.json`, downloaded
  2026-11-03, my tally): 133 temporal-reasoning, 133 multi-session, 78 knowledge-update, 70
  single-session-user, 56 single-session-assistant, 30 single-session-preference, and 30
  abstention ids.
  Source: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
- Definitions: KU is the "Ability to recognize the changes in the user's personal information".
  TR is "Awareness of the temporal aspects of user information", covering explicit time mentions
  and timestamp metadata.
  Source: arXiv:2410.10813, §3.2.
- Grading is lenient where Oort should be strict. For knowledge-update, "If the response contains
  some previous information along with an updated answer, the response should be considered as
  correct". Temporal-reasoning grading tolerates off-by-one day counts.
  Source: `src/evaluation/evaluate_qa.py`, `get_anscheck_prompt()`.
- Example TR items need *event* time from the content, not session time. In one, three evidence
  sessions all fall on 2023-04-10 but the question asks "What was the first issue I had with my new
  car after its first service?" (my reading of the oracle file). This supports setting `validFrom`
  from extracted event time, not `obs.at`.

### LoCoMo

- Conversations average "300 turns and 9K tokens ... over up to 35 sessions". There are five QA
  categories: single-hop, multi-hop, temporal reasoning, open-domain knowledge, adversarial. Models
  lag humans by 56% overall and 73% on temporal reasoning.
  Source: A. Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents", arXiv:2402.17753, abstract, §1, §4.1. https://arxiv.org/abs/2402.17753
- In `locomo10.json` (10 conversations), numeric `category` 2 is temporal: the eval code appends
  "Use DATE of CONVERSATION to answer with an approximate date". Category 5 is adversarial, asked as
  "(a) Not mentioned ... (b) answer". Counts are 321 temporal and 446 adversarial out of 1,986.
  Sessions carry `session_<n>_date_time`. The mapping of categories 1, 3 and 4 to names is not
  stated in the README or code. **Unverified.**
  Source: `task_eval/claude_utils.py` (category branches); `README.MD` (data format); my tally of `data/locomo10.json`. https://github.com/snap-research/locomo/tree/3eb6f2c585f5

### Adopting their question types in Oort's harness (plan Task 14)

The plan's eval format is `{ question, expectedMemoryIds[], asOf }` with recall@5/@10. Extend it to:

```jsonc
{
  "question": "What port does the auth service use?",
  "questionType": "current",            // current | knowledge-update | as-of | history | range | temporal-reasoning | stale | abstention
  "questionDate": "2026-11-05T09:00Z",  // the read path's `now`, as in LongMemEval's question_date
  "asOf": null,                         // for as-of questions
  "expectedMemoryIds": ["m-8080"],
  "forbiddenMemoryIds": ["m-3000"]      // superseded or corrected rows that must NOT come back in this mode
}
```

New metrics:

- **stale-leak rate**: the share of `current`/`knowledge-update` questions where a forbidden
  (superseded) memory ranks in the top k. This is the direct measure of design goal G3 ("superseded
  facts are not returned as current"). LongMemEval's lenient KU grading would hide it.
- **as-of accuracy** and **history-chain accuracy**: did history mode return the predecessor?
- **abstention**: no memory should be returned above the injection threshold. This mirrors
  LongMemEval `_abs` and LoCoMo category 5.

Corpus: (1) Marcus's imported transcripts with hand-labelled supersede chains (port, package
manager, decisions), as the plan already intends. (2) In Phase 2, run LongMemEval_S end to end by
feeding each haystack session through `observe` with `at = haystack_dates[i]`. Oort's
`Observation.at` already supports this. Report KU and TR with LongMemEval's own grader for
comparability, plus stale-leak with Oort's.

---

## 10. Proposed changes to the Oort design

Each item stands alone. Accept or reject per row. "P1" means before or with Phase 1 Task 15 (the
dogfood import), because those items prevent corrupt intervals in real data. "P2" and "P3" follow
design §10.

### 10.1 `Memory` model fields

| # | Change | Why (section) | Phase | Accept? |
| --- | --- | --- | --- | --- |
| M1 | Document `createdAt` as **transaction-time start** (`recordedAt` in prose). It is immutable after insert, and no code path may rewrite it. `updatedAt` stays as bookkeeping. | §1.3 | P1 | ☐ |
| M2 | Add `expiredAt: string \| null`, the transaction-time end: when Oort stopped holding this row as current belief. Set only by SUPERSEDE, CORRECT, REFINE or an explicit retract. | §1.3, §2.1 | P1 | ☐ |
| M3 | Add `endReason: 'superseded' \| 'refined' \| 'corrected' \| 'retracted' \| null`. | §1.3, §6 | P1 | ☐ |
| M4 | **Semantics:** `validFrom` is the *event* time when the observation states or implies one (resolved by chrono), else `obs.at`. `validTo` may be a **future** instant (an explicit bound). Intervals are closed-open (SQL:2011). Invariant: `validTo` is written only at creation or together with `expiredAt`. | §1.1, §5, §6 | P1 | ☐ |
| M5 | Add `temporalKind: 'state' \| 'event' \| 'scheduled' \| 'recurring'` (default `state`). | §6 | P2 | ☐ |
| M6 | Add `dueAt: string \| null` (occurrence or deadline of a scheduled fact) and `dueGranularity: 'day' \| 'month' \| 'quarter' \| 'year' \| null`. | §2.3, §5.2, §6 | P2 | ☐ |
| M7 | Add `recurrence: string \| null` (RFC 5545 RRULE). | §5.2, §6 | P2 | ☐ |
| M8 | Add `lastConfirmedAt: string` (initially `validFrom` or `obs.at`). Bumped only by restatement or confirmation, never by retrieval. | §8 | P2 | ☐ |
| M9 | Add `volatility: 'stable' \| 'slow' \| 'volatile'` (from the Jev Score at write time). | §5.3, §8 | P2 | ☐ |
| M10 | Record how `validFrom`/`validTo`/`dueAt` were derived (`stated` \| `resolved` \| `observed`, plus the chrono span) as `Decision` entries in `source.decisions`, not as new columns. | A6, §5.4 | P1 | ☐ |

### 10.2 Reconciliation actions (Stage C, plan Tasks 4, 6, 10)

| # | Change | Why | Phase | Accept? |
| --- | --- | --- | --- | --- |
| R1 | **SUPERSEDE closes the prior at the new fact's `validFrom`, not at `obs.at`**, and sets prior `expiredAt = now`, `endReason='superseded'`. | §2.2 (Graphiti `resolve_edge_contradictions`) | P1 | ☐ |
| R2 | **Out-of-order guard:** if `new.validFrom < prior.validFrom`, the *new* memory is historical. Set `new.validTo = prior.validFrom` and `new.expiredAt = now`, and leave the prior untouched. Also sort `oort import claude-code` observations chronologically across sessions before observing. Without this guard, importing older transcripts after live use writes `validTo < validFrom` on the newer fact (current `observe.ts` writes `validTo: obs.at` unconditionally). | §2.2 (`_apply_temporal_invalidation`), §1.2 | P1 | ☐ |
| R3 | Split today's UPDATE into **REFINE**: same fact, more detail or better wording, same validity. The new row inherits prior `validFrom`. Prior gets `expiredAt = now`, `endReason='refined'`, `validTo` untouched. Today UPDATE and SUPERSEDE run identical code. | §1.2, §6 | P1 | ☐ |
| R4 | Add **CORRECT**: the prior was never true. The new row inherits prior `validFrom`. Prior gets `expiredAt = now`, `endReason='corrected'`. It is excluded from as-of queries. | §1.1 (Snodgrass corrections), §6 | P2 | ☐ |
| R5 | **REINFORCE from the write path also sets `lastConfirmedAt = obs.at`** (and keeps the access increment). | §8 | P2 (with M8) | ☐ |
| R6 | Jev's reconcile question asks only "can both be true?" and "is the new one a correction, a refinement, or a change in the world?". **Code** decides direction from dates. Reuse Graphiti's anti-false-contradiction wording ("Do NOT infer contradiction from recency alone…"). | §2.2, §5.3 (Jev jaggedness) | P1 (wording), P2 (CORRECT option) | ☐ |
| R7 | An explicit bound passing (`validTo <= now`) is **not** a reconciliation event. No write happens; the read filter and consolidation handle it. | §6, Mem0 expiry | P1 | ☐ |

### 10.3 Write-path extraction (Stages A and D)

| # | Change | Why | Phase | Accept? |
| --- | --- | --- | --- | --- |
| W1 | Add `chrono-node` to `@oortmem/core` (pure code, no network; this needs the zero-network guard to allow it). Run it on each observation with `instant = obs.at`, and pass the resolved candidates to the writer prompt. | §5.2 | P1 | ☐ |
| W2 | Validate writer output dates against the chrono candidates and `obs.at`, and drop or flag unknown dates. | §5.4 | P1 | ☐ |
| W3 | Add the five temporal keys (`stateChange`, `timeBounded`, `temporalKind`, `tense`, `volatility`) to the existing single Jev gate call. | §5.3 | P2 | ☐ |
| W4 | Recurrence span finder plus `rrule` for `recurring` facts. | §5.2 | P2 | ☐ |

### 10.4 Read path (design §6.1, plan Tasks 4–5)

| # | Change | Why | Phase | Accept? |
| --- | --- | --- | --- | --- |
| Q1 | Change the default validity filter from `validTo IS NULL` to `expiredAt IS NULL AND validFrom <= now AND (validTo IS NULL OR now < validTo)`, in `fuse()`, `MemoryStore.list(validOnly)` and the conformance suite. Design §5.4's wording changes to match. | §1.3, §6 | P1 | ☐ |
| Q2 | Define `asOf` in `RecallQuery` as **valid time**, excluding `corrected`/`retracted`. Add `knownAt` for transaction time (CLI `inspect --known-at`, and Observatory Timeline later). | §1.3, §7.2 | P1 (`asOf` doc), P2 (`knownAt`) | ☐ |
| Q3 | Temporal-intent step in the read gate choosing `current` / `asOf` / `range` / `history`: keyword heuristics plus chrono on the query in P1's sync path; Jev Choice in P2. | §7.2 | P2 (P1 may ship `current` + explicit `asOf` only) | ☐ |
| Q4 | History mode: after rerank, expand the `supersedes` chain in code and order it by `validFrom`. | §7.2 | P2 | ☐ |
| Q5 | Range mode: filter by interval overlap and give a small fusion bonus to overlap. No separate recency term; activation remains the recency prior. | §7.1 (LongMemEval §5.4, TempRALM) | P2 | ☐ |
| Q6 | Injection lines show the validity window, the `dueAt` status and the staleness age when they are not plain-current. | §7.2, §8 | P1 (window for superseded/bounded), P2 (staleness) | ☐ |
| Q7 | Keep the current order: validity filter **before** activation weighting. Never let activation re-admit an invalid memory. | §7.2 | P1 (already true; add a test) | ☐ |

### 10.5 Consolidation, re-validation and cloud

| # | Change | Why | Phase | Accept? |
| --- | --- | --- | --- | --- |
| C1 | Consolidation demotes memories whose `validTo <= now` or `expiredAt` is set straight to cold (extending plan Task 7's "superseded goes cold"). It never deletes them, since `forget` stays the only delete. | §6, Mem0 expiry | P1 | ☐ |
| C2 | Consolidation computes stale candidates (volatility age past threshold, or `dueAt` passed) and exposes them via `inspect --stale`, a `SessionStart` hint and, in cloud, an API list. Answers come back through `observe`. | §8 | P2 (local), P3 (cloud API) | ☐ |
| C3 | Field changes in M1–M9 must pass through the cloud `MemoryStore` adapters. In `encrypted` mode the timestamps stay plaintext metadata (they are needed for filtering). This leaks the *timing* of facts, not their content. Document it next to the existing embedding-inversion caveat in design §9. | §9 of design (inference) | P3 | ☐ |
| C4 | Observatory Timeline renders valid-time bars plus transaction-time markers (recorded or expired), and supersede trails use `endReason` to tell "changed" from "corrected". | design §13 | P2 | ☐ |

### 10.6 Evaluation (plan Task 14)

| # | Change | Why | Phase | Accept? |
| --- | --- | --- | --- | --- |
| E1 | Extend the eval JSONL with `questionType`, `questionDate` and `forbiddenMemoryIds`, and report **stale-leak rate** alongside recall@k. | §9 | P1 | ☐ |
| E2 | Fixture set from plan Review Focus 4 (A→B→C), plus out-of-order import, explicit expiry before and after the bound, correction, and a scheduled fact past `dueAt`. | §6, §10.2 | P1 | ☐ |
| E3 | Run LongMemEval_S through `observe`/`recall` with `at = haystack_dates[i]`, reporting KU and TR with the upstream grader plus Oort's stale-leak. | §9 | P2 | ☐ |

### What this deliberately does not propose

- No SQL:2011-style row versioning on every update: it would version access and tier churn and
  break G1 (§1.3).
- No knowledge graph: every Graphiti rule borrowed above works on single AMUs plus `supersedes`
  links (§2.5).
- No numeric truth-decay curve: no primary source gives one (§8).
- No ADD-only "let ranking sort it out" (Mem0 V3): it gives up G3's guarantee that superseded facts
  are not returned as current (§3).
