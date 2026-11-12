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

| Field                  | Type                                                                                                  | Meaning                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `question`             | string                                                                                                | The recall query. An empty (or whitespace) question is skipped and counted.                                              |
| `expectedMemoryIds`    | string[]                                                                                              | Memories a good recall returns. Empty for `abstention` rows.                                                             |
| `asOf`                 | string, optional                                                                                      | ISO timestamp: recall what was true then (`RecallQuery.asOf`).                                                           |
| `category`             | `single-fact`, `knowledge-update`, `temporal`, `multi-session`, `multi-hop` or `abstention`, optional | Groups the report. Rows without one are reported as `uncategorized`.                                                     |
| `notExpectedMemoryIds` | string[], optional                                                                                    | Superseded or corrected memories that must not be returned as current. Any of them in the top 10 counts as a stale leak. |
| `lang`                 | string, optional                                                                                      | BCP 47 code of the question's language (`ja`, `pt-BR`). The multilingual set fills it.                                   |
| `condition`            | `mono`, `cross` or `mixed`, optional                                                                  | Pins a multilingual row to one condition; rows without it run in all three (`multilingual/README.md`).                   |

Unknown keys are ignored, so the `memoryId` the importer adds is harmless.

## Categories

- `single-fact`: one memory answers the question. In the bundled demo these rows are a lexical
  regression guard (the expected memory is lexical rank 1, so fusion must keep it in the top 5); they do not
  measure paraphrase or dense recall, which needs real embeddings (CON-45, Phase 2).
- `knowledge-update`: the answer changed; the current version is expected, older ones go in `notExpectedMemoryIds`.
- `temporal`: asked with `asOf`; the version valid then is expected.
- `multi-session`: several memories (from different sessions) are all expected.
- `multi-hop`: the expected memory shares no word with the question; it is linked to a memory
  that does, by a shared specific entity or by being the next turn of the same session ("which
  database does the project that moved staging to Frankfurt use?"). Recall can only reach it by
  following a link (memory relationships, CON-145), so without links these rows score 0.
- `abstention`: nothing should be returned. A row is a false positive when recall returns
  any memory (or, with `--abstain-threshold`, one whose fused score exceeds it). The fused score is
  RRF scaled by a bounded activation boost, so it lies within [rrf, 1.05 x rrf] with rrf at most about 0.033
  (two lists, rank 1 in both); it is non-negative but not on a 0-1 scale, and a useful cut-off has to be
  picked by looking at the scores, not assumed.

## Metrics

Computed overall and per category.

- **recall@k**: for each row with expected ids, the fraction of them in the top k; averaged over those rows.
- **MRR@10**: reciprocal rank of the first expected id within the top 10 (0 when none); averaged over the same rows. The window is fixed at 10 whatever `--k` is.
- **stale-leak rate**: the fraction of rows that list `notExpectedMemoryIds` where any of them appears in the top 10.
- **abstention false-positive rate**: the fraction of `abstention` rows that returned a memory.
- **link precision**: of the memories a link brought in (`explanation.via`) in the top 10 of every
  row, the share that were expected; pooled over the rows, not averaged per row. `-` when no row
  returned a linked memory, which is every run until links exist (CON-149).

A group shows `-` for a metric with no rows to compute it from.

## Importer rows

`oort import claude-code` appends rows to `$OORT_HOME/eval/import-<YYYY-MM-DD>.jsonl` with
`"question": ""`, the imported memory in `expectedMemoryIds`, and `asOf` set to the turn time.
Fill the question in by hand. `pnpm eval` accepts these files and skips rows that still have an
empty question, reporting how many.

## Running

```sh
pnpm eval <file.jsonl> [--store <path>] [--cold-dir <dir>] [--k 5,10] [--min-recall10 0.8] [--json]
                       [--warm-up <file.jsonl>] [--links off|user|<kind>|all|grid]
pnpm eval --demo [--dense] [--warm-up packages/bench/eval/warm-up.jsonl]
                        # a synthetic 1,512-memory store and the bundled 29-row eval/fixture.jsonl
pnpm eval --demo --hook --dense   # the 15-row hook-shaped set, no reranker (the prompt hook's `fast`)
pnpm eval --set multilingual [--embed …] [--rerank …]   # 13 languages, three conditions (multilingual/README.md)
pnpm eval --set locomo|longmemeval [--fetch] [--plan] [--embed …] [--rerank …]   # public sets (public/README.md)
```

- The bundled demo is a smoke test of the eval pipeline, not a quality benchmark. Its 1,500
  synthetic memories come from templates, so words repeat across them, and its rows mix exact,
  partial and paraphrased single-fact queries, chain questions that name the subject in natural
  words, abstention queries made of common corpus words, and 6 multi-hop rows over 12 extra
  memories (3 pairs linked by a specific entity, 3 by consecutive turns of one session).
  Lexical-only recall on it is expected to score poorly in places; the numbers only mean something
  relative to later runs of the same demo. Quality needs the hand-labelled rows from imported
  transcripts.
- The store defaults to `$OORT_HOME/oort.sqlite` and its cold directory to `cold/` beside it.
- `store-sqlite` has no read-only open, and `recall` records accesses. Eval therefore takes a
  consistent snapshot: a read-only connection plus SQLite's online backup for the database (safe
  while another process writes), then a copy of the cold directory. It runs against the copy and
  deletes it afterwards. The live store is only read. It warns (a count, no ids) when the store
  names cold blobs that are missing from the cold directory. Within a run, access recording
  is also turned off so rows do not influence one another.
