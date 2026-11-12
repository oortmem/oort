# Memory relationships: typed, cheap, explained links between memories

Date: 2026-11-12. Status: proposed design, docs only; nothing here is built. Epic: CON-145
(slices CON-146 to CON-154). Related: CON-144 (forgetting a memory also removes its value from
its successor, in progress on another branch), CON-25 (may take the next schema version).

Oort memories are separate records today. The only typed relationship is the version chain
(`supersedes` / `supersededBy`), plus a cross-node contradiction marker. A person's memory
works differently: things come back because they are associated with what came back first.
This design adds a small association layer: a few kinds of link, each formed by a cheap rule
with no model call on the write path. Recall follows them one bounded hop from its best hits,
every memory a link brings in says which link and which hit brought it, and forgetting a memory
removes its links in the same transaction.

It is an association layer, not a knowledge graph. There is no entity-relation extraction, no
triple store, no graph database and no multi-hop traversal.

Calls marked **(my call)** are choices this design makes beyond the approved direction. Each can
be overruled on its own without changing the rest.

## 0. Decisions in brief

1. **Six plain kinds.** `about` (two memories share a specific entity), `episode` (written in
   the same session a few turns apart), `recalledWith` (were useful together in a recall),
   `supersedes` (exists today), `derivedFrom` (a general memory and the specific memories it
   was distilled from) and `explicit` (a person or agent said so).
2. **Two of them are indexes, not rows.** `about` and `episode` are computed from each memory's
   own fields (`entities`, `source.sessionId`), so storage stays linear in the number of
   memories. Only `recalledWith`, `derivedFrom` and `explicit` write pair rows, and each is
   capped.
3. **No model call on the write path.** `about`, `episode`, `recalledWith` and `explicit` are
   code. `derivedFrom` is written only by an opt-in, batched consolidation step, one writer call
   per new general memory, never per link.
4. **One bounded hop at recall.** From the top 3 hits that pass the relevance gate, at most 5
   neighbours join the rerank pool (at most 2 are appended when there is no rerank). Each carries
   `explanation.via`. Links never cross a scope node.
5. **Links never decide truth or warmth.** The validity filter applies to a neighbour exactly as
   to a hit. A cold neighbour warms only if it is actually returned (injected), exactly like a
   hit. A link alone never changes a tier.
6. **Erasure is structural.** Link and entity rows reference the memory with
   `ON DELETE CASCADE`. Memories whose text may restate a forgotten one (successors, derived
   memories) are handled by the mechanism CON-144 lands.
7. **Behind a flag.** `recall.links` is off by default until the eval bar in section 11 clears.
   The write-side indexes and explicit links do not change what recall returns, so they ship
   unflagged.
8. **Plain names in every API.** Astronomy appears only in the star map's drawing (section 13).

## 1. Why

- **What helps, measured.** In published agent-memory systems, the gains come from cheap
  structure plus bounded expansion from normal search hits: temporal adjacency, co-retrieval and
  shared specific concepts, with decay and fan normalisation. Synapse (arXiv:2601.02744) loses
  4.4 average F1 on LoCoMo without fan normalisation; HeLa-Mem (arXiv:2604.16839) loses 2.55
  without its spreading term; A-MEM's ablation (arXiv:2502.12110) attributes most of its gain to
  one-hop link expansion. Cross-paper numbers are not comparable, which is why section 11
  measures inside Oort's own harness.
- **What hurts, measured.** LLM-built entity graphs cost model calls on every write and lose on
  simple lookups unless dense scores stay in the mix. Mem0's graph variant scored worse on
  single-hop and multi-hop LoCoMo questions and tripled search p95 (arXiv:2504.19413, Tables 1
  and 2); Mem0's open-source code has since replaced the graph store with an entity index that
  needs no model and has a hub penalty. GraphRAG-Bench (arXiv:2506.05690) and "RAG vs. GraphRAG"
  (arXiv:2502.11371) find plain retrieval ahead on fact lookups. Most of what a coding agent asks
  its memory is a fact lookup.
