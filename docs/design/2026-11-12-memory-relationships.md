# Memory relationships: typed, cheap, explained links between memories

Date: 2026-11-12. Status: proposed design, docs only; nothing here is built. Epic: CON-145
(slices CON-146 to CON-155). Related: CON-144 (forgetting a memory also removes its value from
its successor, in progress on another branch), CON-25 (schema version 7).

Oort memories are separate records today. The only typed relationship is the version chain
(`supersedes` / `supersededBy`), plus a cross-node contradiction marker. A person's memory
works differently: things come back because they are associated with what came back first.
This design adds a small association layer: a few kinds of link, each formed by a cheap rule
with no model call on the write path. Recall follows them one bounded hop from its best hits,
every memory a link brings in says which link and which hit brought it, and forgetting a memory
removes its links in the same transaction.

It is an association layer, not a knowledge graph. There is no entity-relation extraction, no
triple store, no graph database and no multi-hop traversal.

Calls marked **(my call)** are choices this design makes beyond the approved direction and the
decisions in section 0. Each can be overruled on its own without changing the rest.

## 0. Decisions (2026-11-12)

Decided on the design review, recorded on CON-145. These replace the open questions of the first
draft.

1. **The link kind is `distilledFrom`.** `Memory.provenance.derivedFrom` already means "where a
   shared copy came from, in another vault", and export version 2 writes `provenance` and the
   new `links` field on the same line (`export-format.ts`), so the link kind needs its own name.
2. **Explicit links a person wrote are followed by default; everything else waits for the
   eval.** Recall follows an `explicit` link without `recall.links` only when a person wrote it
   with `oort link` (stored `assertedBy: 'user'`), and only on a recall that reranks (`oort
   recall`, the MCP `recall` tool, the SDK at `speed: 'full'`, and the prompt hook in `full`
   mode). Links an agent wrote (MCP `link`, the SDK) are stored and shown by `inspect` and
   `explain`, but recall follows them only when `recall.links` is on. The automatic kinds
   (`about`, `episode`, `recalledWith`) and `distilledFrom` stay behind `recall.links` until the
   bar in section 11 is met. Every followed link keeps the same hop limits, scope rules and place
   filters.
3. **No links of any kind in the prompt hook's `fast` or `lexical` modes** until a separate
   no-rerank bar on hook-shaped queries is met (section 11). `fast` is the hook's default
   (`recall.promptMode`), so by default the hook is unchanged. Turning links on there is a
   follow-up (CON-155).
4. **No links at level `hive` in v1.** No link row of any kind is written in a Constellation or
   Galaxy node, and recall takes no hop inside one.
5. **Schema version 8, after CON-25's version 7** (PR #107), unless the merge order changes.

In brief, the rest of the design:

- **Six plain kinds.** `about` (two memories share a specific entity), `episode` (written in the
  same session a few turns apart), `recalledWith` (returned together by a recall), `supersedes`
  (exists today), `distilledFrom` (a general memory and the specific memories it was distilled
  from) and `explicit` (a person or agent said so).
- **Two of them are indexes, not rows.** `about` and `episode` come from each memory's own
  fields, so storage stays linear. Only `recalledWith`, `distilledFrom` and `explicit` write pair
  rows, and each is capped.
- **No model call on the write path.** `distilledFrom` is written only by an opt-in, batched
  consolidation step, one writer call per new general memory, never per link.
- **One bounded hop.** Seeds are the top 3 hits; at most 5 neighbours join the rerank call and
  at most 2 are kept. Each carries `explanation.via`. Links never cross a scope node.
- **Links never decide truth or warmth.** Validity applies to a neighbour exactly as to a hit; a
  cold neighbour warms only if it is returned.
- **Erasure is structural.** Link and entity rows cascade with their memory; a `distilledFrom`
  memory whose evidence is forgotten is handled in the same transaction (section 8).

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
- G3. A person can assert a link, see every link on a memory, and remove a wrong one.
- G4. Forgetting a memory leaves nothing of it in link or index rows, and nothing distilled from
  it alone.
- G5. The same seam in the local store and Oort Cloud.

**Non-goals.**

- A knowledge graph: entity-relation triples, graph queries, a graph database.
- Multi-hop propagation, PageRank, lateral inhibition. One hop until a second is measured.
- Stored similarity edges. The vector index already answers "what is similar to this".
- Links in the hot-injection path (SessionStart lists hot memories; it does not recall), or in
  the prompt hook's `fast` and `lexical` modes (decision 3).
- Links in Constellations and Galaxies (decision 4).
- Model-assisted linking experiments (a "same subject?" question in the reconcile batch,
  salience spill to related memories). Possible later, only after section 11's eval.

**Anti-goals.** Each is a failure this design must not cause, with the rule that prevents it.

