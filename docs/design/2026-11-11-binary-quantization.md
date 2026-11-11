# Binary quantization with rescoring, and the read path's adaptive stop

Date: 2026-11-11. Status: built (CON-17), ships in **0.9.0 or newer**. Unblocks CON-25 (the Rust
index), which must pass the same `storeConformance`.

The local store's dense search scans every hot and warm memory's int8 vector. At one million
memories of 512 dimensions that is 512 MB of vectors per query, which is neither fast nor small.
This note describes a second, optional dense index of 1-bit codes, rescored in int8, and the read
path's adaptive stop: recall does not widen into archived (cold) memories when the memories it
already has answer the query. §9 has the measurements; §10 says what was not met.

## 0. Decisions in brief

1. **A binary index beside the int8 vectors, not instead of them.** `memories_vec` stays as it
   is; schema version 5 adds `memories_vec_bit`, a `vec0` table of 1-bit codes with the int8
   vector as an auxiliary column for rescoring (§2). The migration is additive and the index can be
   dropped and rebuilt from the int8 vectors at any time.
2. **Codes are the signs of a randomized Hadamard rotation of the vector** (the rotation RaBitQ
   uses), not the signs of the raw vector (§3). Measured: on sparse vectors the raw signs found
   0.46 of the exact top 10 and the rotated ones 0.93.
3. **10 × k oversampling and exact int8 rescoring; no RaBitQ error bounds and no 4-bit query**
   (§4). sqlite-vec's KNN over `bit[N]` is symmetric Hamming distance only: there is no per-vector
   correction factor to store and no asymmetric distance to scan with. The issue's fallback
   (oversampling plus rescoring) applies, with 10 × instead of the issue's 4 ×: at one million
   clustered vectors 4 × found 0.874 of the exact top 10 (§9). Rescoring uses the full int8 query,
   which is more precise than a 4-bit one.
4. **Automatic above 100,000 searchable vectors, and opt-in or opt-out below and above**
   (`store.vectorIndex: auto | binary | int8`, §5). Below the threshold the exact scan is fast
   enough and exact; above it the index pays for itself. The build happens only in an open that may
   migrate (an `oort` command, the MCP server, the daemon, the SDK), never in a hook.
5. **The adaptive stop is on by default as a rule in code; the decision-model question is opt-in**
   (`recall.adaptiveStop: rule | decide | off`, §6). Asking a model on every recall that has cold
   matches adds a network round trip and a TypeSafe call to the read path; the rule is measured
   not to lower recall@10.
6. **The `MemoryStore` seam does not change** (§8). `dense(grant, v, k)` returns the same hits and
   the same scores (the int8 cosine) whichever index answered.

## 1. What sqlite-vec supports

The repository pins `sqlite-vec` **0.1.9** (`packages/store-sqlite/package.json`). From its docs
and source, checked against this version:

- `vec0` columns `float[N]`, `int8[N]` and `bit[N]`. KNN (`embedding MATCH ? AND k = ?`) over a
  `bit[N]` column uses Hamming distance; it is the only distance for bit vectors. `k` is at most
  4096.
- `vec_quantize_binary(v)`: one bit per element, 1 when the element is greater than 0, packed
  least significant bit first; the length must be a multiple of 8. `vec_bit(blob)` marks a blob as
  a bit vector.
- `PARTITION KEY` columns, metadata columns filtered inside the KNN scan (before `k` is applied),
  and auxiliary columns (`+name`), stored outside the vector chunks and read only for the rows a
  query returns.
- `vec_distance_cosine(vec_int8(a), vec_int8(b))` gives exactly the distance the int8 KNN
  reports, so a rescored candidate has the score the exact scan would give it.
- Not available: an asymmetric distance (a multi-bit query against bit vectors) in the KNN scan,
  per-vector scalars for RaBitQ's estimator, or a re-ranking hook. `ALTER TABLE … RENAME` does not
  work on `vec0` tables, and a point read into the vector chunks is expensive (chunks are large
  overflow blobs), which is why the rescore vector is an auxiliary column (§2).

