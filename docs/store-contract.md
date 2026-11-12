# The MemoryStore contract: grants

Every `MemoryStore` method takes a `Grant` first. The store enforces it itself; callers never
filter results afterwards. This is what keeps one user's, agent's or project's memories away from
another's when you embed `@oortmem/core`.

## Addresses and levels

Every memory has exactly one address. Its `level` says whose memory it is, and decides which fields
the address has:

| Level        | Space         | Address fields                                   |
| ------------ | ------------- | ------------------------------------------------ |
| `user`       | Planet        | `orgId`, `customerId`, `projectId?`              |
| `agent`      | Star          | `orgId`, `agentId`, `projectId?`                 |
| `agent-user` | Orbit         | `orgId`, `agentId`, `customerId`, `projectId?`   |
| `run`        | Flyby         | `orgId`, `agentId`, `runId`, `customerId?`, `projectId?` |
| `hive`       | Constellation | `orgId`, `hiveId`, `projectId?`                  |
| `hive`       | Galaxy        | `orgId`, `hiveId: 'root'`, `projectId?`          |

`orgId` is the owner: the storage, key and deletion boundary. Hive addresses never carry a
`customerId`. The node is the address without `projectId`; `projectId` binds a memory to a project
inside its node (absent means global).

Who wrote a memory is not part of its address: `author: { agentId, accountRef? }`. A person's agents
share their Planet; `author` keeps the explanation. An optional `provenance` records where a shared
copy came from.

A `Memory` written before levels has only `scope` (`orgId`, `customerId`, `agentId`,
`projectId?`). It lives in the Planet `(orgId, customerId, projectId)` and its author is `agentId`.
Stores return `address` only for levels other than Planet, `author` only when it differs from
`scope.agentId`, and `provenance` only when set, so such a memory comes back exactly as it was
written. Read them with `addressOf(m)` and `authorOf(m)`. To write at another level, spread
`addressed(address, author)` into the memory: it fills `scope` to match. A store rejects, writing
nothing, an illegal address (a missing or extra field for its level, an empty value, an unknown
level) or a `scope` that does not match the address and author, with a `RangeError`.

## Grants

A grant names a principal (`orgId`, `customerId`, `agentId`: who acts) and two sets of node
patterns, `readNodes` and `writeNodes`. A pattern names a node, a project set within it, and
optionally one author (`authorAgentId`); a memory is covered when some pattern matches its node
exactly (field by field, never by prefix), its project, and its author if the pattern names one.
Patterns may name nodes of other owners: whoever builds the grant has already decided the principal
may use them.

`localGrant` and `principalGrant` act for one agent of one person. They build two patterns per
side: the person's Planet, whichever of their agents wrote the memory, and the principal agent's
own Star (`{ level: 'agent', orgId, agentId }`). Another agent's Star is never covered, so one
agent never reads, changes or learns of another agent's private memory. Their two project sets
are:

- `read`: what `get`, `lexical`, `dense`, `list`, `coldGet` and `recordAccess` can see.
- `write`: what `upsert`, `upsertMany`, `forget`, `setTier`, `expireMany`, `coldPut` and
  `coldPutMany` can change.

`null` in a project set means global memories (no project).

Every grant also has a `home`: the node new memories are written to. For the local constructors it
is the Planet, or the agent's Star with `{ home: 'star' }`. With a Star home the write side is the
Star alone: the agent reads the shared Planet but cannot change any of it (upsert, forget, tiers,
expiry, cold copies; `observe` records an access on a Planet memory it re-observes but never
confirms it, and `recall` serves a cold Planet memory without hydrating it). The principal agent
id `ANONYMOUS_AGENT` (`anonymous`, a caller that named no agent) gets the Planet alone, read and
write, and can have no Star. `observe` addresses new memories there
(`homeAddress(grant, projectId)`), and never edits a memory in another node: an observation that
would supersede, correct or refine a memory outside its home becomes a new memory at home, and a
contradiction is recorded on it as a `level`/`contradicts` decision naming the other memory. That
id may be a Star memory other readers cannot see: anything that shows a memory's decisions to a
reader should drop a `level`/`contradicts` entry whose id the reader's grant cannot read (the CLI
and MCP server do). Recall still ranks by the full record.

Build grants with:

