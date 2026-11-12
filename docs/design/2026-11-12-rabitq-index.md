# The RaBitQ index: 1-bit codes with error bounds, bounded int8 rescoring

Date: 2026-11-12. Status: built (CON-25), ships in **0.9.0 or newer** beside the binary index of
[CON-17](2026-11-11-binary-quantization.md). Opt-in: `store.vectorIndex: rabitq`.

The binary index (CON-17) takes the 10 × k nearest 1-bit codes by Hamming distance and rescores
all of them with their int8 vectors: 500 reads for the default 50 dense candidates, whatever the
query. It has no error bounds because sqlite-vec's KNN over `bit[N]` has nowhere to put them
(its §4). This index owns its scan, so it can use RaBitQ's estimator: a 4-bit query against the
1-bit codes, a per-vector standard error, and a stop rule that rescores only the candidates whose
upper bound can still reach the top k. §11 has the measurements and §12 what was not met.

## 0. Decisions in brief

1. **The index lives in SQLite; the scan runs in memory** (§3). Codes and factors are rows in
   `memories_rq`, written in the same transaction as the memory. A process that searches loads
   them into an in-memory engine on its first dense query and keeps it current from a change
   counter. No sidecar file: one file to back up, copy, migrate and erase.
2. **A native engine in Rust (napi-rs), and the same engine in TypeScript** (§7). Both use the
   same double-precision arithmetic in the same order and return the same candidates, which a test
   checks bit for bit at five dimensions. The native binaries ship inside `@oortmem/store-sqlite`
   for macOS arm64 and Linux x64 and arm64 (glibc); everywhere else, or when the binary does not
   load, the TypeScript engine answers, `oort doctor` warns and says why.
3. **RaBitQ's estimator with a centroid, a 4-bit query and epsilon 1.9** (§4, §6). The code is
   the sign of the rotated residual against the index's centroid; three float32 factors per vector
   give the estimate and its standard error.