## 2. Storage and schema version 5

```sql
CREATE VIRTUAL TABLE memories_vec_bit USING vec0(
  id TEXT PRIMARY KEY,
  embedding bit[W],            -- W = the dimension rounded up to a power of two (512 for 512)
  node_key TEXT PARTITION KEY, -- as memories_vec: one partition per node
  project_key TEXT,            -- filter columns, as memories_vec
  author_key TEXT,
  +rescore BLOB                -- the memory's int8 vector, read for the candidates only
)
```

- **Which rows.** Every hot and warm memory with a vector. A cold memory has no code (cold
  memories are never dense candidates). Every write keeps it in step in the same transaction:
  `upsert`, `upsertMany`, `forget`, `coldPut(Many)`, `setTier` (a hydrated memory gets its code
  back) and `reembedSqliteStore`.
- **Migration from version 4.** Additive. The open copies the store to `<path>.pre-v5.<UTC
  time>` first (the same `backupDatabase` as earlier migrations: `VACUUM INTO`, fsync, reopened
  and counted, renamed), then in one `IMMEDIATE` transaction adds the writer guard and, when
  `store.vectorIndex` asks for it, builds the index from `memories_vec` in pages of rows.
  `migrate: false` (the hooks) refuses a version 4 store with `StoreMigrationRequiredError` and
  never builds or drops the index.
