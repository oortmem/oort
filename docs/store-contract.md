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

The pre-level constructors build one pattern: the principal's own Planet, restricted to the
principal's agent as author. They see exactly what they saw before levels existed. Their two
project sets are:

- `read`: what `get`, `lexical`, `dense`, `list`, `coldGet` and `recordAccess` can see.
- `write`: what `upsert`, `upsertMany`, `forget`, `setTier`, `expireMany`, `coldPut` and
  `coldPutMany` can change.

`null` in a project set means global memories (no project). Build grants with:

```ts
import { localGrant, principalGrant } from '@oortmem/core';

// Read and write the project and global memories (what the CLI and hooks use).
const g = localGrant({ orgId, customerId, agentId, projectIds: ['my-project', null] });

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

The CLI, hooks and MCP server use only the pre-level constructors. `grant.read` and `grant.write`
remain as the deprecated pre-level view of the patterns (never wider than them).

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
  print one line: "Oort is upgrading its store; run `oort doctor` once". Every other `oort` command
  and the MCP server migrate on open; `oort doctor` reports the migration and where the copy is.
- **Rows the migration cannot place.** A version 1 row with an empty org, customer or agent id
  (grants never allowed one, the 0.1.0 store did not check) has no owner or author to give it, so
  the migration refuses, naming how many such rows there are, and changes nothing. Export or delete
  them with Oort 0.2.x, then open the store again.

`downgradeSqliteStore({ path })` takes a store back to version 1 for Oort 0.2.x. It first copies the
database to `<path>.pre-downgrade.<UTC time>` (the three newest are kept), and refuses while the
store holds anything version 1 cannot represent. **Run it with no other Oort process open**: no
Claude Code session with Oort hooks, no MCP server, no drain. Any of them would fail on the changed
schema, and the next `oort` command migrates the store straight back up.

## Testing a store

`@oortmem/core/store-conformance` exports `storeConformance(name, make)`. It runs the contract
tests and the isolation suite:

- every method, against memories in every other scope and at every other level;
- a seeded non-interference property, with single-node and multi-node grants
  (`OORT_ISOLATION_SEEDS` raises the number of seeds);
- separator and empty-grant edge cases;
- levels: every address round-trips, illegal ones are refused, node-pattern grants see exactly
  their nodes, and data written before levels reads back unchanged.