- **The brain's shape, not its parameters.** ACT-R's strength of association `S_ji = S − ln(fan)`
  (ACT-R 7.30+ Reference Manual, "Spreading Activation") says a concept shared by many memories
  should spread almost nothing. Free recall shows a forward bias between neighbouring items,
  about 2:1 (Kahana 1996, doi:10.3758/bf03197276), and order memory is better within an event
  boundary than across one (DuBrow and Davachi 2013, doi:10.1037/a0034024). Complementary
  learning systems theory (McClelland et al. 1995, doi:10.1037/0033-295x.102.3.419) puts
  generalisation in slow offline replay, not at encoding. Each kind below follows one of these.
- **Oort already has half of it.** Every memory carries `entities[]` and `source.sessionId`, and
  nothing reads them as associations. `observe` computes each write's nearest neighbours and then
  discards them. Activation (`activation.ts`) already implements ACT-R base-level decay, which
  `recalledWith` reuses unchanged.

## 2. Goals, non-goals, anti-goals

**Goals.**

- G1. Multi-hop and multi-session questions find memories their words do not reach, without
  hurting single-hop lookups (the bar in section 11).
- G2. Every memory a link brings in explains itself: which kind, from which hit, how strong.
- G3. A person or agent can assert a link, see every link on a memory, and remove a wrong one.
- G4. Forgetting a memory leaves nothing of it in link or index rows.
- G5. The same seam in the local store and Oort Cloud.

**Non-goals.**

- A knowledge graph: entity-relation triples, graph queries, a graph database.
- Multi-hop propagation, PageRank, lateral inhibition. One hop until a second is measured.
- Stored similarity edges. The vector index already answers "what is similar to this".
- Links in the hot-injection path (SessionStart lists hot memories; it does not recall).
- Model-assisted linking experiments (a "same subject?" question in the reconcile batch,
  salience spill to related memories). Possible later, only after section 11's eval.

**Anti-goals.** Each is a failure this design must not cause, with the rule that prevents it.

| Anti-goal | Prevented by |
| --- | --- |
| Noise: links crowd out good hits | Neighbours are judged on the query like any candidate; without a reranker at most 2 are appended, below every hit, after their own relevance floor; hub entities spread nothing (section 5) |
| Slow hooks | No model or embed call; a time box on the gather step that degrades to `links-skipped`; not in the hot-injection path; the ≤ +10 ms p95 bar |
| Per-write model cost | `about`, `episode`, `recalledWith` and `explicit` are code; `derivedFrom` is opt-in, batched, one writer call per new general memory |
| Wrong links that cannot be undone | `oort unlink` removes any pair, and for a learned or index-derived pair leaves a block so it does not come back (section 9) |
| Erasure leaks | `ON DELETE CASCADE` on every link and entity row; links carry no text; derived content follows CON-144 (section 8) |
| Confusing names | Plain kind names in every API; astronomy only in the star map's drawing (section 13) |
| A rich-get-richer loop | A link-admitted memory never strengthens the link that admitted it; `recalledWith` is capped per recall and per memory, and decays |
| Cross-scope leaks | Both ends of a link are in the same node; the store applies the grant to every neighbour |

## 3. The kinds

| Kind | Meaning | Direction | Stored as | Formed by | Decays |
| --- | --- | --- | --- | --- | --- |
| `about` | A and B share a specific entity | undirected | `memory_entities` index, no pair rows | every write that sets `entities` | no; weight falls as the entity gets common |
| `episode` | A and B were written in the same session, a few turns apart | forward-weighted | two indexed columns on `memories`, no pair rows | every write with a `sessionId` | no; weight falls with turn distance, 0 across sessions |
| `recalledWith` | A and B were returned together by a recall | undirected | `memory_links` row with an access log | recall, inside the access record | yes, like activation |
| `supersedes` | B replaced A | directed | the existing columns | `observe` (today) | no |
| `derivedFrom` | general memory D was distilled from A1..An | directed (D to each A) | `memory_links` rows | opt-in batched consolidation | no; provenance |
| `explicit` | a person or agent linked A and B | undirected | `memory_links` row | `oort link`, SDK, MCP | no |