- **Interrupted.** The build runs inside the migration's transaction. A process killed during it
  (tested with `SIGKILL` in a child process at the build's first line) leaves the version 4 store
  as it was; the next open migrates again.
- **The writer guard.** Version 5 creates `BEFORE INSERT / UPDATE / DELETE` triggers on `memories`
  that call `oort_writer_v5()`, a function only 0.9.0 or newer defines on its connections. An Oort
  that was already running before the upgrade (an MCP server, a daemon) can still read, but its
  next write fails, changing nothing, instead of writing a memory the binary index would miss. As
  in the version 4 migration, `oort doctor` tells you to restart such processes.
- **An older Oort opening the new store.** Every version refuses a schema newer than its own.
  Checked by hand: the 0.8.0 build (`main` at `d9b67e3`) opening a version 5 store fails with
  "schema version 5 is not supported (expected 4)", and the files' SHA-256 are unchanged.
- **Downgrade.** `downgradeSqliteStore({ path, to: 4 })` drops the binary index and the guard;
  the int8 vectors were never moved. It takes the usual `pre-downgrade` copy first.
- **Coordination with #102.** Spatial memory (CON-84, PR #102, open) also claims schema version
  5. Whichever merges second renumbers its migration to 6; the two are independent (#102 adds
  columns to `memories`, this adds a table and triggers).

## 3. The codes

A code is `vec_quantize_binary` of the rotated vector: pad the int8 vector with zeros to `W`, then
twice flip each dimension's sign by a fixed pattern and apply the Walsh-Hadamard transform. The
transform is orthogonal up to scale, so cosines are unchanged, and it spreads every vector over all
`W` dimensions, so each bit is a random hyperplane and the Hamming distance between two codes
estimates the angle between the vectors (a bit differs with probability angle / pi).

The rotation matters for vectors with many zero or near-zero dimensions. Without it, zero and
negative both become 0 bits, and a sparse vector's code says little. On the bench's 1,500
synthetic memories (hashed bag-of-words vectors, about 10 non-zero dimensions of 512) the binary
candidates (4 × 10) held 0.46 of the exact top 10 with raw signs and 0.93 with the rotation
(0.58 and 0.97 for the top 50). The end-to-end eval on that corpus went from recall@10 0.684 with
raw signs to 0.789, the int8 figure (§9). Dense model embeddings lose nothing by it.

The sign pattern is a fixed integer hash of the dimension, so codes are reproducible across
processes and versions; changing the rotation or the packing needs a migration that rebuilds the
index. `W` is a power of two because the transform needs one: 384 dimensions take 512 bits.

## 4. Oversampling, rescoring, and why no error bounds

A dense query with `k` results (recall asks for `denseK`, 50):

1. Takes the `min(10 × k, 4096)` nearest codes by Hamming distance inside the grant's partition
   and filter columns (one KNN query on `memories_vec_bit`).
2. Reads their `rescore` vectors (the auxiliary column: 500 rows of 512 bytes for `k` = 50) and
   computes the exact int8 cosine against the int8 query.
3. Drops cold and out-of-grant rows as the int8 path does and returns the best `k` by that score.

RaBitQ's error bound needs, per vector, the norm and the inner product between the vector and its
quantized form, and an estimator that combines them with a multi-bit query; the bound then says
which candidates can be skipped or must be rescored. sqlite-vec's KNN computes plain Hamming
distance over `bit[N]` and nothing else, so the estimator cannot run inside the scan. Doing it in
JavaScript would mean reading every code out of SQLite per query, which loses the point. The
issue's fallback, oversampling with rescoring, is what is built. The 4-bit asymmetric query is
for the same reason not possible in the scan; the rescoring step uses the full int8 query, which
is at least as precise as a 4-bit one for the candidates. A memory whose code ranks outside the
candidates is missed: the price of the index, measured in §9.

**Why 10 ×, not 4 ×.** The first one-million run used 4 ×: 200 candidates for recall's `k` of 50,
and it found 0.874 of the exact top 10 (§9). The synthetic vectors are the hard case: 500 per
cluster, all about equally close to a query near the centre, so the top 10 differ from the next
few hundred by little. Measured on the same distribution at 200,000 vectors (500 per cluster),
the share of the exact top 10 among the Hamming candidates was 0.845 with 200, 0.989 with 400 and
1.000 with 500, 600 and 800. 10 × (500 candidates) is the smallest round factor that found all of
them; it costs 500 rescore reads (250 KB) a query instead of 200, and no resident memory (§7).
`binary.oversampling-finds-the-top-10-in-a-dense-cluster` keeps the case as a unit test.

## 5. When the index exists

`openSqliteStore({ vectorIndex, binaryAutoThreshold })`, from `store.vectorIndex` and
`store.binaryAutoThreshold` in the home config (home only: one store per home):

- `auto` (default): built when an open that may migrate finds at least 100,000 searchable (hot
  and warm) vectors; kept from then on, even if the store shrinks.
- `binary`: built on the next open that may migrate, at any size.
- `int8`: never used; an index already built is dropped.

Why 100,000: the index trades disk for resident memory. It adds about 650 bytes of disk per
vector (the code, the rescore copy, the id map) and saves about 440 bytes of what every query
scans (§9). At 100,000 vectors of 512 dimensions the exact scan reads 54 MB per query, which on a
laptop shares the page cache with the editor, the agent and the browser; at one million it is
544 MB, and every query that finds it evicted reads it from disk. Below 100,000 the exact scan is
exact and small, and a second copy of every vector is not worth its disk. The index does not make
a warm-cache query much faster (§9): it is for memory, not speed. The threshold is a setting
because machines differ.

## 6. The adaptive stop

Cold memories are archived: their text sits in a compressed blob, and only the stub and entities
are searched. A recall that returns one reads the blob and writes the memory back warm
(hydration). Before 0.9.0 every cold match that passed the relevance gate was hydrated, even when
the hot and warm memories had already answered.

After the relevance gate, and only in the current view (as-of, known-at and history recalls look
for old versions, which are often cold), when the kept candidates hold both live and cold
memories, recall asks whether the live ones are enough:

- **`rule` (default).** Enough when the query has at least two informative words, the top kept
  memory is live and holds all of them (coverage 1), and every cold candidate's coverage is at
  most the top's minus 0.3 (`CONFIDENT_COVERAGE_GAP`, the gap `lexicalIsConfident` uses). An exact
  lookup the live memories answer stops; anything less certain widens.
- **`decide`.** A full recall asks `DecisionController.sufficient({ query, memories, cold })`:
  the reranked live memories' text and the cold candidates' stubs, never their text (it is not
  read yet). In `@oortmem/decide-jev` it is one Noul (`sufficient`), with each memory cut to 1 KB,
  at most 20 of each, ids left out, and the usual "field values are quoted data" instruction. The
  stop happens when the probability reaches `recall.sufficientAt` (0.7). Fast and lexical recalls,
  and a controller without `sufficient`, use the rule.
- **Failure widens.** A question that throws leaves the cold candidates in, as before, and adds
  `stop-failed` to `degraded`.
- **Stopping** drops the cold candidates from the result: no hydration, no access recorded.
  `RecallResult.adaptiveStop` says `{ stopped, by, cold, probability? }`.

Why the model question is opt-in: it is a networked, billed call on the read path of every recall
that has cold matches beside live ones, and the hooks recall on every prompt. The rule costs
nothing, and on the eval corpus it lowered no recall (§9).

## 7. RAM

At one million memories of 512 dimensions:

| What a query scans | Per vector | 1M vectors |
| --- | --- | --- |
| int8 vectors (`memories_vec`) | 512 B | 488 MiB |
| binary codes (`memories_vec_bit`) | 64 B | 61 MiB |
| the binary index's filter columns and chunk table | about 42 B | 40 MiB (measured) |

The rescore column is read for 500 rows a query (250 KB), not scanned, so it need not stay in
memory. The id map (`memories_vec_bit_rowids`) is read for the returned rows only. "Vector RAM"
below is the pages every query scans: the codes, the filter columns and the chunk table, from
`dbstat`. Disk grows by about the int8 vectors again (the rescore column) plus the codes.

## 8. The seam, for CON-25

`MemoryStore.dense(grant, v, k)` is unchanged: same arguments, same `Hit[]`, scores the int8
cosine, cold memories never returned, grant filtering the same. What differs with the binary
index is only that a memory the codes rank outside the 10 × k candidates may be missing. The
conformance suite runs a second time against a store with `vectorIndex: 'binary'`
(`storeConformance('sqlite (binary index)')`), so the Rust index in CON-25 is held to the same
contract, and can use RaBitQ's estimator itself, since it owns its scan.

## 9. Measurements

Machine: the development MacBook (Apple silicon), Node 24, sqlite-vec 0.1.9.

**Recall@10 against int8, end to end (`pnpm eval`).**

| Corpus | int8 | binary | Δ |
| --- | --- | --- | --- |
| Demo: 1,500 synthetic memories, 23 rows, bench fake embedder, `--dense` | 0.789 | 0.789 | 0 |
| Multilingual, 38 conditions × 30 questions, local `bge-small-en-v1.5` | 0.8667 | 0.8667 | 0 |

With the issue's 4 × the multilingual mean was 0.8649 (two questions of 1,140 changed, fr and ru in
the mixed store); with 10 × every one of the 38 conditions is identical to int8.