```ts
import { localGrant, principalGrant } from '@oortmem/core';

// Read and write the project and global memories of the person's Planet and this agent's Star
// (what the CLI and hooks use).
const g = localGrant({ orgId, customerId, agentId, projectIds: ['my-project', null] });

// The same, for an agent that keeps its new memories in its own Star.
const star = localGrant({ orgId, customerId, agentId, projectIds: [null] }, { home: 'star' });

// Read global memories but write only the project.
const narrow = localGrant(
  { orgId, customerId, agentId, projectIds: ['my-project', null] },
  { write: { orgId, customerId, agentId, projectIds: ['my-project'] } },
);

// Every project of one principal, for maintenance such as an export.
const all = principalGrant({ orgId, customerId, agentId });

// Node patterns: my Planet (every author) plus a Constellation of another owner, read-only.
const wide = nodeGrant({
  principal: { orgId, customerId, agentId },
  read: [
    { node: { level: 'user', orgId, customerId }, projectIds: 'all' },
    { node: { level: 'hive', orgId: 'org:acme', hiveId: 'checkout' }, projectIds: ['my-project'] },
  ],
  write: [{ node: { level: 'user', orgId, customerId }, projectIds: 'all' }],
});
```

`narrowGrant(g, nodes)` keeps only some of a grant's nodes (recall uses it to search one node at a
time), and `readableNodes(g)` lists them. The CLI, hooks and MCP server use `localGrant` and
`principalGrant`. `grant.read` and `grant.write` remain as the deprecated pre-level view of the
patterns (never wider than them).

### The Planet is shared by a person's agents

Before, the local constructors restricted the Planet pattern to memories the principal's own agent
wrote, so an agent id saw only its own writing. Now they read every author's Planet memories and add
the agent's Star. Nothing is rewritten in any store: the stored memories are the same, only what a
grant covers changed. Every local store so far was written as `claude-code`, so it reads exactly as
before. A library caller that used several agent ids to keep memories apart inside one Planet
should write those memories to each agent's Star (`addressed({ level: 'agent', orgId, agentId },
{ agentId })`), or build the old grant explicitly:

```ts
nodeGrant({
  principal: { orgId, customerId, agentId },
  read: [{ node: { level: 'user', orgId, customerId }, projectIds: 'all', authorAgentId: agentId }],
});
```

## Recall across levels

`recall` reads one node at a time and fuses the results (spec: recall per node, then fuse):

- **First stage per node.** Lexical and dense search run once per node the grant reads, and
  reciprocal rank fusion runs within each node as before. The nodes are then merged by fused score
  and reranked once. A recall over one node (or over a Planet and an empty Star) is exactly the
  recall of a single-node grant: same ids, order, scores and injected text.
- **`include`** names levels: `self` (the home node), `planet`, `star` (the calling agent's own),
  `constellation`, `galaxy`. It is intersected with the grant; a level the grant does not cover
  rejects with `ScopeDeniedError` (`code: 'scope_denied'`), never an empty result. Without it,
  every node the grant reads, with at most four hive nodes.
- **Specificity prior**, off by default (`recall.specificityPrior`, ε = 0): when set, each node's
  fused scores are scaled by `1 + ε × specificity / 3`, with an agent's Star (or Orbit, Flyby) 3,
  the Planet 2, a Constellation 1 and a Galaxy 0.
- **Conflict rule**, always on: when a returned memory records a contradiction of another returned
  memory in a different node, the narrower one ranks first and the wider one stays in the results,
  its `origin.overriddenBy` naming the narrower memory.
- **Origin.** Each recalled memory carries `origin`: its level, space, node label (`your Planet`,
  `Star cursor`, `Constellation checkout`), `from` (`from your Planet`, `from this agent's Star`),
  whether it is in the home node, and its author. `result.read` lists the nodes the recall read.
- **Labels.** `formatForInjection` names the node in each line (`- [semantic, Star cursor, 5h ago]`)
  only when some memory comes from outside the reader's home node, so a one-node recall reads as it
  always did. Labels are built from these fields only; brackets in memory text are escaped (`\[`,
  `\]`), so a memory cannot pass its text off as a label, and any `<oort-` or `</oort-` in it is
  written `&lt;oort-`, so it cannot close the block. Hive memories take at most 40% of the
  injection budget.

`consolidate` re-tiers each node of its grant on its own, so the Planet's tiers do not depend on
which agent ran it. Inside a node it ranks each project, and the global memories, on its own
(`hotTopN` each), so a global memory's tier does not depend on which project ran it.

A grant is frozen and nominal. A plain object with the same fields is not a grant: TypeScript
rejects it, and every store rejects it at run time with a `TypeError`.

## What a store guarantees

- **Out of grant looks like missing.** An id outside the grant gives `null`, `false`, a skipped
  entry or a silent no-op, exactly as an unknown id does. Nothing in a result or error tells the
  two apart.