| Anti-goal | Prevented by |
| --- | --- |
| Noise: links crowd out good hits | Neighbours are judged on the query like any candidate and capped separately from hits; on a path without a rerank a neighbour must pass the same gate as a direct hit; hub entities spread nothing (sections 5, 10) |
| Prompt injection through links | An injected agent cannot get its links followed by default: agent links wait for `recall.links`, `link` needs the write grant on both ends, MCP `link` asks the host first, no links in shared hive nodes, no links in the hook's `fast` mode (decisions 2 to 4, section 9) |
| Slow hooks | No model or embed call; the hook's default `fast` mode takes no hop; a per-entity time box that degrades to `links-skipped`; bounded index scans; the p95 bar at 100k and 1M memories |
| Per-write model cost | `about`, `episode`, `recalledWith` and `explicit` are code; `distilledFrom` is opt-in, batched, one writer call per new general memory, and only the home config can turn it on |
| Wrong links that cannot be undone | `oort unlink` removes any pair, and for a learned or index-derived pair leaves a block so it does not come back (section 9) |
| Erasure leaks | `ON DELETE CASCADE` on every link and entity row; links carry no text; distilled memories handled inside `forget`'s transaction; successors follow CON-144 (section 8) |
| Confusing names | Plain kind names in every API; `distilledFrom`, not `derivedFrom`; astronomy only in the star map's drawing (section 13) |
| A rich-get-richer loop | A link-admitted memory never strengthens the link that admitted it; `recalledWith` is capped per recall and per memory, and decays |
| Cross-scope leaks | Both ends of a link are in the same node; the store applies the grant to every neighbour and to every link it lists |

## 3. The kinds

| Kind | Meaning | Direction | Stored as | Formed by | Decays |
| --- | --- | --- | --- | --- | --- |
| `about` | A and B share a specific entity | undirected | `memory_entities` index over current memories, no pair rows | every write that sets `entities` | no; weight falls as the entity gets common |
| `episode` | A and B were written in the same session, a few turns apart | forward-weighted | two indexed columns on `memories`, no pair rows | every write with a `sessionId` | no; weight falls with turn distance, 0 across sessions |
| `recalledWith` | A and B were returned together by a recall | undirected | `memory_links` row with an access log | recall, inside the access record | yes, like activation |
| `supersedes` | B replaced A | directed | the existing columns | `observe` (today) | no |
| `distilledFrom` | general memory D was distilled from A1..An | directed (D to each A) | `memory_links` rows | opt-in batched consolidation | no; provenance |
| `explicit` | a person or agent linked A and B | undirected | `memory_links` row, with who asserted it | `oort link` (a person), SDK and MCP (an agent) | no |

The cross-node contradiction marker stays a `Decision` on the memory, as today. It is a conflict
flag, not an association, and `withConflicts()` in `recall.ts` already handles it.

## 4. Storage: schema version 8

The SQLite store is at schema version 6, and CON-25 (PR #107) takes version 7. This design takes
version 8, after CON-25's version 7, unless the merge order changes; the two must not merge with
the same number.

```sql
-- Nodes as small integers, so link and entity rows do not repeat a JSON node key.
CREATE TABLE nodes (
  node_id  INTEGER PRIMARY KEY,
  node_key TEXT    NOT NULL UNIQUE           -- core's nodeKey
);

-- about: one row per (current memory, normalised entity). No pair rows.
CREATE TABLE memory_entities (
  node_id     INTEGER NOT NULL REFERENCES nodes(node_id),
  entity_key  TEXT    NOT NULL,              -- normalised (below)
  memory_rid  INTEGER NOT NULL REFERENCES memories(rid) ON DELETE CASCADE,
  PRIMARY KEY (node_id, entity_key, memory_rid)
) WITHOUT ROWID;
CREATE INDEX memory_entities_rid ON memory_entities (memory_rid);

-- episode: two columns on memories.
ALTER TABLE memories ADD COLUMN session_id  TEXT;      -- source.sessionId
ALTER TABLE memories ADD COLUMN episode_seq INTEGER;   -- turn order within (node, session)
CREATE INDEX memories_episode ON memories (session_id, episode_seq);

-- recalledWith, distilledFrom, explicit, and blocks.
CREATE TABLE memory_links (
  kind        TEXT    NOT NULL CHECK (kind IN ('recalledWith', 'distilledFrom', 'explicit', 'blocked')),
  node_id     INTEGER NOT NULL REFERENCES nodes(node_id),
  a_rid       INTEGER NOT NULL REFERENCES memories(rid) ON DELETE CASCADE,
  b_rid       INTEGER NOT NULL REFERENCES memories(rid) ON DELETE CASCADE,
  access_log  TEXT,                          -- recalledWith only: { count, recent (≤ 8), compactedSum, ... }
  asserted_by TEXT CHECK (asserted_by IN ('user', 'agent')),  -- explicit and blocked only
  agent_id    TEXT,                          -- explicit and blocked: the principal agent
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (kind, a_rid, b_rid),
  CHECK (a_rid <> b_rid)
) WITHOUT ROWID;
CREATE INDEX memory_links_b ON memory_links (b_rid, kind);
```

- **Undirected kinds are stored once**, with `a_rid < b_rid`. `distilledFrom` keeps `a` = the
  distilled memory and `b` = its evidence.
- **Links carry no content.** No text, no entity, no note: ids, a kind, counts, who and when.
  Entity keys are content, so they live only in `memory_entities` and go with their memory.
  **(my call: no free-text note on an explicit link, so a link can never restate a memory.)**
- **Same node, never `hive`, enforced in code.** SQLite cannot check another row in a `CHECK`, so
  the store rejects a link whose ends are in different nodes, or in a `hive` node, and the
  conformance suite proves both.
- **Entity normalisation (my call):** NFKC, `toLowerCase()` (locale-free), trim, collapse inner
  whitespace; keys shorter than 2 or longer than 128 characters are skipped; at most 16 per
  memory. Every upsert rewrites the memory's `memory_entities` rows (REFINE can change
  entities).