The cross-node contradiction marker stays a `Decision` on the memory, as today. It is a conflict
flag, not an association, and `withConflicts()` in `recall.ts` already handles it.

## 4. Storage: the next schema version

The SQLite store is at schema version 6. This needs one more version. CON-25 may claim version 7
on another branch, so this document says "the next schema version"; whichever lands second takes
the number after the other's, and the two must be coordinated before either merges.

```sql
-- about: one row per (memory, normalised entity). No pair rows.
CREATE TABLE memory_entities (
  node_key    TEXT    NOT NULL,          -- core's nodeKey, as memories_vec uses
  entity_key  TEXT    NOT NULL,          -- normalised (below)
  memory_rid  INTEGER NOT NULL REFERENCES memories(rid) ON DELETE CASCADE,
  PRIMARY KEY (node_key, entity_key, memory_rid)
) WITHOUT ROWID;
CREATE INDEX memory_entities_rid ON memory_entities (memory_rid);

-- episode: two columns on memories.
ALTER TABLE memories ADD COLUMN session_id  TEXT;     -- source.sessionId
ALTER TABLE memories ADD COLUMN episode_seq INTEGER;  -- turn order within (node, session)
CREATE INDEX memories_episode ON memories (session_id, episode_seq);

-- recalledWith, derivedFrom, explicit, and blocks.
CREATE TABLE memory_links (
  kind       TEXT    NOT NULL CHECK (kind IN ('recalledWith', 'derivedFrom', 'explicit', 'blocked')),
  node_key   TEXT    NOT NULL,
  a_rid      INTEGER NOT NULL REFERENCES memories(rid) ON DELETE CASCADE,
  b_rid      INTEGER NOT NULL REFERENCES memories(rid) ON DELETE CASCADE,
  access_log TEXT,                       -- recalledWith only: { count, recent (≤ 8), compactedSum, ... }
  created_by TEXT,                       -- explicit and blocked: the author agent id
  created_at TEXT    NOT NULL,
  PRIMARY KEY (kind, a_rid, b_rid),
  CHECK (a_rid <> b_rid)
) WITHOUT ROWID;
CREATE INDEX memory_links_b ON memory_links (b_rid, kind);
```

- **Undirected kinds are stored once**, with `a_rid < b_rid`. `derivedFrom` keeps `a` = the
  derived memory and `b` = its evidence.
- **Links carry no content.** No text, no entity, no note: ids, a kind, counts and times. Entity
  keys are content, so they live only in `memory_entities` and go with their memory.
  **(my call: no free-text note on an explicit link, so a link can never restate a memory.)**
- **Same node, enforced in code.** SQLite cannot check another row in a `CHECK`, so the store
  rejects a link whose ends have different `node_key`s, and the conformance suite proves it.
- **Entity normalisation (my call):** NFKC, `toLowerCase()` (locale-free), trim, collapse inner
  whitespace; keys shorter than 2 or longer than 128 characters are skipped; at most 16 per
  memory. Every upsert rewrites the memory's `memory_entities` rows (REFINE can change
  entities). A cold memory keeps its row's entities today, so it keeps its index rows.
- **`episode_seq` (my call).** `turnRef` is a free-form string, not an ordinal. On insert the store
  gives a memory the next sequence number in its `(node, session_id)`, or the number of an
  existing memory with the same `turnRef` in that session, so the facts one turn splits into
  (CON-56) share a number. A memory without `sessionId` has neither column and no `episode`
  links. REFINE keeps the number; a SUPERSEDE writes a new memory with its own.
- **Fan is not stored (my call).** Rather than maintain per-entity counters that `forget`,
  expiry and supersede would each have to correct, the gather step counts an entity's current
  memories inside the grant at read time, stopping at `F_max + 1` (section 5). With the primary
  key above that is an index range scan of at most 51 rows per entity. There is nothing to
  recompute on erasure.
