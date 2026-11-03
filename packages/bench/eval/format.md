# Eval file format

An eval file is JSONL: one JSON object per line, blank lines ignored. Each row is
one question with the memory ids that should (and should not) come back.

```json
{
  "question": "what port does auth-service use",
  "expectedMemoryIds": ["m-8080"],
  "asOf": "2026-11-05T09:00:00Z",
  "category": "knowledge-update",
  "notExpectedMemoryIds": ["m-3000"]
}
```

| Field                  | Type                                                                                     | Meaning                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `question`             | string                                                                                   | The recall query. An empty (or whitespace) question is skipped and counted.                                              |
| `expectedMemoryIds`    | string[]                                                                                 | Memories a good recall returns. Empty for `abstention` rows.                                                             |
| `asOf`                 | string, optional                                                                         | ISO timestamp: recall what was true then (`RecallQuery.asOf`).                                                           |
| `category`             | `single-fact`, `knowledge-update`, `temporal`, `multi-session` or `abstention`, optional | Groups the report. Rows without one are reported as `uncategorized`.                                                     |
| `notExpectedMemoryIds` | string[], optional                                                                       | Superseded or corrected memories that must not be returned as current. Any of them in the top 10 counts as a stale leak. |

Unknown keys are ignored, so the `memoryId` the importer adds is harmless.

## Categories

- `single-fact`: one memory answers the question.
- `knowledge-update`: the answer changed; the current version is expected, older ones go in `notExpectedMemoryIds`.
- `temporal`: asked with `asOf`; the version valid then is expected.
- `multi-session`: several memories (from different sessions) are all expected.
- `abstention`: nothing should be returned. A row is a false positive when recall returns
  any memory (or, with `--abstain-threshold`, one whose fused score exceeds it).

## Metrics

Computed overall and per category.

- **recall@k**: for each row with expected ids, the fraction of them in the top k; averaged over those rows.
- **MRR**: reciprocal rank of the first expected id in the top results (the largest `--k`, at least 10; 0 when none); averaged over the same rows.
- **stale-leak rate**: the fraction of rows that list `notExpectedMemoryIds` where any of them appears in the top 10.
- **abstention false-positive rate**: the fraction of `abstention` rows that returned a memory.

A group shows `-` for a metric with no rows to compute it from.

## Importer rows

`oort import claude-code` appends rows to `$OORT_HOME/eval/import-<YYYY-MM-DD>.jsonl` with
`"question": ""`, the imported memory in `expectedMemoryIds`, and `asOf` set to the turn time.
Fill the question in by hand. `pnpm eval` accepts these files and skips rows that still have an
empty question, reporting how many.

## Running

```sh
pnpm eval <file.jsonl> [--store <path>] [--cold-dir <dir>] [--k 5,10] [--min-recall10 0.8] [--json]
pnpm eval --demo        # a synthetic 1,500-memory store and the bundled 20-row eval/fixture.jsonl
```

- The store defaults to `$OORT_HOME/oort.sqlite` and its cold directory to `cold/` beside it.
- `store-sqlite` has no read-only open, and `recall` records accesses. Eval therefore copies the
  database (with its `-wal` and `-shm`) and the cold directory to a temp directory and runs against
  the copy, which it deletes afterwards. The live store is only read. Within a run, access recording
  is also turned off so rows do not influence one another.
- Recall is lexical-only unless `--dense` is given, which uses the deterministic fake embedder; it
  only makes sense for stores seeded by the bench generator. Use `--now <iso>` to pin the read path's
  clock (the demo does).
- Exit code 1 when overall recall@10 is below `--min-recall10` (default 0, off); 2 on a usage error.
- `eval/fixture.jsonl` is generated: `pnpm --filter @oortmem/bench run fixture`. A test checks it is
  in sync with the generator.