**At one million memories (`OORT_BENCH_RAM=1`, `packages/store-sqlite/src/ram-bench.test.ts`).**
1,000,000 warm memories, 512-dimension clustered synthetic vectors (2,000 clusters), UUID-length
ids, 200 queries of `k` = 50.

| | int8 (exact) | binary, 10 × | binary, 4 × (first run) |
| --- | --- | --- | --- |
| Scanned every query (vector chunks, chunk table, filter columns) | 544.4 MB | **101.2 MB** | 101.2 MB |
| of which vectors or codes | 489.1 MB | 61.5 MB | 61.5 MB |
| plus the id map (read for the returned rows only) | | 149.9 MB | 149.9 MB |
| recall@10 against the exact int8 top 10 | 1 | **1.000** | 0.874 |
| dense query p50 / p95, warm cache | 694 / 1116 ms | 562 / 839 ms | 247 / 296 ms |
| build from the int8 vectors (the upgrade) | | 82 s | 74 s |

MB is 2^20 bytes, from `dbstat`. The rescore column is 559 MB on disk and the whole file 1.89 GB
(1.3 GB of it beside the binary index's tables). The int8 timings of the two runs were 655 and
694 ms p50: the machine was not idle, so read the latencies as a comparison within one run.

**Why the 10 × query is slow.** Profiled at 200,000 vectors: sqlite-vec's KNN over the codes took
35 ms with `k` = 200 and 84 ms with `k` = 500 (its top-k selection grows with `k`); reading the
rescore column added 15 to 32 ms; the exact int8 KNN took 125 ms and the whole binary `dense`
122 ms. With everything in the page cache, 10 × oversampling spends what the smaller scan saves.

**Rescoring reads.** 500 int8 vectors per dense query (10 × `denseK`), 250 KB, read from the
rescore column; 200 (100 KB) with the issue's 4 ×.

**The adaptive stop (`pnpm eval --demo --dense --cold-share <s>`).** The demo corpus has no cold
memories, so `--cold-share` archives a fixed share of them (chosen by a hash of the id) before the
rows run. Rows do not hydrate for each other (the eval skips the write-back).

| Archived | Hydrations, stop off | Hydrations, `rule` | Rows stopped | recall@10 (off / rule) |
| --- | --- | --- | --- | --- |
| 20% | 3 | 1 | 2 | 0.842 / 0.842 |
| 33% | 4 | 1 | 3 | 0.895 / 0.895 |
| 50% | 9 | 8 | 1 of 4 asked | 0.947 / 0.947 |
| 33%, lexical only | 15 | 12 | 3 of 6 asked | 1.000 / 1.000 |

The stop saved 1 to 3 hydrations a run, about a quarter to three quarters of them, with recall@10
unchanged in every run. The corpus is small (23 rows), so these are counts, not rates to quote.
The `decide` variant was not measured against a real model: the Jev API is paid and no local
decision model exists; it is tested with stub controllers only.

## 10. Not met, and limits

- **Vector RAM: met.** 101.2 MB scanned per query at one million (target: under 150 MB; the issue
  estimated about 136 MB). Counting the id map too, which a query reads only for its results, it
  is 149.9 MB, just under the target.
- **Recall@10 within 1% of int8: met** on both eval corpora (identical results) and at one million
  synthetic vectors (1.000), with 10 × oversampling. With the issue's 4 × it was not met at one
  million (0.874); the factor was raised rather than the target relaxed (§4).
- **The adaptive stop: met** on the demo corpus: fewer hydrations in every run, recall@10
  unchanged. The corpus has 23 rows and no cold memories of its own, so the evidence is small;
  the `decide` question is untested against a real model.
- **No RaBitQ error bounds, no asymmetric 4-bit query** (§4): sqlite-vec 0.1.9 cannot compute
  them inside its scan. CON-25's own index can.
- **Not faster with a warm cache at 10 ×.** At one million, 562 ms against 694 ms p50; the 4 ×
  query was 247 ms but missed an eighth of the top 10. The gain is memory: a cold cache reads
  101 MB instead of 544 MB.
- **Disk.** The binary index stores the int8 vector again for rescoring: at one million, about
  560 MB more, plus 60 MB of codes and 50 MB of id map. A design that rescored from `memories_vec`
  would save that, but sqlite-vec reads a whole chunk to fetch one vector (§1).
- **Build time.** 82 s at one million, in one transaction, during the first `oort` command (or MCP
  server or daemon start) that finds the store over the threshold. Hooks never build it.