- Recall is lexical-only unless `--dense` is given, which uses the deterministic fake embedder; it
  only makes sense for stores seeded by the bench generator. Use `--now <iso>` to pin the read path's
  clock (the demo does).
- Exit code 1 when overall recall@10 is below `--min-recall10` (default 0, off); 2 on a usage error.
- `eval/fixture.jsonl`, `eval/hook.jsonl` and `eval/warm-up.jsonl` are generated:
  `pnpm --filter @oortmem/bench run fixture`. A test checks they are in sync with the generator,
  and that the fixture's first 23 rows are the ones it had before the multi-hop rows.

### Warm-up (`--warm-up <file>`)

Learned links (`recalledWith`, CON-150) form when a recall returns memories together, so a run
whose rows cannot influence each other never learns any. `--warm-up <file>` runs a second,
disjoint question set (no question may also be an eval question; rows need no expected ids)
before scoring, with access recording live on the snapshot copy. The rows then run twice and both
tables are printed: cold (before the warm-up) and warm (after it), with the number of access
records the warm-up made. The live store is still only read. `eval/warm-up.jsonl` is the demo's:
one question per multi-hop pair, with words of both ends, so one recall returns them together.

### Links (`--links`)

Memory relationships (design `docs/design/2026-11-12-memory-relationships.md`) are not built
yet. `--links` picks what recall follows, from the design's ablation grid:

| Mode                                                            | Follows                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `off` (default)                                                 | nothing: today's recall, the baseline every bar is measured against |
| `user`                                                          | explicit links a person wrote                                       |
| `explicit`, `distilledFrom`, `recalledWith`, `episode`, `about` | that kind alone                                                     |
| `all`                                                           | every kind                                                          |
| `grid`                                                          | each of the above in turn, one table per mode                       |

Until `recall.links` exists (CON-149), every mode but `off` is refused with a message naming it.
The switch is `packages/bench/src/links.ts`: it detects `recall.links` in the resolved config and
maps each mode onto the settings section 12 of the design specifies.

### Hook-shaped queries (`--hook`)

The prompt hook recalls without a reranker by default (`recall.promptMode: fast`), and decision 3
of the links design keeps links out of that path until a separate bar is met on hook-shaped
queries. `eval/hook.jsonl` is a synthetic stand-in over the demo store: short conversational
prompts (4 single-fact, the 6 multi-hop needs as a person would type them, and 5 prompts with no
memory need, such as "ok run the tests again"). Run it with `--demo --hook --dense`, which is the
`fast` path (fake embedder, no reranker). Real hook queries from imported transcripts stay out of
the repo, under `$OORT_HOME/eval/hook-*.jsonl`, and run with `pnpm eval <file> --store …`.

## Links latency (`pnpm bench --suite links`)

The links bar needs recall p95 up by no more than 10 ms at 100,000 and 1,000,000 memories, with
the gather step's own p99 reported. The default `pnpm bench` store (10,000 memories, no sessions)
gives a gather step nothing to gather, so this suite builds link-shaped stores:

```sh
pnpm bench --suite links --build-only [--warm-up 500]  # build (or reuse) the 100k and 1M stores
pnpm bench --suite links [--count 100000,1000000] [--queries 200] [--repeats 3]
                         [--paths lexical,fast,full] [--links off|on|both] [--rebuild] [--json]
```

- **Generator** (`src/generate-linked.ts`): sessions written in turn order, with Zipf-distributed
  lengths and about one turn in five split into 2 or 3 facts sharing a `turnRef`; entities drawn
  from a Zipf law over `n / 10` names (a few hubs, a long tail), mostly from each session's own
  topics. Streamed in batches, so a million memories fit in the process.
- **Cached** under `packages/bench/.cache/linked-<count>-s<seed>-g<generator>/` (gitignored),
  with a `manifest.json` written last. A store is built once and reused; a missing manifest (an
  interrupted build), a different generator version, count or seed rebuilds it, and `--rebuild`
  forces it. The 1M store takes about 2 GB of disk and long to build on a busy machine.
- **Warm-up**: `pnpm bench` measures on a `frozen()` store whose `recordAccess` does nothing, so a
  learned pair could never form during measurement. The build therefore first runs 500 recalls
  (`--warm-up <n>` with `--build-only`) on the unwrapped store, with access recording live and,
  once `recall.links` exists, links on, from a query sample disjoint from the measured one; only
  then is the store frozen. When the store
  schema version or the links capability changes (a newer build opens the cached store), only the
  warm-up runs again.
- **Paths**: `lexical`, `fast` (fake embedder, no reranker) and `full` (fake embedder and a
  deterministic in-process reranker), so no run needs a model or a key.
- **Report**: per store and path, recall p50 / p95 / p99 with links off and on, the p95 and p99
  deltas, and the gather step's p50 / p99 (`timings.linksMs`, which CON-149's recall must report).
  Until `recall.links` exists only links off runs and the other columns are `-`.

Baselines are recorded in `packages/bench/baselines/`.