- **Writes stay inside `write`.** `upsert` and `upsertMany` reject with `GrantError`, and write
  nothing, when a memory's address and author are outside `grant.write`, or when a record with
  that id already exists at another address. Both cases use the same message. A batch is all or
  nothing.
- **Addresses never change.** An existing id keeps its address, author and scope; changing any of
  them is a `GrantError`.
- **Cursors belong to the principal.** All projects of one principal share them; other principals
  never see them.

## Places (spatial memory)

A store that sets `spatial: true` (0.9.0 or newer, CON-84) keeps `Memory.place` as written and
takes a fourth argument on `lexical` and `dense`: `SearchOptions { spatial?: SpatialFilter }`.
It applies the filter inside the search, before `k` is taken, exactly as it applies the grant, so a
spatial recall never comes back short because other places filled the top `k`:

- `within: 'room:B'` keeps memories whose `place.nodeId` contains those whole `/`-separated
  segments, contiguously, at any depth (`room:B2` and a memory without a path never match);
- `near: { mapId, frame?, pose, radius }` keeps memories whose `place` has a `pose` on the same
  map and frame (`frame` defaults to `map`) within `radius` metres of `pose`, measured to the
  memory's `extent` (0 inside it); `z` counts only when both sides have one;
- both together must both hold.

Recall checks the filter before any read, passes `SearchOptions` only when there is a filter, and
refuses one (`SpatialUnsupportedError`) on a store without `spatial: true`, which would otherwise
return every place. `spatialConformance(name, make)` in `@oortmem/core/store-conformance` proves a
store: the place round-trips, whole-segment matching, the radius and its edge, other maps and frames,
the combined filter, the grant still applying, and the filter applying before `k`.

## Known limit

SQLite's lexical scores come from FTS5's `bm25`, which uses term statistics over the whole table.
Another tenant's text in the same database file can shift a tenant's lexical scores and, near the
cut-off, their order. Results never include another tenant's memories. Keep tenants in separate
database files when score independence matters.

## SQLite schema versions

`@oortmem/store-sqlite` schema version 2 stores the address (`level`, `org_id`, `customer_id`,
`agent_id`, `hive_id`, `run_id`, `project_id`), the author (`author_agent_id`,
`author_account_ref`) and `provenance` per memory, with a `CHECK` that each level fills exactly its
own fields. Vectors are partitioned by node, with project and author as filter columns.

Schema version 3 (judgment memory, CON-71) adds one nullable column, `judgment`: the JSON
`judgment` record of a `judgment` memory, NULL on every other row. Opening a version 2 store adds
the column in one transaction (`ALTER TABLE … ADD COLUMN`); nothing else is rewritten. It takes the
same copy first as the version 1 migration below, to `<path>.pre-v3.<UTC time>`
(`listBackups(path, 'pre-v3')`), and the hooks leave it to the next `oort` command the same way.
A version 1 store goes to version 2 and then 3 in one transaction, with one `pre-v2` copy.

Schema version 4 (tokeniser v2, CON-110) rebuilds the lexical index. Core's `tokenizeLexical` became
script-aware: CJK text is indexed as overlapping character bigrams, Thai, Lao, Khmer and Myanmar as
words (`Intl.Segmenter`), combining marks stay inside words, and Latin diacritics are folded. Its
output for plain English is byte-identical to version 1's, emoji included (variation selectors,
keycaps and ZWJ sequences separate words, as before, and so do `…` and `‥`). NFKC folds
compatibility forms on purpose: full-width ASCII (`ＡＰＩ` is `api`), fractions (`½` is `1 2`), super-
and subscripts (`x²` is `x2`) and ligatures (`ﬁ` is `fi`); `™` and `℠` separate words, as before. The index is declared with
`unicode61 remove_diacritics 0 categories 'L* N* Co M*' tokenchars '-_.'` (`FTS_TOKENIZE`), so FTS5
keeps the marks too. Opening a version 3 store drops `memories_fts` and creates the index as
`memories_fts2` with the new declaration (renamed so that an older Oort still running against the
store, an MCP server or daemon started before the upgrade, fails on its next write instead of
indexing tokens nothing would find) and indexes every memory again from its stored text (a cold
memory from its stub and entities only), in one transaction, after a copy to `<path>.pre-v4.<UTC
time>`. No vector, cold blob or row changes, and no vendor is called. The new index is optimised
into one segment. Its BM25 row and token totals count the live rows only, where the old index also
counted every row ever rewritten (a contentless-delete index never subtracts one), so lexical scores
shift once, and so can the order of results: a one-time ranking change from correcting the index's
statistics. Which memories match does not change. `meta` records
`lexical_version` (2) and ICU's major version. A migrating open rebuilds the index again when the
tokeniser version differs, or when ICU's major version is newer than the one recorded and the store
holds Thai, Lao, Khmer or Myanmar text (their word breaks come from ICU's dictionaries; nothing else
changes with ICU). An index recorded by a newer ICU is left alone, so two Node versions on one
machine do not rebuild in turn, and an ICU version that is empty or not a number never triggers a
rebuild (with segmented text in the store, the open logs a warning). A version 4 index that is not
right for its memories (under the old name, missing, or empty beside stored memories) is rebuilt
the same way; an open with `migrate: false` refuses it with `StoreMigrationRequiredError`, changing
nothing. Versions 1 and 2 go up to 4 in the same single transaction. An open that rebuilds prints one line first, "Rebuilding the search
index (N memories)…", and waits up to 60 seconds (`MIGRATION_BUSY_TIMEOUT_MS`) for another
connection's write lock, whatever `busyTimeoutMs` is.