- **The upsert must keep `rid`.** The store's upsert is `INSERT … ON CONFLICT (id) DO UPDATE`,
  which keeps the row id. An `INSERT OR REPLACE` would delete the row and cascade every link
  away; a store test pins this.
- **Migration.** Opening a version 6 store creates the tables and columns, fills
  `memory_entities` from each row's `entities` JSON and `session_id` / `episode_seq` from its
  `source` JSON (ordered by `created_at`), in one transaction. Like version 6, it only adds
  data derived from what is stored, so it takes no copy first. `migrate: false` refuses it with
  `StoreMigrationRequiredError`, as the hooks expect. The version 6 writer guard is extended so
  an older Oort cannot write a memory without its index rows.
- **Downgrade.** `downgradeSqliteStore({ to: 6 })` drops the tables and columns, and refuses
  while any `explicit` or `derivedFrom` row exists (they cannot be rebuilt), as version 4 refuses
  while a place exists. `recalledWith` rows are dropped: they are learned again.

## 5. Formation and weights

All weights lie in [0, 1]. Numbers marked "start" are starting points for the eval in
section 11 to tune, not findings.

**`about`.** For a seed with entity `e`, `fan(e)` is the number of current memories inside the
grant (same node) carrying `e`, the seed included. Its weight is
`w(e) = max(0, 1 − ln(fan(e)) / ln(F_max))`, which is ACT-R's `S − ln(fan)` with `S = ln(F_max)`,
scaled to [0, 1]. Start `F_max = 50`: an entity in 50 or more memories ("the repo", the user's
own name) spreads nothing, by arithmetic rather than a stop-list. A neighbour sharing several
entities with the seed gets `1 − Π(1 − w(e))` **(my call: noisy-or, so two specific shared
entities beat one, and the sum stays bounded)**. At most 20 memories per entity.

**`episode`.** Same node, same `session_id`, `|Δseq| ≤ 3` (start). Weight
`exp(−|Δseq| / 3)` for a later neighbour and half that for an earlier one (Kahana's forward
bias); 1 for another fact of the same turn. 0 across sessions: a session is the event boundary.

**`recalledWith`.** Learned inside the existing `recordAccess` transaction, only while
`recall.links` is on:

- From the top 3 memories a recall returns that were **search hits** (not link-admitted) and
  are in the same node, form at most 3 pairs. **(my call: link-admitted memories never form or
  strengthen a pair, so a link cannot feed itself.)**
- Each pair appends the recall's time to its own access log (count, last 8 times, folded sum),
  using `appendAccess()` unchanged. Strength `B = activation(log)` with the same `d = 0.5`;
  weight `sigmoid(B)`, the same squashing fusion's activation boost uses.
- At most 16 pairs per memory: inserting a 17th evicts that memory's weakest.
- Only in nodes the grant can write **(my call: a member's recalls never write association
  rows into a shared Constellation or Galaxy node)**.
- `returned` means what the recall gave back, after `fitForInjection` when a budget is set: the
  same set that gets the access record today.

**`derivedFrom`.** Written only by the distillation step (section 7). At most 20 evidence links
per derived memory (keep the most recent and most confirmed). Weight 1.

**`explicit`.** Written by `link`. Weight 1. Never decays.

**Kind factors** (start): `explicit` 1.0, `derivedFrom` 1.0, `recalledWith` 1.0, `about` 0.6,
`episode` 0.5.

## 6. Decay, tiers and freshness

- **Validity first.** `isVisible()` from `fusion.ts` applies to every neighbour as to a hit. A
  link never brings a superseded, expired or corrected memory into a `current` recall, and in
  `as-of` and `known-at` views the neighbour must be visible at that time.
- **`about` and `episode` do not decay.** Their endpoints decay through their own activation,
  and a superseded or expired memory leaves `fan(e)` when it stops being current.
- **`recalledWith` decays like a memory.** Consolidation deletes a pair whose strength falls
  below `activation.coldBelow` (−2.0) or when either end stops being current. With `d = 0.5` and
  times in hours, a pair used once falls below −2.0 after about 55 hours; used three times, after
  about 20 days. That pruning is intended: one co-recall is weak evidence. The eval may move the
  floor.
