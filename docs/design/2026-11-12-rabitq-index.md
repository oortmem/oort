# The RaBitQ index: 1-bit codes with error bounds, bounded int8 rescoring

Date: 2026-11-12. Status: built (CON-25), ships in **0.10.0 or newer** beside the binary index of
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
7. **The build commits in batches and resumes; nothing rebuilds by itself** (§2, §5). The
   migration only creates the tables and the centroid; the same open then indexes 10,000 vectors
   per committed transaction, and a stopped build is finished by the next `oort` command.
   Recentring a store that has outgrown its centroid is an explicit `oort reindex`, which `oort
   doctor` suggests; no open, `auto` included, rebuilds the index.
8. **A short-lived process does not load a large engine** (§9). The in-process hooks load at most
   50,000 vectors; above that they scan int8 exactly, and `oort doctor` suggests `oort serve
   --detach`, whose engine stays loaded.

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
  project_key TEXT NOT NULL,
  author_key TEXT NOT NULL,
  code BLOB NOT NULL,                -- W / 8 bytes (W the dimension rounded up to a power of two)
  factors BLOB NOT NULL              -- three float32: a, b, e (§4)
);
CREATE INDEX memories_rq_by_seq ON memories_rq (seq);
CREATE TABLE memories_rq_vec (rid INTEGER PRIMARY KEY, embedding BLOB NOT NULL); -- int8, rescoring
CREATE TABLE memories_rq_gone (seq INTEGER PRIMARY KEY, rid INTEGER NOT NULL);   -- removals
CREATE TABLE memories_rq_meta (key TEXT PRIMARY KEY, value);
  -- generation (random per build), seq, floor, width, built_from, centroid (float64 blob),
  -- and while a build runs: state ('building') and cursor (the last memories.rid indexed)