4. **Bounded rescoring with a read budget** (§4). Candidates are rescored best upper bound first,
   in batches, until the next upper bound is below the k-th exact score, or until 10 × k reads
   (the binary index's oversampling), whichever comes first. The budget is only reached where the
   k-th score sits in a flat stretch of near-equal scores; there the reads are those of the binary
   index, never more.
5. **Schema version 7, additive** (§2). A new writer guard, and the four `memories_rq*` tables
   when `vectorIndex: 'rabitq'` asks for them. No copy before the migration; `downgradeSqliteStore
   ({ to: 6 })` drops the tables and restores version 6's guard.
6. **Forget removes every trace in the same transaction** (§8): the code row, the rescore vector
   and the engine's slot (zeroed). What stays is the row id and a change number, for 100,000
   changes.

## 1. What RaBitQ adds

The binary index estimates the angle between query and vector from the Hamming distance between
two 1-bit codes. Both sides lose most of their information, and the estimate has no error bar, so
the only safe rule is a fixed, generous oversampling.

RaBitQ (Gao and Long, SIGMOD 2024) keeps the vector side at 1 bit but:

- quantizes the **query** to 4 bits per dimension instead of 1, so the inner product between the
  query and a code is nearly exact for that code;
- stores two **factors per vector** that turn that inner product into an unbiased estimate of the
  cosine;
- stores a third factor that gives the estimate's **standard error**, so every vector has an upper
  and a lower bound.

A vector whose upper bound is below the k-th best lower bound cannot be in the top k (up to the
bound's confidence), so it is never read. The rest are read in order of their upper bound until
the next one cannot beat the k-th exact score.

## 2. Storage and schema version 7

```sql
CREATE TABLE memories_rq (           -- one row per hot or warm memory with a vector
  rid INTEGER PRIMARY KEY,           -- memories.rid
  seq INTEGER NOT NULL,              -- the change number of its last write
  node_key TEXT NOT NULL,            -- as memories_vec: the node, project and author keys
  project_key TEXT,
  author_key TEXT,
  code BLOB NOT NULL,                -- W / 8 bytes (W the dimension rounded up to a power of two)
  factors BLOB NOT NULL              -- three float32: a, b, e (§4)
);
CREATE INDEX memories_rq_seq ON memories_rq (seq);
CREATE TABLE memories_rq_vec (rid INTEGER PRIMARY KEY, embedding BLOB NOT NULL); -- int8, rescoring
CREATE TABLE memories_rq_gone (seq INTEGER PRIMARY KEY, rid INTEGER NOT NULL);   -- removals
CREATE TABLE memories_rq_meta (key TEXT PRIMARY KEY, value);
  -- generation (random per build), seq, floor, width, built_from, centroid (float64 blob)
```

- **Which rows.** Every hot and warm memory with a vector, as the binary index. A cold memory has
  no row.
- **Migration from version 6.** One `IMMEDIATE` transaction swaps the writer guard's triggers
  from `oort_writer_v6()` to `oort_writer_v7()`, and builds the index when `store.vectorIndex` is
  `rabitq`. No copy is taken: version 7 only adds, and the downgrade loses nothing (CON-17's
  reasoning, its §2). Older stores go up through 5 and 6 in the same transaction, with only
  version 5's `pre-v5` copy. `migrate: false` (the hooks) refuses a version 6 store with
  `StoreMigrationRequiredError`, changing nothing.
- **The writer guard.** An Oort that predates the index (an MCP server started before the
  upgrade, on version 6) would write memories the index never hears of. The triggers now call
  `oort_writer_v7()`, which only this version defines, so its next write fails, changing nothing.
  `oort doctor` already says to restart such processes after a migration.
- **Interrupted.** The build runs inside the migration's transaction. Tested: a child process
  killed with `SIGKILL` at the build's first log line leaves the version 6 store as it was, and
  the next open migrates again.
- **Downgrade.** `downgradeSqliteStore({ path, to: 6 })` drops the four tables and puts version
  6's guard back; `to: 5` also drops the binary index and the guard, as before. Both take the
  usual `pre-downgrade` copy. An older Oort refuses a version 7 store without changing it.
- **One dense index at a time.** `rabitq` drops a binary index, and `binary` or `int8` drop a
  RaBitQ index. `auto` keeps whichever exists and never builds a RaBitQ index; it builds the
  binary one at 100,000 vectors only when there is no RaBitQ index.

## 3. Where the index lives

**In SQLite, in the same file.** The codes, factors and filter keys are ordinary rows, written by
the same statements and transactions that write `memories` and `memories_vec`. Nothing can be
half-written, a crash leaves both in step, `VACUUM INTO` backups and copies include it, and the
downgrade is a `DROP TABLE`. A sidecar file (a memory-mapped array, say) would need its own
locking, crash recovery, backup and erasure story, for a read path that is already in memory.

**In memory, per process, to search.** Scanning a million codes through SQLite's row machinery
would cost more than the scan itself. A process loads every row into an engine on its first dense
query (about 100 bytes a vector: the code, the factors, the row id and three small keys) and
then, at the start of each dense query, applies only what changed since:

- `memories_rq.seq` is a change counter, bumped by every write in the writing transaction;
  `memories_rq_meta.seq` holds the latest. A reader that has seen change `s` reads the rows with
  `seq > s` and the removals in `memories_rq_gone` with `seq > s`.
- `memories_rq_gone` keeps the last 100,000 removals (`RQ_GONE_WINDOW`); `floor` says where it
  starts. A reader further behind than that, or one that sees a new `generation` (the index was
  rebuilt), reloads the whole index.
- The writing process applies its own writes right after they commit, so its next query does not
  pay for them.

**Rescoring reads `memories_rq_vec`, not `memories_vec`.** A point read into sqlite-vec's
`memories_vec` reads a whole chunk of vectors, so rescoring 100 candidates would read 100 chunks.
`memories_rq_vec` is a plain table keyed by row id: one B-tree lookup per candidate. It doubles
the int8 vectors on disk, as the binary index's `rescore` column does.

**Filters.** The engine holds each vector's node, project and author keys (as small integers) and
an optional allowlist of row ids, and applies them before choosing candidates, so the grant
pattern, `project` scoping, the author filter and a spatial filter (`near`, `within`: the store
passes the row ids that match the place) all act before k. The rescoring query then applies the
grant, tier and spatial filters again in SQL, so a row the engine has not yet heard of being
forgotten or archived (another process's write between the refresh and the read) is never
returned.

## 4. The search

For a store of dimension `D`, `W` is `D` rounded up to a power of two, and `R` the randomized
Hadamard rotation of the binary index (its §3), made orthonormal.

**Build.** The centroid `c` is the mean of the int8 vectors at build time. Each vector `v` gets
`r = R v - R c`, its code `sign(r)` (W bits), and three factors:

- `a = |r| / (|v| f)` and `b = 1 / |v|`, where `f = sum(|r_i|) / (sqrt(W) |r|)` is how well the
  code's direction matches `r`;
- `e = (|r| / |v|) sqrt((1 - f²) / f²) / sqrt(W - 1)`, the estimate's standard error per unit
  of query.

**Query.** The query `q` is rotated and scaled to unit length, `q' = R q / |q|`, then quantized to
4 bits per dimension between its minimum and maximum. `cq = <q', R c>` is computed once.

**Estimate.** For each vector, `ip` is the inner product of the 4-bit query and the ±1 code
(four popcounts per 64 dimensions), and the cosine estimate is `cq b + a ip`. Its standard error is
`sqrt(e² + (a delta)² pop / (3W))`, the second term being the query's own quantization error
(`delta` its step, `pop` the code's number of 1 bits). The bounds are the estimate plus or minus
`RABITQ_EPSILON` (1.9) standard errors.

**Candidates.** Every vector that passes the filters and whose upper bound reaches the k-th
largest lower bound, sorted by upper bound (ties by row id).

**Rescoring.** The store reads the candidates' int8 vectors in batches (the first k, then 16 at a
time), computes the exact cosine in SQL, and stops when the next candidate's upper bound is below
the current k-th exact cosine (less 1e-6, for float32 against float64). The result is the int8
path's result, with the int8 path's scores, unless the true top k held a vector whose estimate
was more than 1.9 standard errors too low.

**The read budget.** At most `RABITQ_MAX_READS_PER_K` × k reads, 10 × k, the binary index's
oversampling. Without it, the stop rule reads every candidate whose upper bound reaches the k-th
exact score, and in a flat tail there are thousands. Measured at 20,000 clustered vectors (2,000
clusters of 10, `k` = 50): the 50th hit is any of thousands of vectors from other clusters with
nearly the same score, and the bound alone read 1,406 vectors a query on average (p95 3,526, max
4,508), three times the binary index's 500. With the budget it reads at most what the binary index
reads, and the candidates it reads are the best by upper bound, so the top of the list, where the
bound separates well, is unaffected. `onDenseStats` reports `capped: true` for such a query;
§11 has how often it happened.

This is a choice, not a free lunch. In a flat tail a capped query can miss a true top-k member
that the binary index's Hamming order would also have had to find among 500; the recall at one
million is measured in §11 against the binary index.

## 5. Keeping it in step

Every path that writes a vector, or changes whether a memory is searchable, writes the index in
the same transaction:

| Path | `memories_rq` | `memories_rq_vec` | `memories_rq_gone` |
| --- | --- | --- | --- |
| `upsert`, `upsertMany` (hot or warm, with a vector) | written, new `seq` | written | |
| `upsert` of a cold memory, `coldPut`, `coldPutMany` | deleted | deleted | rid, new `seq` |
| `setTier` to cold | deleted | deleted | rid, new `seq` |
| `setTier` from cold (hydration) | written from the stored vector | written | |
| `forget` | deleted | deleted | rid, new `seq` |
| `reembedSqliteStore` | rewritten per batch, in its transaction | rewritten | |
| `expireMany` | through `forget` | | |

**Other processes.** A second process (the MCP server beside an `oort` command, the hooks) sees
the change on its next dense query, through the change counter (§3). A test writes, forgets and
rebuilds through one handle and searches through another, which must agree with a fresh handle.

**Reembedding.** The new model's vectors are encoded against the old centroid. Any centroid gives
correct bounds (the estimate is unbiased whatever `c` is); a poor one gives wider bounds and so
more reads. `reembedSqliteStore` looks for the index in each batch's transaction, so an index
another process builds during a long reembed gets the new model's vectors. Switching
`vectorIndex` away and back rebuilds it with a centroid of the new model's vectors.

**Recentring.** A store created empty with `vectorIndex: 'rabitq'` would keep a zero centroid for
good, and grow into looser bounds. The index records how many vectors it was built from
(`built_from`); once the store holds 4 times as many and at least 1,000 (`RABITQ_RECENTRE_GROWTH`,
`RABITQ_RECENTRE_FROM`), the next open that may migrate rebuilds it with a new centroid. The
growth is geometric, so a store that grows to n vectors pays for about n / 3 extra encodings in
all. Measured on the multilingual eval (§11): built on the empty stores, 93.0 reads a query;
built after seeding, 60.0.

## 6. The bound's confidence

`RABITQ_EPSILON` is 1.9, the paper's default. The estimate's error, divided by its standard
error, is close to a standard normal: on 3,000 clustered 384-dimension vectors and 20 queries
(`rabitq.estimate-error-matches-its-standard-error`), about 6% of estimates fall beyond 1.9
standard errors on either side and under 0.6% beyond 3. A miss needs a true top-k vector whose
estimate is too low by more than 1.9 standard errors (about 3%, one side) and whose upper bound
then also falls below the k-th exact score, which most such vectors still reach. Measured on the
synthetic and eval corpora, recall@10 against the exact scan was 1.000 (§11).

A lower epsilon reads fewer vectors and misses more. Measured on 100,000 synthetic vectors in
2,000 clusters during the design (`k` = 10, without the budget): epsilon 1.9 read 402 vectors a
query with recall@10 1.000; 1.5 read 342 with 0.996.

## 7. The two engines

**Native (`packages/store-sqlite/native`, Rust, napi-rs 3).** The scan is four `popcount`s per
64 dimensions per vector, in a flat array of `u64` codes and `f32` factors, with filters checked
first. Built as a Node addon behind a `node` cargo feature, so `cargo test` runs without Node.
Dependencies: `napi` 3.15.0, `napi-derive` 3.6.13 and `napi-build` 2.6.0, pinned exactly, with
`syn` held at 3.0.9 in `Cargo.lock` (3.0.10 was published under two weeks before this work).

**TypeScript (`TsRabitqIndex`).** The reference engine, in the same arithmetic. It is the
fallback and the check: `rabitq.native-and-typescript-return-the-same-candidates` compares both
engines' candidate lists and upper bounds exactly, at 8, 100, 384, 512 and 1,024 dimensions, with
filters, allowlists and removals.

**Which one runs.** `loadNativeRabitq()` looks for `native/oort-rabitq.<tag>.node` beside the
package's `dist/`, where `<tag>` is `darwin-arm64`, `linux-x64-gnu` or `linux-arm64-gnu` (musl
Linux, Windows and Intel macOS have no binary). When it is missing, fails to load, or
`OORT_RABITQ_NATIVE=0` is set, the store uses the TypeScript engine and:

- an `oort` command, the MCP server or the SDK prints one line on stderr, once per process:
  "oort store: the native RaBitQ engine is unavailable (...); dense search uses the TypeScript
  engine". The hooks stay quiet;
- `oort doctor` shows `vector-index` as a warning naming the reason, with the fix: reinstall on a
  supported platform, or set `store.vectorIndex` to `binary`.

Results are the same either way; only the scan's speed differs (§11).

**Packaging.** The binaries ship inside `@oortmem/store-sqlite` (`files` includes
`native/oort-rabitq.*.node`), so there is no new npm package and no install script. The release
workflow builds one per platform on a runner of that platform (`macos-14`, `ubuntu-22.04`,
`ubuntu-22.04-arm`, so glibc 2.35 or newer), from source with the pinned toolchain
(`rust-toolchain.toml`) and `cargo build --locked`, uploads them as artifacts, and the publish job
downloads all three before packing and refuses to pack without them. CI runs the Rust tests,
builds the Linux x64 binary and runs `pnpm verify` with `OORT_REQUIRE_NATIVE=1`, so a binary that
does not build or load fails CI instead of falling back silently.

## 8. Forget and erasure

`forget` deletes the memory's `memories_rq` row (code, factors, keys) and its `memories_rq_vec`
row (the int8 vector) in the same transaction that deletes the memory. Each process's engine
removes the slot on its next refresh, and the writing process at once; removal overwrites the
slot with the last one and zeroes the vacated slot, and `clear` (index dropped, store closed)
zeroes the whole engine. `memories_rq_gone` keeps the removed row id and a change number, two
integers, for the last 100,000 changes: no text, vector, code, key or memory id. A test reads
every table after a forget and finds nothing but those two integers
(`rabitq.forget-leaves-no-residue`).

As for every other table of the store, SQLite reuses the freed pages rather than overwriting them
at once; the store does not set `secure_delete` today for any table, so this index neither adds
nor removes that gap. Dropping the index (`vectorIndex: int8` or `binary`, or the downgrade)
drops the tables.

## 9. Configuration

`store.vectorIndex` in `~/.oort/config.json` takes `rabitq` beside `auto`, `int8` and `binary`
(`openSqliteStore({ vectorIndex: 'rabitq' })` for the store itself). It is read from the home
config only, as for CON-17: a repository's `oort.config.json` cannot set it. The build happens in
an open that may migrate (an `oort` command, the MCP server, the daemon, the SDK), prints
"Building the RaBitQ vector index (N vectors)…", and is safe to interrupt. Hooks never build or
drop it. `rabitqEngine: 'native' | 'typescript'` on `openSqliteStore` forces an engine (tests and
benchmarks); `onDenseStats` reports each dense query's index, candidates, reads and whether the
budget stopped it.

`auto` does not choose RaBitQ, for now: the TypeScript fallback is slower to scan than sqlite-vec
on platforms without a binary, and the index is new. Making it the `auto` choice above the
threshold, where a binary exists, is a follow-up once it has run in the field.

## 10. The seam

`MemoryStore.dense(grant, v, k, filter)` is unchanged: same arguments, same `Hit[]`, scores the
int8 cosine, cold memories never returned, grants and the spatial filter the same. The
conformance suites run against a store with `vectorIndex: 'rabitq'` twice, once per engine
(`storeConformance('sqlite (rabitq index, native)')`, `... typescript`, and the same for
`spatialConformance`), unchanged.

## 11. Measurements

Machine: the development MacBook (Apple silicon), Node 24, sqlite-vec 0.1.9, release build of the
native engine. "Reads" are int8 vectors read to rescore, per dense query.

**Recall@10 and rescoring reads, end to end (`pnpm eval`).**

| Corpus | int8 | binary | rabitq | binary reads | rabitq reads | fewer |
| --- | --- | --- | --- | --- | --- | --- |
| Demo: 1,500 synthetic memories, 23 rows, `--dense` | 0.789 | 0.789 | 0.789 | 250 | 115.5 | 53.8% |
| Multilingual, mixed store: 13 languages × 60 facts and 1,500 distractors | 0.9795 | 0.9795 | 0.9795 | 250 | 119.6 | 52.2% |
| Multilingual, all 38 conditions, local `bge-small-en-v1.5` | 0.8667 | 0.8667 | 0.8667 | 105.2 | 60.0 | 43.0% |

Recall is identical to int8 in every one of the 38 multilingual conditions and on the demo, so
the RaBitQ index keeps 100% of the exact scan's recall@10 there. Reads are averaged over every
`store.dense` call the recalls make. A recall makes one per level, and the eval's Star is empty,
so half the calls read nothing for either index: the binary index's 250 is 500 (10 × `denseK`
50) on the calls that search the Planet, and the RaBitQ figures halve the same way. In the
"all conditions" row most stores are one language's 60 memories, where the binary index reads
every vector (60, under its 500) and the bound has little left to skip; the two corpora whose
stores are larger than 10 × k are the first two rows, and there the target is met.

**At one million memories (`OORT_BENCH_RAM=1`).** RAM1M_TABLE

## 12. Not met, and limits

NOT_MET