- **`derivedFrom` and `explicit` do not decay.** A derived memory has its own activation and
  tier; its evidence may go cold without harm, which is the point of distilling.
- **Tiers.** A link never changes a tier. A neighbour that is returned is treated exactly like a
  returned hit: if cold and current it is hydrated (when the grant writes its node), and it gets
  an access record, so consolidation keeps it warm. A neighbour that was gathered, scored or
  reranked but not returned is not touched.
- **Freshness.** `lastConfirmedAt` and the stale note stay per memory. A link confirms nothing; a
  stale neighbour carries its own "may be outdated" note.

## 7. `derivedFrom`: opt-in distillation

A later slice, off by default (`consolidate.distil: false`), never on the request path.

- **Clusters chosen in code**: strong `recalledWith` hubs, or a specific entity (`w(e) > 0`)
  shared by at least 4 current episodic memories with no derived memory yet.
- **One writer call per new general memory**, given the cluster's texts, asked for one
  standalone semantic fact or nothing. The result goes through the normal store path as a
  `semantic` memory with a `{ stage: 'consolidate', question: 'derived-from', answer: '<n>' }`
  decision and `derivedFrom` rows to its evidence. A cluster is never distilled twice.
- **Billed and bounded**: a cap per run (start: 10 new memories), inside the existing
  consolidation time budget, reported in `ConsolidateResult`.
- **At recall**: an episodic seed pulls its derived memory (the general fact usually answers
  better). In `history` mode and in `explain`, a derived memory lists its evidence.

**Name clash to know about.** `Memory.provenance.derivedFrom` already exists: where a *shared
copy* came from, in another vault (`address.ts`, filled by sharing). The link kind is different:
a distilled memory and its evidence, in the same node. They never appear in the same place
(`provenance` on a memory, `via.kind` and `links[].kind` for links), and the docs say so. See
open question 1.

## 8. Erasure

1. **Cascade in the same transaction.** `forget` deletes the `memories` row; with
   `PRAGMA foreign_keys = ON` (already set by the SQLite store) every `memory_entities` and
   `memory_links` row referencing it goes in the same transaction. Fan counts are read-time, so
   nothing else needs correcting. Conformance test: after `forget(A)`, no entity row, link row,
   block or `fan` count reflects A, and a recall whose seed linked to A returns nothing of A.
2. **Links carry no content**, so a surviving link row cannot leak A (there are none anyway).
3. **Successors and derived memories may restate A.** That is the real risk, and it already
   exists for successors (`B.supersedes = A` with "changed from 3000 to 8080"). CON-144 is
   deciding and building the rule for the successor case now. This design does not redesign it:
   the `derivedFrom` slice applies whatever CON-144 lands to derived memories, with one addition
   that only applies to them: when A was a derived memory's only evidence, the derived memory is
   forgotten too. Until the derived memory is rewritten, it is excluded from recall.
4. **Activation residue is acceptable.** A forgotten memory may have nudged another's activation
   through co-recall. That is a count, not content, and it decays.
5. **Oort Cloud.** Wherever the cloud does not store memory text in plaintext, it must not store
   entity keys in plaintext either; a keyed hash per account serves the equality lookup `about`
   needs.

## 9. Undoing a wrong link

- `oort unlink <a> <b>` (SDK `unlink`, MCP `link` with `remove: true`) deletes an `explicit` or
  `recalledWith` row between the two.
- For a pair formed by an index (`about`, `episode`) or learned (`recalledWith`), it also writes a
  `blocked` row **(my call)**: the gather step skips a blocked pair, and learning never re-forms
  it. A block is a pair row like any other, so it cascades on `forget`. `oort link` on a blocked
  pair removes the block.
- `supersedes` is not unlinked here: the version chain is corrected with the existing commands.
- `derivedFrom` is not unlinked by hand; forgetting the derived memory removes it.

## 10. Recall: one bounded hop