```

- **Which rows.** Every hot and warm memory with a vector, as the binary index. A cold memory has
  no row, and neither does a vector with no direction (all zeros): its factors divide by its
  length, so its bounds would be infinite and it would be rescored first for every query, where
  `vec_distance_cosine` returns NULL. A query with no direction gets no neighbours from this
  index, and a rescored row whose distance is not a number is dropped.
- **Migration from version 6.** One `IMMEDIATE` transaction swaps the writer guard's triggers
  from `oort_writer_v6()` to `oort_writer_v7()`, and starts the index when `store.vectorIndex` is
  `rabitq`: the tables, and the centroid from a sample of up to 20,000 vectors spread over the
  row ids (`RABITQ_CENTROID_SAMPLE`; any centroid gives correct bounds, and a sample this size
  bounds as tightly as the full mean). No copy is taken: version 7 only adds, and the downgrade loses nothing (CON-17's
  reasoning, its §2). Older stores go up through 5 and 6 in the same transaction, with only
  version 5's `pre-v5` copy. `migrate: false` (the hooks) refuses a version 6 store with
  `StoreMigrationRequiredError`, changing nothing.
- **The writer guard.** An Oort that predates the index (an MCP server started before the
  upgrade, on version 6) would write memories the index never hears of. The triggers now call
  `oort_writer_v7()`, which only this version defines, so its next write fails, changing nothing.
  `oort doctor` already says to restart such processes after a migration.
- **The build, in batches.** After the migration commits, the same open indexes the hot and warm
  vectors in row id order, 10,000 per `IMMEDIATE` transaction (`RABITQ_BUILD_BATCH`), recording
  the last row id done (`cursor`). Other writers wait one batch at most, not the whole build.
  While `state` is `building`, every handle's dense search scans int8 exactly, and writes keep
  the partial index in step as usual (`INSERT OR IGNORE`, so a row a writer indexed first, with a
  newer change number, is kept). The last transaction records `built_from` and a new
  `generation`, and removes `state` and `cursor`, so every process's engine loads the finished
  index whole. Two processes running the build at once each check `state` inside their
  transaction, so the second does nothing more once the first finishes.
- **Interrupted.** Tested: a child process killed with `SIGKILL` at the build's first log line
  leaves a version 7 store with the index started and no vectors indexed; a `migrate: false` open
  reads it exactly as the version 6 copy (dense search scans int8), and the next open that may
  migrate finishes the build. A test that commits one batch of 100, then opens with `migrate:
  false` (int8 search; its write is indexed), then with a migrating open (finished, the RaBitQ
  index answers) covers the resume.
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
query (about 110 bytes a vector at 512 dimensions: the code, the factors, the row id and three small keys) and
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
the change on its next dense query, through the change counter (§3), and every 30 seconds while
its engine is loaded (`rabitqRefreshMs`, an unreferenced timer stopped on close), so a memory
forgotten elsewhere leaves a long-lived server's memory without waiting for a search. The timer
holds the handle only through a `WeakRef` and stops once the handle is gone, so an SDK handle
dropped without `close()` is still collected; its engine is then zeroed and freed (tested with a
forced garbage collection). A refresh
that fails half-way (a row that does not fit, say) clears the engine and forgets its position, so
the next refresh loads the index whole rather than build on a partial copy. A test writes, forgets and
rebuilds through one handle and searches through another, which must agree with a fresh handle.

**Reembedding.** The new model's vectors are encoded against the old centroid. Any centroid gives
correct bounds (the estimate is unbiased whatever `c` is); a poor one gives wider bounds and so
more reads. `reembedSqliteStore` looks for the index in each batch's transaction, so an index
another process builds during a long reembed gets the new model's vectors. Switching
`vectorIndex` away and back rebuilds it with a centroid of the new model's vectors.

**Recentring.** A store created empty with `vectorIndex: 'rabitq'` would keep a zero centroid for
good, and grow into looser bounds. The index records how many vectors it was built from
(`built_from`); once the store holds 4 times as many and at least 1,000 (`RABITQ_RECENTRE_GROWTH`,
`RABITQ_RECENTRE_FROM`), the centroid is due to be renewed. Measured on the multilingual eval
(§11): built on the empty stores, 93.0 reads a query; built after seeding, 60.0.

No open does it. A rebuild reads every vector (minutes at a million), and an open that may
migrate is any `oort` command, the MCP server or the SDK: doing it there would stall whichever
of them happened to open the store first. Instead `sqliteVectorIndex` reports `recentreDue`,
`oort doctor` shows it as a note with the fix `oort reindex`, and `oort reindex`
(`reindexSqliteStore`) starts the build again with a new centroid and runs it in the same
committed batches; searches scan int8 until it finishes, and a stopped run is finished by the next
`oort` command. Done each time it is due, the growth is geometric, so a store that grows to n
vectors pays for about n / 3 extra encodings in all.

## 6. The bound's confidence

`RABITQ_EPSILON` is 1.9, the paper's default. The estimate's error, divided by its standard
error, is close to a standard normal: on 3,000 clustered 384-dimension vectors and 20 queries
(`rabitq.estimate-error-matches-its-standard-error`), about 6% of estimates fall beyond 1.9
standard errors on either side and under 0.6% beyond 3. A miss needs a true top-k vector whose
estimate is too low by more than 1.9 standard errors (about 3%, one side) and whose upper bound
then also falls below the k-th exact score, which most such vectors still reach. Measured on the
eval corpora the results were the exact scan's, and at one million synthetic vectors recall@10
was 0.999 (§11).

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

**Panics.** The release profile unwinds (`panic = "unwind"`) and every exported method is
`#[napi(catch_unwind)]`, so a panic in the engine becomes a JavaScript error on that call rather
than aborting the process (an MCP server or the daemon). Growing the code and factor arrays
copies them into a new allocation and zeroes the old one first, in both engines, so a moved code
is not left behind in freed memory.