Schema version 5 (spatial memory, CON-84) adds two nullable columns, `place` (the JSON place) and
`place_node` (its path, for `within`), and an R*Tree, `memories_place`, holding the bounding box of
each placed memory's region with its map and frame as an auxiliary column. `near` is a box query on
the R*Tree, then an exact distance check (`oort_place_distance`, a deterministic SQL function the
store registers). A version 4 store gains the columns and the empty R*Tree in one transaction,
after a `pre-v5` copy (`listBackups(path, 'pre-v5')`); nothing is rewritten and the lexical index
is not rebuilt. Older versions go up through 4 to 5 in the same transaction, and on to 6.

Schema version 6 (the binary vector index, CON-17; Oort 0.9.0 or newer) adds a second, optional
dense index beside the int8 vectors, and a guard that stops an older Oort from writing.

- **The binary index.** `memories_vec_bit` is a sqlite-vec `vec0` table holding, for every hot and
  warm memory with a vector, a 1-bit code of the vector (`bit[W]`, W the dimension rounded up to a
  power of two: 512 for 512, 512 for 384, 1024 for 1024), partitioned by node with project and
  author as filter columns like `memories_vec`, and the memory's int8 vector again as an auxiliary
  column for rescoring. The code is the sign of each value after a fixed randomized Hadamard
  rotation (the rotation RaBitQ uses), so Hamming distance estimates the angle between vectors. A
  dense query takes the `10 × k` nearest codes by Hamming distance (at most 4096) and rescores them
  with the exact int8 cosine. `dense` returns the same scores either way (the int8 cosine); with the
  binary index, a memory the codes rank outside the `10 × k` candidates can be missed. A spatial
  filter (`near`, `within`) applies inside the binary KNN as inside the int8 one, so the candidates
  are drawn from the matching memories only.
- **When it exists.** `openSqliteStore({ vectorIndex })`: `auto` (the default) builds it when an
  open that may migrate finds at least `binaryAutoThreshold` (100,000) searchable vectors and keeps
  it from then on; `binary` builds it now; `int8` drops it. The build reads the int8 vectors (no
  vendor is called, nothing else changes), prints "Building the binary vector index (N vectors)…"
  and runs in one transaction, waiting up to 60 seconds for another connection's write lock. A
  process killed during it leaves the store as it was. Every write after that keeps it in step:
  `upsert`, `forget`, `coldPut`, `setTier` and `reembedSqliteStore`. A cold memory has no code.
- **The writer guard.** Version 6 adds triggers on `memories` that call a function only Oort 0.9.0
  or newer defines, so an Oort that started before the upgrade (an MCP server, a daemon) fails on
  its next write, changing nothing, instead of writing memories the binary index would not hold. A
  connection it already has can still read. Restart it after the upgrade.
- **Migration.** Opening a version 5 store adds the guard in one transaction; nothing else is
  rewritten, and the binary index follows the rules above. It takes no copy first, unlike the
  earlier migrations: version 6 only adds (triggers and an index built from the int8 vectors) and
  `downgradeSqliteStore({ to: 5 })` goes back without loss, so a plaintext copy of every memory,
  which `forget` would never reach, is not worth keeping. A version 4 store goes up through 5 to 6 in
  one transaction with only version 5's `pre-v5` copy. `migrate: false` refuses a version 5 (or older) store with
  `StoreMigrationRequiredError` and never builds or drops the index. An Oort older than 0.9.0
  refuses a version 6 store without changing it, as every version refuses a newer schema.
  `sqliteVectorIndex(path)` says which index a store searches and how many vectors, read-only.

