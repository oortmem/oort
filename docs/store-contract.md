# The MemoryStore contract: grants

Every `MemoryStore` method takes a `Grant` first. The store enforces it itself; callers never
filter results afterwards. This is what keeps one user's, agent's or project's memories away from
another's when you embed `@oortmem/core`.

## Grants

A grant names one principal (`orgId`, `customerId`, `agentId`) and two project sets:

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
```

A grant is frozen and nominal. A plain object with the same fields is not a grant: TypeScript
rejects it, and every store rejects it at run time with a `TypeError`.

## What a store guarantees

- **Out of grant looks like missing.** An id outside the grant gives `null`, `false`, a skipped
  entry or a silent no-op, exactly as an unknown id does. Nothing in a result or error tells the
  two apart.
- **Writes stay inside `write`.** `upsert` and `upsertMany` reject with `GrantError`, and write
  nothing, when a memory's scope is outside `grant.write`, or when a record with that id already
  exists at another address. Both cases use the same message. A batch is all or nothing.
- **Addresses never change.** An existing id keeps its scope; moving it is a `GrantError`.
- **Cursors belong to the principal.** All projects of one principal share them; other principals
  never see them.

## Known limit

SQLite's lexical scores come from FTS5's `bm25`, which uses term statistics over the whole table.
Another tenant's text in the same database file can shift a tenant's lexical scores and, near the
cut-off, their order. Results never include another tenant's memories. Keep tenants in separate
database files when score independence matters.

## Testing a store

`@oortmem/core/store-conformance` exports `storeConformance(name, make)`. It runs the contract
tests and the isolation suite:

- every method, against memories in every other scope;
- a seeded non-interference property (`OORT_ISOLATION_SEEDS` raises the number of seeds);
- separator and empty-grant edge cases.