- **The entity index holds current memories only.** A memory's entity rows are deleted when it
  stops being current: in the same `upsertMany` that sets `expiredAt` on a superseded or
  corrected memory, and in `expireMany`. So an entity's row count is its fan (up to the grant and
  project filter), and a superseded memory's entities never inflate an entity's fan.
  `about` therefore links current memories only, in every temporal view. A cold memory that is
  still current keeps its rows.
- **`episode_seq` (my call).** `turnRef` is a free-form string, not an ordinal. On insert the store
  gives a memory the next sequence number in its `(node, session_id)`, or the number of an
  existing memory with the same `turnRef` in that session, so the facts one turn splits into
  (CON-56) share a number. A memory without `sessionId` has neither column and no `episode`
  links. REFINE keeps the number; a SUPERSEDE writes a new memory with its own.
- **Fan is not stored (my call).** It is counted at read time from the bounded scan in section
  5, so there is no counter for `forget`, expiry or supersede to correct.
- **The upsert must keep `rid`.** The store's upsert is `INSERT … ON CONFLICT (id) DO UPDATE`,
  which keeps the row id. An `INSERT OR REPLACE` would delete the row and cascade every link
  away; a store test pins this.
- **Migration.** Opening a version 7 store creates the tables and columns, fills `nodes`, fills
  `memory_entities` from each current row's `entities` JSON and `session_id` / `episode_seq`
  from its `source` JSON (ordered by `created_at`), in one transaction. It only adds data derived
  from what is stored, so, like version 6, it takes no copy first. `migrate: false` refuses it
  with `StoreMigrationRequiredError`, as the hooks expect.
- **The writer guard is renamed, not extended.** Version 8 recreates the guard triggers to call a
  new function, `oort_writer_v8`, and stops defining `oort_writer_v6`. An Oort that predates
  version 8 (an MCP server or daemon started before the upgrade) then fails on its next write,
  changing nothing, instead of writing a memory without its index rows.
- **A later migration that rebuilds `memories` would erase every link.** Rebuilding a table
  (create, copy, drop, rename) deletes the old rows, and with foreign keys on, that cascades
  through `memory_entities` and `memory_links`. `PRAGMA foreign_keys` cannot be changed inside
  the transaction `applySchema` runs in. Any such migration must copy both tables aside in the same
  transaction, keep every `rid` across the rebuild, and restore them, with a migration test that
  link and entity counts are unchanged. `ALTER TABLE … ADD COLUMN` rebuilds nothing and is safe.
- **Downgrade.** `downgradeSqliteStore({ to: 7 })` drops the tables and columns, and refuses while
  any `explicit`, `distilledFrom` or `blocked` row exists: none of them can be rebuilt, and dropping
  a block would silently bring back a pair a person removed **(my call: refuse rather than
  document the loss)**. `recalledWith` rows are dropped: they are learned again.

## 5. Formation and weights

All weights lie in [0, 1]. Numbers marked "start" are starting points for the eval in
section 11 to tune, not findings.

**`about`.** For a seed with entity `e`:

1. **Bounded raw scan.** Read at most `4 × F_max + 1` rows of `memory_entities` for
   `(node_id, e)`, newest `memory_rid` first. More than `4 × F_max` rows means a hub: weight 0,
   nothing more is read for `e`. Start `F_max = 50`, so the scan is at most 201 index rows.
2. **Fan inside the grant.** Of those rows, `fan(e)` counts the memories the grant reads (project
   and author filter). The index already holds current memories only.