Where it sits in `recall()` today: first stage per node, fusion, rerank of the top `rerankK`
(30), relevance gate over the top `returnK` (10), adaptive stop, conflicts, chains in `history`
mode, `fitForInjection`, hydration and the access record. The hop adds one store call and,
with a reranker, a few more documents in the same rerank call.

**Seeds.** The top `s = 3` (start) memories, per node leg, each with its score normalised to
[0, 1] across the seeds.

**Gather.** One new store call per leg, under that leg's grant:
`store.neighbours(grant, seedIds, { kinds, perSeed, view, spatial })` returns, per neighbour, the
memory (with its embedding when warm), the kind, the seed it came from and the raw weight. The
store applies the grant, the same-node rule, blocks, the per-entity and per-seed caps, and, when
the recall has `within` or `near`, the spatial filter **(my call: a link never brings in a memory
outside the requested place)**. Kinds are gathered in the order `explicit`, `derivedFrom`,
`recalledWith`, `episode`, `about`, and the store stops between kinds once `recall.links.budgetMs`
(start: 8 ms) has passed, reporting `degraded: 'links-skipped'`.

**Score.** `spread(n) = Σ_seeds score(seed) · k_kind · w(seed, n) / fanout(seed)`, where
`fanout(seed)` is how many neighbours that seed contributed (ACT-R's `W_kj`). One hop only.

**Filter.** Drop neighbours already among the candidates, not visible in the view, or withdrawn
judgments unless `includeWithdrawn`.

**Admit.** Two paths, decided by whether a rerank will run.

- **With a rerank (my call on the ordering).** The approved direction is "one hop from the top
  hits after the relevance gate, and neighbours join the rerank pool". With a reranker the gate
  runs on rerank scores, so a gate-then-rerank-again order would need a second rerank round trip
  (often near 400 ms hosted, per the `rerankBudgetMs` note in `config.ts`), which cannot meet the
  latency bar. So the seeds are taken from the fused top before the rerank, the top `m = 5`
  (start) neighbours by spread are added to that same rerank call, and after the rerank a
  neighbour is kept only if it passes the gate itself **and at least one of its seeds passed the
  gate**. The result is the same set as gate-then-hop, with one rerank call. The cross-encoder
  judges each neighbour on the query like any candidate, and places it wherever its score puts
  it.
- **Without a rerank** (no reranker, `speed: 'fast'` and the prompt hook's default `fast` mode,
  a confident skip, or a failed or timed-out rerank): after the gate and the adaptive stop, the
  seeds are the top kept hits, and at most 2 neighbours are appended **after** every hit, never
  above one, each passing its own weak floor: some query-word coverage, or a dense similarity of
  at least `minDenseScore` computed from its stored vector and the query vector already in hand
  (no embed call).

**After admission,** neighbours go through the same steps as hits: the adaptive stop (when it
stops, cold neighbours go too), the conflict rule, the hive quota in `fitForInjection`, hydration
and the access record, all only for what is returned.

**Explain.** Each admitted neighbour gets
`explanation.via = { kind, from: <seed id>, weight: <spread> }`, naming its largest contributor.

**Bounds, all together.** Seeds ≤ 3 per leg; per seed: `explicit` all (capped at 16 by the
writer), `derivedFrom` ≤ 20, `recalledWith` ≤ 8 strongest, `episode` ≤ 6 (±3), `about` ≤ 20 per
entity over ≤ 16 entities; admitted ≤ 5 (rerank) or ≤ 2 (no rerank) per recall; one hop; no model
or embed call; gather time-boxed.

**Latency budget.** The bar is recall p95 up by no more than 10 ms on the 1,500-memory demo store
(`pnpm bench`), links on versus off. The gather is a handful of indexed lookups for at most 3
seeds; with a reranker the pool grows from 30 to at most 35 documents in the same call. SessionStart
does not recall, so hot injection is untouched.

## 11. Eval and the ship bar

The bench harness (`packages/bench`, `eval/format.md`) already reports recall@k, MRR@10,
stale-leak rate and abstention false positives per category. Additions:

- **A `multi-hop` category**: rows whose expected memory shares no useful words or meaning with
  the question but is linked to one that does ("which database does the service whose port
  changed last week use?"). Synthetic rows join the generated fixture as a smoke test; 30 to 50
  hand-labelled rows from real imported transcripts stay outside the repo, under `$OORT_HOME/eval`.
- **`linkPrecision`**: the share of link-admitted memories in the top k that are expected.
- **Latency delta**: `pnpm bench` runs recall p50 / p95 / p99 with links on and off.
- **A warm-up pass**: eval stubs `recordAccess` today so rows do not influence each other. A
  `--warm-up <file>` option runs a disjoint question set first with access recording live on the
  snapshot copy, so `recalledWith` has history. Both cold and warm numbers are reported (cold start
  is the limitation HeLa-Mem and Synapse both report).
- **Ablation grid**: links off; each kind alone; all.
- **LoCoMo and LongMemEval_S, retrieval-level**: adapters that feed a local copy of each dataset
  through `observe` (session date as `at`, the dialogue id as `turnRef`) and score recall@k of the
  evidence turns through `turnRef`. Retrieval metrics avoid the judge and label inconsistencies
  between published LoCoMo numbers. The datasets are not bundled.

**The bar to turn `recall.links` on by default:**

- at least +3 points evidence recall@10 on multi-hop (the Oort set and LoCoMo) and on
  multi-session (LongMemEval);
- no more than 1 point lost on single-hop;
- no rise in stale-leak rate or abstention false positives;
- recall p95 up by no more than 10 ms on the 1,500-memory demo store.

Below the bar, links stay off by default. `explicit`, `supersedes` and `derivedFrom` remain worth
having for explanation alone (open question 2).

## 12. Surfaces

| Surface | Change |
| --- | --- |
| Core | `RecalledMemory.explanation.via?: { kind, from, weight }`; `Degradation` gains `links-skipped`; config `recall.links: { enabled: false, kinds, seeds: 3, admit: 5, appendWithoutRerank: 2, budgetMs: 8, fMax: 50 }` |
| Store seam | optional, like `spatial`: `readonly links?: true`; `neighbours(grant, seedIds, opts)`; `link(grant, a, b, kind)`, `unlink(grant, a, b)`, `linksOf(grant, id)`; `recordAccess(grant, ids, at, opts?: { together?: string[] })`. A store without `links` gets no expansion and refuses `link` |
| SDK (`oortmem`) | `RecalledMemory.why.via` (`@experimental`, as `why` is); `explain(id)` gains `links: { kind, id, weight, direction }[]`, and `hiddenLinks` also counts links to memories outside the handle's projects; `link(a, b)`, `unlink(a, b)` |
| Python | the same through `oort serve` |
| `oort serve` | `POST /v1/links`, `DELETE /v1/links` |
| MCP | `link` (`{ from, to, remove? }`), offered only by a backend that implements links, as the judgment tools are, so the remote connector's set is unchanged until it does; `recall` output carries `via`; `explain` lists links |
| CLI | `oort link <a> <b>`, `oort unlink <a> <b>`; `oort inspect <id>` lists links (kind, other id, weight); `oort explain "<query>"` adds a `via` column (`about ← #2`); `--links` / `--no-links` on `recall` and `explain` for one-off comparison |
| Injection block | a link-admitted line's label gains `linked`: `- [semantic, 2d ago, linked]`. **(my call: the label never names the entity, because labels are built from structured fields only and memory text, entities included, never reaches them)** |
| Export | version 2 gains an optional per-memory `links: [{ kind, id }]` for `explicit` and `derivedFrom` links whose other end is in the same export; import restores them. `recalledWith` is not exported (it is learned again) |
| Usage | `link`, `unlink` and the gather step call no model. Distillation is one writer call per new general memory, opt-in |

## 13. Naming

- **Plain names everywhere a person reads an explanation**: `about`, `episode`, `recalledWith`,
  `supersedes`, `derivedFrom`, `explicit`.
- **The space names are taken.** `address.ts` maps levels to Planet, Star, Orbit, Flyby,
  Constellation and Galaxy. Calling a consolidated memory "a planet" would give one word two
  meanings ("a memory in your Planet" and "a memory that is a planet"); "asteroid" for a passing
  memory overlaps Flyby, and passing quickly is a tier (cold), not a kind. Levels say whose a
  memory is, tiers say how warm it is, links say how memories relate; a fourth astronomical axis
  would make "is my Planet a planet?" a real support question.
- **The star map may draw it.** A `derivedFrom` memory as a larger body with the memories it came
  from as moons around it; `recalledWith` as faint lines whose brightness is strength; `episode`
  as a short dotted trail, like the supersede trail. These are drawings, not names: no API, doc
  heading or explanation says "moon".

## 14. Cloud parity

The cloud store implements the same seam later, behind the same capability flag:

1. `linksConformance(name, make)` in `@oortmem/core/store-conformance` proves a store: the same
   node rule, the grant on every neighbour, caps, blocks, the cascade on `forget`, `recalledWith`
   decay and pruning, and an upsert that keeps links.
2. Until the cloud store passes it, cloud mode answers `link` and `unlink` with `refused` /
   `local-only` (as spatial options are), and `why.via` never appears.
3. Contract cases (`contract/sdk/cases/links.json`) run on the `local` transport first and add
   `cloud` when it lands, so both transports pass one set of cases.
4. The cloud gives the same cascade guarantee as `ON DELETE CASCADE`, by whatever its database
   offers, in the same transaction or batch as the delete.

## 15. Slices

Thin vertical slices, each independently testable. Docs ship with each (repo docs, and site docs
with tested examples where the slice is user-facing).

| # | Slice | Issue | Depends on |
| --- | --- | --- | --- |
| 1 | Eval: `multi-hop` category, `linkPrecision`, links on/off latency, warm-up pass, ablation flags | CON-146 | none |
| 2 | Eval: LoCoMo and LongMemEval_S retrieval-level adapters, baseline recorded | CON-147 | none |
| 3 | Schema and explicit links end to end: the next schema version, `link` / `unlink`, `inspect` lists links, `forget` cascades, export round-trip | CON-148 | none (coordinate the version number with CON-25) |
| 4 | One-hop recall behind `recall.links` with `explicit`, `about` and `episode`; `via` on every surface | CON-149 | 3 |
| 5 | `recalledWith`: learning in the access record, decay, pruning, caps, blocks | CON-150 | 4 |
| 6 | Run the eval and decide the default | CON-151 | 1, 2, 4, 5 |
| 7 | `derivedFrom`: opt-in distillation, recall and erasure of derived memories | CON-152 | 3, CON-144 |
| 8 | Cloud parity: the seam in Oort Cloud, conformance, `cloud` contract cases | CON-153 | 3, 4, 5 |
| 9 | Star map draws links | CON-154 | 7, 8 |

Slices 1, 2 and 3 can run in parallel. The flag stays off through slice 5; slice 6 is the only one
that can change a default.

## 16. Left to the builder

- Exact SQL of the gather queries, and whether `neighbours` returns memories or ids plus a batched
  read, as long as it is one store call per leg.
- How the store measures `budgetMs` between kinds.
- The `access_log` JSON shape for pairs, as long as `appendAccess()` and `activation()` are reused
  unchanged.
- Where the `blocked` check runs (in the gather SQL or after).
- The exact distillation prompt and cluster tie-breaks, within section 7's caps.
- Every number marked "start", once the eval has run.

## 17. Open questions

1. **`derivedFrom` twice.** Keep the approved link name and document the difference from
   `provenance.derivedFrom` (section 7), or rename the link kind (for example `distilledFrom`)
   before anything ships? This design keeps the approved name.
2. **Explicit links by default.** If the bar is not met, should expansion over `explicit` links
   alone (a person asked for them) be on by default anyway?
3. **The prompt hook.** Should links run in the prompt hook's `fast` mode at all before the bar
   is met on hook-shaped queries, or only in `oort recall`, MCP and the SDK?