**Packaging.** The binaries ship inside `@oortmem/store-sqlite` (`files` includes
`native/oort-rabitq.*.node`), so there is no new npm package and no install script. The release
workflow builds one per platform from source with the pinned toolchain (`rust-toolchain.toml`;
each build job prints `rustc --version` and fails if it differs) and `--locked`: Linux on a runner of that platform (`ubuntu-22.04`, `ubuntu-22.04-arm`, so glibc
2.35 or newer), macOS arm64 cross-compiled on `ubuntu-22.04` with cargo-zigbuild. Each Linux job
loads the binary it built and runs the engine and index test files with `OORT_REQUIRE_NATIVE=1`
(the store's RaBitQ conformance included); every build job writes a SHA-256 beside its binary.
The macOS job checks, before upload, that the binary's page hashes match its code signature
(`scripts/check-macho-signature.mjs`) and that it exports `napi_register_module_v1`. A `macos-15`
job runs the same test files on the cross-built macOS binary after the build, but publishing
does not wait for it, so a release never waits for a hosted macOS runner. A separate
job, which checks out nothing and runs no project code, downloads the three, checks their
hashes and attests their build provenance
(`actions/attest-build-provenance`, pinned by commit); only it holds `id-token: write` and
`attestations: write`, so the build jobs, which run the dependencies' build scripts, never hold
the token that signs. The publish job downloads all three, checks each hash (transit integrity)
and runs `gh attestation verify` on each against this repository, this workflow and the tag's ref
(provenance), and refuses to pack without them. CI runs the Rust tests,
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
(`rabitq.forget-leaves-no-code-vector-or-id-and-the-engine-drops-it`).

As for every other table of the store, SQLite reuses the freed pages rather than overwriting them
at once; the store does not set `secure_delete` today for any table, so this index neither adds
nor removes that gap. Dropping the index (`vectorIndex: int8` or `binary`, or the downgrade)
drops the tables.

## 9. Configuration

`store.vectorIndex` in `~/.oort/config.json` takes `rabitq` beside `auto`, `int8` and `binary`
(`openSqliteStore({ vectorIndex: 'rabitq' })` for the store itself). It is read from the home
config only, as for CON-17: a repository's `oort.config.json` cannot set it. The build happens in
an open that may migrate (an `oort` command, the MCP server, the SDK), prints "Building the
RaBitQ vector index (N vectors)…", commits in batches and is safe to interrupt. How much of it an
open runs before it returns (`rabitqBuildBatches`):

- **`oort` commands** finish it, `oort reindex` included.
- **The MCP server and the SDK** commit at most two batches (`HOST_RABITQ_BUILD_BATCHES`, 20,000
  vectors), then serve, scanning int8 until the build is done. A host starts an MCP server with a
  deadline, and finishing a million-vector build there would fail its startup, and the retry,
  each time.
- **`oort doctor`** commits none: it says the build is unfinished, with the fix `oort reindex`.
- **The hooks and `oort serve`** open with `migrate: false`, and never build, go on with a build,
  rebuild or drop it.

A build with nothing left to index is marked done whatever the budget. `oort reindex` also renews
the centroid when `oort doctor` says it is due (§5); run on a build that was left unfinished, it
finishes that build rather than start another.

**Hooks and large indexes.** A hook runs in its own process once per prompt; loading the engine
costs about 5.8 µs a vector natively and 13.7 µs in TypeScript, plus the transient RSS (§11: 5.8 s
and 289 MB at a million). `rabitqMaxLoad` caps what a handle loads; the CLI's in-process hooks
pass `HOOK_RABITQ_MAX_LOAD`, 50,000, which costs about 0.3 s natively and 0.7 s in TypeScript,
on the order of a hook's other work. Above it the hook's dense search scans int8 exactly (a store
with a RaBitQ index has no binary one), which at 50,000 is tens of milliseconds and grows
linearly. Hooks that go through `oort serve` use the daemon's engine, loaded once. `oort doctor`
warns (`vector-index-hooks`) when the index holds more than 50,000 vectors and the daemon is not
running, with the fix `oort serve --detach`. `rabitqEngine: 'native' | 'typescript'` on `openSqliteStore` forces an engine (tests and
benchmarks); `onDenseStats` reports each dense query's index, candidates, reads and whether the
budget stopped it.

`auto` does not choose RaBitQ, for now. The index is new; it holds about 110 MB per process at
one million where the binary index shares the page cache; its build takes longer (§11); and on a
platform without a binary its TypeScript scan is only about as fast as the binary index. Making it
the `auto` choice above the threshold, where a binary exists, is a follow-up once it has run in
the field.

## 10. The seam

`MemoryStore.dense(grant, v, k, filter)` is unchanged: same arguments, same `Hit[]`, scores the
int8 cosine, cold memories never returned, grants and the spatial filter the same. The
conformance suites run against a store with `vectorIndex: 'rabitq'` twice, once per engine
(`storeConformance('sqlite (rabitq index, native)')`, `... typescript`, and the same for
`spatialConformance`), unchanged.

## 11. Measurements

Machine: the development MacBook (Apple silicon), Node 26, sqlite-vec 0.1.9, release build of the
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

**At one million memories (`OORT_BENCH_RAM=1`).** 1,000,000 warm memories, 512-dimension clustered synthetic vectors (2,000 clusters), 200 queries of
`k` = 50, the same file and queries for every index (`packages/store-sqlite/src/ram-bench.test.ts`;
the RaBitQ index is built on the file after the binary one is measured, which drops it).

| | int8 (exact) | binary, 10 × | rabitq, native | rabitq, TypeScript |
| --- | --- | --- | --- | --- |
| recall@10 against the exact int8 top 10 | 1 | 1.000 | **0.999** | 0.999 (same ids as native) |
| rescoring reads per query: mean / p50 / p95 / max | | 500 | **199 / 304 / 443 / 482** | same |
| queries stopped by the read budget | | | 0 of 200 | |
| dense query p50 / p95, warm | 757 / 1275 ms | 766 / 2043 ms | **103 / 295 ms** | 725 / 2171 ms |
| memory the query scans | 544.4 MB of pages | 101.2 MB of pages (149.9 MB with the id map) | **111.8 MB resident engine** | same |
| loading the engine (first dense query of a process) | | | 5.8 s, RSS +289 MB while loading | 13.7 s |
| on disk | | 61.5 MB codes, 559.4 MB rescore column | 132.2 MB codes and keys, 559.4 MB `memories_rq_vec` | |
| build from the int8 vectors | | 134 s | 658 s | |

- **Reads: 60% fewer** than the binary index at one million (199 against 500 a query on average),
  and never more: the budget never had to stop a query. The mean is under the median: a large share of
  queries stop well under 200 reads, where the bounds separate the top 50 early, and the rest
  need 300 to 480.
- **Latency.** The native scan of a million codes plus about 200 point reads took 103 ms at the
  median, against 766 ms for the binary index and 757 ms for the exact scan, with everything in
  the page cache. The machine was not idle (the int8 timings were 694 ms in CON-17's run and 757
  ms here), so read these as a comparison within one run. The TypeScript engine is about as fast
  as the binary index (725 ms).
- **RAM.** The engine keeps 111.8 MB resident (codes 64 bytes, factors 12, row id and three keys
  16, the row id map and spare capacity the rest), about what the binary index's query scans from
  the page cache (101.2 MB), and it is held once per process that searches rather than shared
  through the page cache. Loading it reads every `memories_rq` row once; the process's RSS rose
  289 MB during the load, a transient of reading the rows on top of the engine itself.
- **Build.** 658 s at one million in this run, against 134 s for the binary index. The build is
  two passes over `memories_vec` and writes 690 MB in one transaction; at 100,000 vectors it took
  5.9 s and at 400,000 25 s (binary: 7.0 s and 17.9 s), so the one-million figure is mostly the
  machine running out of page cache for a 1.9 GB file inside one transaction, not the encoding
  (15 µs a vector). This was the first, single-transaction build; the build now commits in
  batches of 10,000 and reads `memories_vec` once plus a 20,000-vector sample (§2). It has not
  been re-timed at one million (the machine was too loaded during the review fixes for a timing
  to mean anything).

At 20,000 vectors in 2,000 clusters of 10 (`OORT_BENCH_RAM_N=20000`), the flat-tail case of §4,
the bound alone read 1,406 vectors a query on average; this run predates the budget, which now
stops those queries at 500.

## 12. Not met, and limits

- **Recall: met.** 99.5% of the reference's recall@10 was the target. On both eval corpora the
  RaBitQ index returned exactly the int8 scan's results (100%, all 38 multilingual conditions and
  the demo); at one million synthetic vectors 0.999 of the exact top 10. The reference is the
  exact int8 scan: the store keeps int8 vectors only, so there is no float32 path to compare with,
  and CON-17 measured against the same reference.