3. **Weight.** `w(e) = max(0, 1 − ln(fan(e)) / ln(F_max))`: ACT-R's `S − ln(fan)` with
   `S = ln(F_max)`, scaled to [0, 1]. An entity in 50 or more readable memories ("the repo", the
   user's own name) spreads nothing, by arithmetic rather than a stop-list.
4. **Neighbours.** At most 20 per entity, newest `memory_rid` first. A neighbour sharing several
   entities with the seed gets `1 − Π(1 − w(e))` **(my call: noisy-or, so two specific shared
   entities beat one, and the result stays bounded)**.

**`episode`.** Same node, same `session_id`, `|Δseq| ≤ 3` (start). Weight
`exp(−|Δseq| / 3)` for a later neighbour and half that for an earlier one (Kahana's forward
bias); 1 for another fact of the same turn. 0 across sessions: a session is the event boundary.

**`recalledWith`.** Learned inside the existing `recordAccess` transaction, only while
`recall.links` is on:

- From the top 3 memories a recall returns that were **search hits** (not link-admitted) and
  are in the same node, form at most 3 pairs. **(my call: link-admitted memories never form or
  strengthen a pair, so a link cannot feed itself.)**
- Each pair appends the recall's time to its own access log (count, last 8 times, folded sum),
  using `appendAccess()` unchanged. Strength `B = activation(log, 0, now, params)`: salience 0,
  because `activation()` adds `ws · salience` and a pair has no salience of its own. Weight
  `sigmoid(B)`, the squashing fusion's activation boost uses.
- At most 16 pairs per memory: inserting a 17th evicts that memory's weakest.
- Never at level `hive` (decision 4).
- `returned` means what the recall gave back, after `fitForInjection` when a budget is set: the
  same set that gets the access record today.

**`distilledFrom`.** Written only by the distillation step (section 7). At most 20 evidence
links per distilled memory (keep the most recent and most confirmed). Weight 1.

**`explicit`.** Written by `link`, with `assertedBy` (section 9). Weight 1. Never decays.

**Kind factors** (start): `explicit` 1.0, `distilledFrom` 1.0, `recalledWith` 1.0, `about` 0.6,
`episode` 0.5.

## 6. Decay, tiers and freshness

- **Validity first.** `isVisible()` from `fusion.ts` applies to every neighbour as to a hit. A
  link never brings a superseded, expired or corrected memory into a `current` recall, and in
  `as-of` and `known-at` views the neighbour must be visible at that time.
- **`about` and `episode` do not decay.** Their endpoints decay through their own activation,
  and a memory leaves the entity index when it stops being current.
- **`recalledWith` decays like a memory.** Consolidation deletes a pair whose strength falls
  below `activation.coldBelow` (−2.0) or when either end stops being current. With `d = 0.5` and
  times in hours, a pair used once falls below −2.0 after about 55 hours; used three times, after
  about 20 days. That pruning is intended: one co-recall is weak evidence. The eval may move the
  floor.
- **`distilledFrom` and `explicit` do not decay.** A distilled memory has its own activation and
  tier; its evidence may go cold without harm, which is the point of distilling.
- **Tiers.** A link never changes a tier. A neighbour that is returned is treated exactly like a
  returned hit: if cold and current it is hydrated (when the grant writes its node), and it gets
  an access record, so consolidation keeps it warm. A neighbour that was gathered, scored or
  reranked but not returned is not touched.
- **Freshness.** `lastConfirmedAt` and the stale note stay per memory. A link confirms nothing; a
  stale neighbour carries its own "may be outdated" note.

## 7. `distilledFrom`: opt-in distillation

A later slice, off by default (`consolidate.distil: false`), never on the request path.

- **Home config only.** `consolidate.distil` turns on billed model calls, so it joins
  `HOME_ONLY_SUBKEYS` in `config.ts`, as `recall.adaptiveStop` did: a project's config file
  cannot turn it on.
- **Clusters chosen in code**: strong `recalledWith` hubs, or a specific entity (`w(e) > 0`)
  shared by at least 4 current episodic memories with no distilled memory yet. Evidence is never
  itself a distilled memory, so distillation does not chain.
- **One writer call per new general memory**, given the cluster's texts, asked for one
  standalone semantic fact or nothing. The result goes through the normal store path as a
  `semantic` memory with a `{ stage: 'consolidate', question: 'distilled-from', answer: '<n>' }`
  decision and `distilledFrom` rows to its evidence. A cluster is never distilled twice.
- **Billed and bounded**: a cap per run (start: 10 new memories), inside the existing
  consolidation time budget, reported in `ConsolidateResult` and in the SDK's usage table.
- **At recall** (behind `recall.links`): an episodic seed can bring in its distilled memory (the
  general fact usually answers better). In `history` mode and in `explain`, a distilled memory
  lists its evidence.

`provenance.derivedFrom` is a different thing: the source of a shared copy in another vault,
never a memory in the same node.

## 8. Erasure

1. **Cascade in the same transaction.** `forget` deletes the `memories` row; with
   `PRAGMA foreign_keys = ON` (already set by the SQLite store) every `memory_entities` and
   `memory_links` row referencing it goes in the same transaction. Fan is counted at read time,
   so nothing else needs correcting. Conformance test: after `forget(A)`, no entity, link or block
   row reflects A, and a recall whose seed linked to A returns nothing of A.
2. **Distilled memories, before the cascade.** The cascade deletes exactly the rows that say
   which memories were distilled from A, so `forget` reads them first. Inside `forgetTx`, before
   deleting A, the store reads A's incoming `distilledFrom` rows. For each distilled memory D:
   if A is D's only evidence, D is forgotten in the same transaction (with its own cascade);
   otherwise D is marked for rewrite in the same transaction and excluded from recall until the
   next consolidation rewrites it from the remaining evidence. The marker is the one CON-144 lands
   for successors; if CON-144 settles on forgetting rather than marking, distilled memories follow
   that. A contract case and a conformance case prove it, including that a crash between the two
   steps is impossible (one transaction).
3. **Successors.** A successor's text may restate a forgotten predecessor ("changed from 3000 to
   8080"). CON-144 is deciding and building that rule now; this design does not redesign it.
4. **Links carry no content**, so no surviving row can leak A (and there are none).
5. **Activation residue is acceptable.** A forgotten memory may have nudged another's activation
   through co-recall. That is a count, not content, and it decays.
6. **Oort Cloud.** Wherever the cloud does not store memory text in plaintext, it must not store
   entity keys in plaintext either. A hash keyed per vault owner serves the equality lookup
   `about` needs, so equal entities in two owners' vaults do not hash alike.

## 9. Asserting and undoing links

**Who may link.**

- `link(a, b)` needs the **write** grant on both memories, and both in one node that is not at
  level `hive`. Otherwise it is refused exactly as a missing id is.
- **`assertedBy: 'user'`** only from `oort link` confirmed at a terminal: stdin and stdout are
  both a terminal, and the answer is read from the controlling terminal, never from stdin.
  Without that, `oort link` records `agent`. **`user` means "confirmed at a terminal". It is not
  proof that a person did it:** an agent with a shell can drive a pseudo-terminal, and nothing
  here stops a determined one. So nothing may give a `user` link more access than an `agent`
  link: a link never lets a reader reach a memory its grant does not read, whoever asserted it.
  What `user` does is limited to ranking (decision 2) and to this: an `agent` call cannot remove
  or weaken a `user` link (`unlink` as `agent` is refused with `asserted-by-user`).
- **`assertedBy: 'agent'`** from MCP `link`, the SDK and `oort serve` **(my call: the SDK is
  often called with ids an agent chose)**. MCP `link` is annotated `destructiveHint: true`, as
  `record_judgment` is, so hosts ask the person before it runs.
- Imported links come in as `agent` **(my call: a file cannot claim a person's assertion)**.

**Undoing.**

- `oort unlink <a> <b>` (SDK `unlink`, MCP `link` with `remove: true`) deletes an `explicit` or
  `recalledWith` row between the two.
- For a pair formed by an index (`about`, `episode`) or learned (`recalledWith`), it also writes a
  `blocked` row **(my call)**: the gather step skips a blocked pair, and learning never re-forms
  it. A block cascades on `forget`. `oort link` on a blocked pair removes the block.
- `supersedes` is not unlinked here: the version chain is corrected with the existing commands.
- `distilledFrom` is not unlinked by hand; forgetting the distilled memory removes it.

**Listing.** `inspect`, SDK `explain(id)` and the store's `linksOf` list only links whose other
end the reader's grant can read. `hiddenLinks` counts stored link rows (`explicit`,
`recalledWith`, `distilledFrom`) whose other end the reader cannot read; index-derived `about` and
`episode` neighbours are not counted.

## 10. Recall: one bounded hop

Where it sits in `recall()` today: first stage per node, fusion, rerank of the top `rerankK`
(30) asking for `returnK` (10) results, the relevance gate over the top `returnK`, adaptive stop,
conflicts, chains in `history` mode, `fitForInjection`, hydration and the access record.

**When the hop runs.**

| Recall | Rerank runs | Follows |
| --- | --- | --- |
| `oort recall`, MCP `recall`, SDK `speed: 'full'`, prompt hook `full` | yes | `explicit` by a person always; agent `explicit`, `about`, `episode`, `recalledWith`, `distilledFrom` only with `recall.links` |
| any of those when the rerank is skipped (confident), fails, times out or returns nothing | no | only with `recall.links`, on the no-rerank path |
| SDK `speed: 'fast'`, no reranker configured | no | only with `recall.links`, on the no-rerank path |
| prompt hook `fast` or `lexical` mode, SDK `speed: 'lexical'` | no | nothing (decision 3 for the hook; `lexical` reads no vectors) |
| SessionStart | no recall | nothing |
| any node at level `hive` | | nothing (decision 4) |

**Seeds.** The top `s = 3` (start) memories per node leg.

**Gather.** One store call per leg, under that leg's grant:
`store.neighbours(grant, seedIds, { kinds, assertedBy, view, spatial, budgetMs })` returns
**ids only**: per neighbour, its id, the kind, the seed it came from and the raw weight. The store
applies the grant, the same-node rule, blocks, the current-only check in `current` mode, and, when
the recall has `within` or `near`, the spatial filter **(my call: a link never brings in a memory
outside the requested place)**. Kinds are gathered in the order `explicit`, `distilledFrom`,
`recalledWith`, `episode`, `about`. The budget (`recall.links.budgetMs`, start 8 ms) is checked
before each kind and before each entity's scan; once it has passed, the store returns what it has
and recall reports `degraded: 'links-skipped'`.

**Score.** On ids, before any memory or vector is loaded:
`spread(n) = Σ_seeds score(seed) · k_kind · w(seed, n) / fanout(seed)`, where `fanout(seed)` is
how many neighbours that seed contributed **after** the grant filter (ACT-R's `W_kj`), and
`score(seed)` is the seed's fused score normalised to [0, 1] across the seeds. One hop only.
Neighbours already among the candidates are dropped. Only the top `pool = 5` (start) by spread are
loaded (one `get` each, as fusion reads its hits), then checked with `isVisible` and, for judgments,
`includeWithdrawn`.

**With a rerank.** The seeds are the top fused candidates, chosen before the rerank so the
neighbours can join the same call. The rerank is asked for `returnK + pool` results over the
`rerankK` candidates plus the loaded neighbours. Hits and neighbours are then cut separately:

- hits: the top `returnK` hits by rerank order, then the gate, exactly as today;
- neighbours: at most `admit = 2` (start), each passing the rerank gate (`minRerankScore`) and
  with at least one of its seeds passing it too; merged into the hits by rerank score.

So neighbours never take a hit's place, and the result holds at most `returnK + 2` memories. This
is not the same set as "gate, then hop, then rerank again": seeds that failed the gate may have
contributed neighbours, which are then dropped. A second rerank round trip (often near 400 ms
hosted, per the `rerankBudgetMs` note in `config.ts`) cannot meet the latency bar, so this is the
trade. **(my call.)** If the rerank fails, times out or returns nothing, the neighbours are
stripped, the fused order stands as today, and the no-rerank path below runs only if
`recall.links` is on.

**Without a rerank** (only with `recall.links` on): after the gate, the seeds are the top kept
hits. At most `admit = 2` neighbours are appended **after** every kept hit, never above one, and
each must pass **the same gate as a direct hit**: query-word coverage of at least `minCoverage`
(0.5), or a dense similarity of at least `minDenseScore`, computed from its stored vector and the
query vector already in hand (no embed call). Then the adaptive stop runs over hits and neighbours
together, as it runs over hits today (when it stops, cold neighbours go too).

**After admission,** neighbours go through the same steps as hits: the conflict rule, the hive
quota in `fitForInjection`, hydration and the access record, all only for what is returned.

**Explain.** Each admitted neighbour gets
`explanation.via = { kind, from: <seed id>, weight: <spread> }`, naming its largest contributor;
`weight` is computed after the grant filter, so it reflects nothing the reader cannot read.

**Bounds, all together.** Seeds ≤ 3 per leg; per seed: `explicit` ≤ 16, `distilledFrom` ≤ 20,
`recalledWith` ≤ 8 strongest, `episode` ≤ 6 (±3), `about` ≤ 201 index rows scanned and ≤ 20
neighbours per entity over ≤ 16 entities; loaded ≤ 5; kept ≤ 2 per recall; one hop; no model or
embed call; the budget checked per kind and per entity.

**Latency.** The bar is in section 11: recall p95 up by no more than 10 ms at 100k and 1M
memories, with the gather step's own p99 reported. SessionStart does not recall, and the prompt
hook's default `fast` mode takes no hop.

**As built (CON-149).** Where the build differs from the text above, the build stands:

- **This slice follows `explicit`, `episode` and `about`.** `recalledWith` (CON-150) and
  `distilledFrom` (CON-152) join the gather step with their own slices; `recall.links.factors`
  holds a factor only for a kind recall follows.
- **The hub cutoff counts readable rows only.** Section 5 called an entity a hub when more than
  `4 × F_max` index rows were scanned, readable or not. A reader could then see a neighbour
  appear or vanish with rows outside its grant. An entity is a hub when `F_max` or more of the
  memories the reader can read carry it, and every cap (16 explicit links, 6 episode neighbours,
  20 per entity) takes readable rows only.
- **A separate work bound, and one accepted leak.** So that a narrow grant over a very common
  entity cannot make recall scan without limit, a read is not made when it would touch more than
  `64 × F_max` index rows of one entity in one node (or 512 explicit links, or 512 memories in
  the turns around a seed). That entity is skipped for the recall, which reports `links-skipped`;
  nothing is returned from a cut-off read. A reader who already holds an entity can therefore
  learn that its node has more rows of it than the bound. This is accepted: any work bound that
  does not depend on the grant reveals its own threshold, and this one sits far above the hub
  cutoff.
- **Agent links cannot suppress a person's.** Explicit links asserted by `user` and by `agent`
  are read, capped and bounded apart, a person's first.
- **Indexes lead with the node.** `memories_episode` is `(node columns, session_id, episode_seq)`
  rather than section 4's `(session_id, episode_seq)`: a session id comes from the writer, so
  another node could otherwise make this reader's episode read slow. The link indexes hold who
  asserted each link. Tests hold every read to its query plan; `budgetMs` is checked between
  reads, so the plans are what bound one read.
- **Hits first.** The adaptive stop is asked about hits only, and under an injection budget hits
  are fitted before linked memories.
- **A linked memory needs a returned seed.** It is admitted only while a memory it was reached
  from is itself returned (after the gate, the adaptive stop and the injection budget), and
  `via.from` names that memory.
- **`recall.userLinks` is home-only too**, so a repository cannot undo a person turning it off.
- **`oort explain` shows the `via` column only when a link brought something in.**

## 11. Eval and the ship bars

The bench harness (`packages/bench`, `eval/format.md`) already reports recall@k, MRR@10,
stale-leak rate and abstention false positives per category. Additions:

- **A `multi-hop` category**: rows whose expected memory shares no useful words or meaning with
  the question but is linked to one that does ("which database does the service whose port
  changed last week use?"). Synthetic rows join the generated fixture as a smoke test; 30 to 50
  hand-labelled rows from real imported transcripts stay outside the repo, under `$OORT_HOME/eval`.
- **`linkPrecision`**: the share of link-admitted memories in the top k that are expected.
- **Link-shaped latency stores.** `pnpm bench` seeds 10k memories by default, without sessions,
  and runs on a `frozen()` store whose access record is stubbed, so it would measure a gather
  step with nothing to gather. The generator gains sessions (turns in order), Zipf-distributed
  entities (a few hubs, a long tail) and a warm-up that learns `recalledWith` pairs before the
  store is frozen, at 100k and 1M memories. The report gives recall p50 / p95 / p99 with links on
  and off, and the gather step's own p50 / p99.
- **A warm-up pass for quality**: eval stubs `recordAccess` today so rows do not influence each
  other. A `--warm-up <file>` option runs a disjoint question set first with access recording
  live on the snapshot copy, so `recalledWith` has history. Both cold and warm numbers are
  reported (cold start is the limitation HeLa-Mem and Synapse both report).
- **Ablation grid**: links off; user `explicit` only; each other kind alone; all.
- **LoCoMo and LongMemEval_S, retrieval-level**: adapters that feed a local copy of each dataset
  through `observe` (session date as `at`, the dialogue id as `turnRef`) and score recall@k of the
  evidence turns through `turnRef`. Retrieval metrics avoid the judge and label inconsistencies
  between published LoCoMo numbers. The datasets are not bundled.
- **Hook-shaped queries**: a set of real prompt-hook queries (short, conversational) from imported
  transcripts, run at `speed: 'fast'`, for the no-rerank bar.

**The bar to turn `recall.links` on by default** (rerank paths):

- at least +3 points evidence recall@10 on multi-hop (the Oort set and LoCoMo) and on
  multi-session (LongMemEval);
- no more than 1 point lost on single-hop;
- no rise in stale-leak rate or abstention false positives;
- recall p95 up by no more than 10 ms at 100k and at 1M memories.

**The no-rerank bar** (before links run in the prompt hook's `fast` mode, CON-155): the same four
lines, measured at `speed: 'fast'` on the hook-shaped queries.

Explicit links a person wrote are followed on rerank paths whatever these bars say (decision 2).
Below a bar, the kinds it covers stay off by default and the result is recorded in this document.

## 12. Surfaces

| Surface | Change |
| --- | --- |
| Core | `RecalledMemory.explanation.via?: { kind, from, weight }`; `Degradation` gains `links-skipped`; config `recall.links: { enabled: false, seeds: 3, pool: 5, admit: 2, budgetMs: 8, fMax: 50, factors }` and `recall.userLinks: true` (follow a person's explicit links on rerank paths). `recall.links` and `consolidate.distil` join `HOME_ONLY_SUBKEYS` **(my call for `recall.links`: it decides whether agent-written links reach the prompt)** |
| Store seam | optional, like `spatial`: `readonly links?: true`; `neighbours(grant, seedIds, opts)` returning ids; `link(grant, a, b, { assertedBy })`, `unlink(grant, a, b)`, `linksOf(grant, id)`; `recordAccess(grant, ids, at, opts?: { together?: string[] })`. A store without `links` gets no expansion and refuses `link` |
| SDK (`oortmem`) | `RecalledMemory.why.via` (`@experimental`, as `why` is); `explain(id)` gains `links: { kind, id, weight, direction, assertedBy? }[]`, and `hiddenLinks` counts stored link rows too (section 9); `link(a, b)`, `unlink(a, b)` (asserted by an agent) |
| Python | the same through `oort serve` |
| `oort serve` | `POST /v1/links`, `DELETE /v1/links` |
| MCP | `link` (`{ from, to, remove? }`, `destructiveHint: true`), offered only by a backend that implements links, as the judgment tools are; `recall` output carries `via`; `explain` lists links |
| CLI | `oort link <a> <b>` (a person, on a terminal, confirmed), `oort unlink <a> <b>`; `oort inspect <id>` lists links (kind, other id, weight, who asserted it); `oort explain "<query>"` adds a `via` column (`about ← #2`); `--links` / `--no-links` on `recall` and `explain` for one-off comparison |
| Injection block | a link-admitted line's label gains `linked`: `- [semantic, 2d ago, linked]`. **(my call: the label never names the entity, because labels are built from structured fields only and memory text, entities included, never reaches them)** |
| Export | version 2 gains an optional per-memory `links: [{ kind, id }]` for `explicit` and `distilledFrom` links whose other end is in the same export; import restores them, explicit ones as asserted by an agent. `recalledWith` and blocks are not exported |
| Usage | `link`, `unlink` and the gather step call no model. Distillation is one writer call per new general memory, opt-in, home config only |

## 13. Naming

- **Plain names everywhere a person reads an explanation**: `about`, `episode`, `recalledWith`,
  `supersedes`, `distilledFrom`, `explicit`.
- **The space names are taken.** `address.ts` maps levels to Planet, Star, Orbit, Flyby,
  Constellation and Galaxy. Calling a consolidated memory "a planet" would give one word two
  meanings ("a memory in your Planet" and "a memory that is a planet"); "asteroid" for a passing
  memory overlaps Flyby, and passing quickly is a tier (cold), not a kind. Levels say whose a
  memory is, tiers say how warm it is, links say how memories relate; a fourth astronomical axis
  would make "is my Planet a planet?" a real support question.
- **The star map may draw it.** A `distilledFrom` memory as a larger body with the memories it
  came from as moons around it; `recalledWith` as faint lines whose brightness is strength;
  `episode` as a short dotted trail, like the supersede trail. These are drawings, not names: no
  API, doc heading or explanation says "moon".

## 14. Cloud parity

The cloud store implements the same seam later, behind the same capability flag:

1. `linksConformance(name, make)` in `@oortmem/core/store-conformance` (written with the local
   store, CON-148) proves a store: the same-node and no-`hive` rules, the write grant on both ends,
   the grant on every neighbour and listed link, bounded scans, caps, blocks, the cascade and the
   `distilledFrom` step on `forget`, `recalledWith` decay and pruning, and an upsert that keeps
   links. The cloud store only has to pass it (CON-153).
2. Until then, cloud mode answers `link` and `unlink` with `refused` / `local-only` (as spatial
   options are), and `why.via` never appears. Contract cases for those refusals land with CON-148.
3. Contract cases (`contract/sdk/cases/links.json`) run on the `local` transport first and add
   `cloud` when it lands, so both transports pass one set of cases.
4. The cloud gives the same cascade guarantee as `ON DELETE CASCADE`, by whatever its database
   offers, in the same transaction or batch as the delete, and runs the `distilledFrom` step
   inside it.
5. Entity keys are hashed per vault owner (section 8).

## 15. Slices

Thin vertical slices, each independently testable. Docs ship with each (repo docs, and site docs
with tested examples where the slice is user-facing).

| # | Slice | Issue | Depends on |
| --- | --- | --- | --- |
| 1 | Eval: `multi-hop` category, `linkPrecision`, warm-up pass, link-shaped 100k and 1M latency stores with gather p99, ablation flags | CON-146 | none |
| 2 | Eval: LoCoMo and LongMemEval_S retrieval-level adapters, baseline recorded | CON-147 | none |
| 3 | Schema version 8 and explicit links end to end: `link` / `unlink` with who asserted it, `inspect` lists links, `forget` cascades, `linksConformance`, cloud refusal cases, export round-trip | CON-148 | none (version 8 after CON-25's 7) |
| 4 | One-hop recall: a person's explicit links on by default on rerank paths; agent links, `about` and `episode` behind `recall.links`; `via` on every surface | CON-149 | 3 |
| 5 | `recalledWith`: learning in the access record, decay, pruning, caps, blocks | CON-150 | 4 |
| 6 | Run the eval and decide the default | CON-151 | 1, 2, 4, 5 |
| 7 | `distilledFrom`: opt-in distillation, recall, and erasure inside `forget` | CON-152 | 3, CON-144 |
| 8 | Cloud parity: Oort Cloud passes `linksConformance` and the `cloud` contract cases | CON-153 | 3, 4, 5 |
| 9 | Star map draws links | CON-154 | 4 |
| 10 | Prompt hook `fast` mode follows links, once the no-rerank bar is met | CON-155 | 6 |

Slices 1, 2 and 3 can run in parallel. Only slices 6 and 10 can turn on a kind that is off by
default.

## 16. Left to the builder

- Exact SQL of the gather queries, as long as each is one bounded index range per seed, kind or
  entity, and `neighbours` is one store call per leg.
- How the store measures `budgetMs` between kinds and entities.
- The `access_log` JSON shape for pairs, as long as `appendAccess()` and `activation()` are reused
  unchanged.
- Where the `blocked` check runs (in the gather SQL or after).
- The exact distillation prompt and cluster tie-breaks, within section 7's caps.
- The terminal confirmation wording for `oort link`.
- Every number marked "start", once the eval has run.