A stored place that does not parse or does not pass `checkPlace` (from a crafted or damaged copy
of the database, such as a negative size or a null pose) is handled the same way everywhere:

- **`near`** never returns it. The exact distance check checks the place first, and a place that
  fails has no distance, so the recall goes on without it.
- **Reads** (`get`, `list`, recall hits, and so exports) return the memory without its place, so
  nothing hands back a place that an import would refuse.
- **`within`** matches the separately stored path column (`place_node`), not the JSON place. A
  memory whose place fails the check can still be found by `within` if that column holds a
  matching path; it is returned without its place.
- **A missing R\*Tree** is rebuilt on open from the stored places, each checked with `checkPlace`
  as a write is. Places that fail are left out of the index, the open does not fail, and the store
  logs one line: "sqlite store: N stored places failed the place check and are not searchable by
  near".

Opening a version 1 store migrates it in one transaction: every memory becomes its owner's Planet
(`agent_id` moves to `author_agent_id`), row ids, FTS rows, cursors and cold blobs are kept, and the
vector table is rebuilt from the stored embeddings.

- **A copy first, every time.** Before the migration's transaction starts, the store copies the
  database (with `VACUUM INTO`, so the WAL is included) to a new owner-only file
  `<path>.pre-v2.<UTC time>`: written to a randomly named temporary file, fsynced, reopened to check
  it holds as many memories as the store, then renamed into place. If the copy fails, the open fails
  with a message saying so, and nothing changes. The three newest copies are kept, plus the oldest
  (the original version 1 store). `listBackups(path, 'pre-v2')` lists them. Cold blobs are not
  copied: no migration changes them.
- **Not in a hook.** `openSqliteStore({ ..., migrate: false })` never migrates: an older store makes
  it reject with `StoreMigrationRequiredError`, changing nothing. The Claude Code hooks open the
  store this way; finding an older store they skip recall and saving for that turn, exit 0, and
  print one line: "Oort is upgrading its store; run `oort doctor` once, then restart any Oort MCP
  server started before the upgrade". Every other `oort` command and the MCP server migrate on open;
  `oort doctor` reports the migration and where the copy is.
- **Rows the migration cannot place.** A version 1 row with an empty org, customer or agent id
  (grants never allowed one, the 0.1.0 store did not check) has no owner or author to give it, so
  the migration refuses, naming how many such rows there are, and changes nothing. Export or delete
  them with Oort 0.2.x, then open the store again.

`downgradeSqliteStore({ path })` takes a store back to version 1 for Oort 0.2.x,
`downgradeSqliteStore({ path, to: 2 })` to version 2 for Oort 0.3 to 0.5, and `{ path, to: 3 }` to
version 3 for Oort before tokeniser v2 (the lexical index is rebuilt with tokeniser v1, as
`memories_fts` again), `{ path, to: 4 }` to version 4 for Oort 0.6.1 to 0.8 (the place columns
and the R*Tree are dropped), and `{ path, to: 5 }` to version 5 (the binary index and the writer
guard are dropped; the int8 vectors were never moved). Opening a store never goes down: migrations only roll forward. It first
copies the database to `<path>.pre-downgrade.<UTC time>` (the three newest are kept), and refuses
while the store holds anything the target version cannot represent (for version 4 and below, any
memory with a place; for version 2, also any judgment; for
version 1, also any memory outside the Planet, an author with an account, or provenance). **Run it
with no other Oort process open**: no Claude Code session with Oort hooks, no MCP server, no drain.
Any of them would fail on the changed schema, and the next `oort` command migrates the store
straight back up.

## Testing a store

`@oortmem/core/store-conformance` exports `storeConformance(name, make)`. It runs the contract
tests and the isolation suite:

- every method, against memories in every other scope and at every other level, once as the
  narrowest grant and once as `localGrant`, which may reach only the shared Planet and its own
  agent's Star (another agent's Star stays out of reach, warm and cold);
- a seeded non-interference property, with single-node grants, multi-node grants, and two agents of
  one person, where nothing the second agent does through its own Star reaches the first
  (`OORT_ISOLATION_SEEDS` raises the number of seeds);
- separator and empty-grant edge cases;
- levels: every address round-trips, illegal ones are refused, node-pattern grants see exactly
  their nodes, the local grants see the Planet and their own Star only, and data written before
  levels reads back unchanged.
