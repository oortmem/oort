# Oort export format, version 1

`oort export` writes the memories visible from the current project as
[JSON Lines](https://jsonlines.org/) (UTF-8, one JSON value per line, each line
ending in `\n`). Output goes to stdout, or with `--out <file>` to a new file
created owner-only (`0600`). An existing file is refused unless `--force` is
given, and a symlink is never written through. `--json` is accepted and changes
nothing. This format is the basis for import and migration (CON-36).

## What is exported

- Every memory in the current project's scope plus global memories (the scope
  `oort recall` reads from that directory), in every tier (`hot`, `warm`,
  `cold`) and every validity state (current, superseded, expired, corrected).
- Cold memories are decoded: `text`, `stub`, `entities` and `embedding` come
  from the cold copy; every other field (tier, access log, validity) comes from
  the live record. If a cold copy cannot be read, the live record is exported
  (stub and entities only, no embedding) and a warning naming the id goes to
  stderr.
- Memories are ordered oldest first by `createdAt`, then by `id`, so a
  reader can replay supersede chains in order.


## Line 1: the manifest

```json
{
  "oort": "export",
  "version": 1,
  "exportedAt": "2026-11-03T20:00:00.000Z",
  "memories": 42,
  "scopes": [{ "orgId": "local", "customerId": "self", "agentId": "claude-code", "projectId": "oort-1a2b3c4d" }]
}
```

| Field        | Type     | Meaning                                                                 |
| ------------ | -------- | ----------------------------------------------------------------------- |
| `oort`       | `"export"` | Identifies the file.                                                   |
| `version`    | `1`      | Format version. A reader refuses versions it does not know.             |
| `exportedAt` | ISO 8601 | When the export was written (UTC).                                      |
| `memories`   | integer  | Number of memory lines that follow.                                     |
| `scopes`     | `Scope[]` | The distinct scopes of the exported memories (empty when there are none). |

A `Scope` is `{ "orgId": string, "customerId": string, "agentId": string, "projectId"?: string }`.
`projectId` is absent for global memories.

## Lines 2 to n+1: one memory each

Each line is a complete `Memory` (see `packages/core/src/model.ts`) with one
change: `embedding` is a base64 string of the raw int8 vector bytes (one byte
per dimension, two's complement), and is absent when the memory has none.

| Field             | Type                                                       |
| ----------------- | ---------------------------------------------------------- |
| `id`              | string (UUID)                                              |
| `scope`           | `Scope`                                                    |
| `type`            | `"semantic"` \| `"episodic"` \| `"procedural"` \| `"preference"` |
| `text`            | string: the de-contextualised claim                        |
| `stub`            | string: short form kept searchable while cold              |
| `entities`        | string[]                                                   |
| `salience`        | number in [0, 1]                                           |
| `pinned`          | boolean                                                    |
| `tier`            | `"hot"` \| `"warm"` \| `"cold"`                            |
| `accessLog`       | `{ count, recent: ISO[], compactedSum, compactedAt: ISO \| null, compactedMeanAgeHours? }` |
| `validFrom`       | ISO 8601: when the fact became true                        |
| `validTo`         | ISO 8601 \| null: when it stopped being true (exclusive)   |
| `expiredAt`       | ISO 8601 \| null: when Oort stopped believing it           |
| `endReason`       | `"superseded"` \| `"corrected"` \| `"expired"` \| null      |
| `lastConfirmedAt` | ISO 8601 \| null                                           |
| `supersedes`      | string \| null: id of the memory this one replaced         |
| `supersededBy`    | string \| null: id of the memory that replaced this one    |
| `supersedesHidden`   | `true`, optional: `supersedes` was nulled (see Limitations)   |
| `supersededByHidden` | `true`, optional: `supersededBy` was nulled (see Limitations) |
| `source`          | `{ harness, sessionId?, turnRef?, decisions: { stage, question, answer, probability }[] }` |
| `embedding`       | base64 string, optional                                    |
| `createdAt`       | ISO 8601                                                   |
| `updatedAt`       | ISO 8601                                                   |

No other fields appear. The two `…Hidden` flags appear only when set. Decoding an embedding in Node:

```js
const vector = Int8Array.from(Buffer.from(line.embedding, 'base64'));
```

The export contains memory text, which may be sensitive. Secrets were scrubbed
before storage, but treat the file like the store itself.

## Limitations

- **Scope.** In Phase 1, an export covers the current project (the git root
  above the cwd) plus global memories, nothing else. The store API only lists
  through a scope filter, so memories of other projects (including private
  ones) are left out. To export them, run `oort export` from each project.
  A whole-store export needs an unscoped listing, which arrives with CON-36.
- **Links into other scopes.** A `supersedes` or `supersededBy` that points
  at a memory the exporting scope cannot see (another project's, from before
  observe kept supersede chains within one scope) is written as `null`, with
  `supersedesHidden: true` or `supersededByHidden: true`. The export names no
  memory outside its scope, by id or by text. The store keeps the real link; an
  importer sees a chain that ends where the hidden memory was. A link to a
  memory that no longer exists keeps its id.