- **Reads, more than 50% fewer than the binary index: met where the binary index reads its full
  10 × k.** 53.8% fewer on the demo corpus, 52.2% on the multilingual mixed store, 60.2% at one
  million. Over all 38 multilingual conditions it is 43.0%: most of those stores hold 60 memories,
  fewer than 10 × k, so the binary index reads the whole store and neither index can skip much.
  The target is not relaxed; that row is reported as it is.
- **Prebuilt binaries: built in the release workflow, not yet published.** The workflow builds
  macOS arm64 (cross-compiled on Linux), Linux x64 and Linux arm64 from source and refuses to pack
  without all three. Only the macOS arm64 binary has been built and tested so far (locally); the
  Linux ones are first built by CI on the pull request (x64) and by the next release (both).
- **The TypeScript path: kept,** with the same results, as the fallback and the reference.
- **Build time.** 658 s at one million, measured with the first, single-transaction build. The
  build now commits every 10,000 vectors, so other writers wait one batch, not the build, and it
  resumes after a stop; its total time at one million has not been re-measured. It runs only when
  someone sets `vectorIndex: rabitq`, or runs `oort reindex`.
- **Hooks above 50,000 vectors** scan int8 exactly instead of loading the engine (§9), unless
  `oort serve` runs. Their dense search is then as slow as `int8` (757 ms at a million).
- **Zero vectors** are not indexed (§2). A memory whose vector is all zeros has no direction and
  no cosine with anything; the int8 and binary paths have the same bug, fixed separately (CON-141).
- **RAM per process.** Each process that runs dense queries holds its own engine (111.8 MB at
  one million). Two processes (an MCP server and an `oort` command) hold two copies; the page
  cache the binary index uses is shared. Memory-mapping a shared copy would need a sidecar file,
  which this design avoids (§3).
- **Erasure inside SQLite's free pages** is as for the rest of the store (§8).
- **`auto` does not pick it** (§9).
