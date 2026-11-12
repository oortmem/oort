/**
 * The binary (CON-17) and RaBitQ (CON-25) vector indexes at scale: opt-in, never in CI. Run it with
 *
 *   OORT_BENCH_RAM=1 pnpm vitest run packages/store-sqlite/src/ram-bench.test.ts
 *
 * (`OORT_BENCH_RAM_N` sets the size, default 1,000,000; the store takes about 3 GB of disk). It
 * seeds a store of N warm memories with 512-dimension clustered vectors, builds the binary index
 * the way an upgrade does, and reports:
 * - vector RAM: the pages a binary query scans every time (the bit index's chunks, ids and
 *   filter columns), against the int8 chunks an exact query scans; read from `dbstat`;
 * - the rescoring reads per query (10 × k int8 vectors) and their bytes;
 * - recall@10 of the binary path against the exact int8 path, and both latencies;
 * - the time the build took;
 * then the same for the RaBitQ index (built on the same file, which drops the binary one): the
 * engine's resident bytes, the rescoring reads it needed per query, its recall@10 and latency
 * (native, and the TypeScript fallback), and the time the first query took to load the engine.
 * The numbers are written to `$OORT_BENCH_RAM_OUT` when set (JSON) and printed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { localGrant } from '@oortmem/core';
import { makeMemory } from '@oortmem/core/store-conformance';
import { openSqliteStore, type DenseStats } from './index.js';

const RUN = process.env['OORT_BENCH_RAM'] === '1';
const N = Number(process.env['OORT_BENCH_RAM_N'] ?? 1_000_000);
const DIM = 512;
const CLUSTERS = 2_000;
const QUERIES = 200;
const K = 50; // recall's denseK default
const grant = localGrant({
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
});

let seed = 17;
function uniform(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function gaussian(): number {
  return Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
}
const centers = Array.from({ length: CLUSTERS }, () =>
  Float64Array.from({ length: DIM }, gaussian),
);
/** A point near a random cluster centre (cosine about 0.7 to it), L2-normalised to int8. */
function point(): Int8Array {
  const c = centers[Math.floor(uniform() * CLUSTERS)]!;
  const v = Float64Array.from(c, (x) => x + gaussian());
  let n = 0;
  for (const x of v) n += x * x;
  const s = 127 / Math.sqrt(n);
  return Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * s))));
}

/** A UUID-shaped id (36 characters, as the store's ids are) for memory `n`. */
function uuidOf(n: number): string {
  const h = (x: number) => (Math.imul(n + 1, x) >>> 0).toString(16).padStart(8, '0');
  const s = `${h(0x9e3779b1)}${h(0x85ebca6b)}${h(0xc2b2ae35)}${h(0x27d4eb2f)}`;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

const root = RUN ? fs.mkdtempSync(path.join(os.tmpdir(), 'oort-ram-bench-')) : '';
afterAll(() => {
  if (RUN) fs.rmSync(root, { recursive: true, force: true });
});

const pct = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
const mb = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

describe.runIf(RUN)('binary index at scale (opt-in: OORT_BENCH_RAM=1)', () => {
  it(
    `ram.${N}-memories`,
    async () => {
      const dbPath = path.join(root, 'oort.sqlite');
      const opts = {
        path: dbPath,
        coldDir: path.join(root, 'cold'),
        dimension: DIM,
        log: () => {},
      };
      const seedStart = performance.now();
      const store = await openSqliteStore({ ...opts, vectorIndex: 'int8' });
      const at = '2026-01-01T00:00:00.000Z';
      for (let i = 0; i < N; i += 5_000) {
        const batch = Array.from({ length: Math.min(5_000, N - i) }, (_, j) =>
          makeMemory({
            id: uuidOf(i + j),
            text: `synthetic memory ${i + j}`,
            stub: `synthetic memory ${i + j}`,
            embedding: point(),
            createdAt: at,
            updatedAt: at,
            validFrom: at,
          }),
        );
        await store.upsertMany(grant, batch);
      }
      await store.close();
      const seedMs = performance.now() - seedStart;

      // The upgrade's build: the next open that may migrate, with `vectorIndex: 'binary'`.
      const buildStart = performance.now();
      const binary = await openSqliteStore({ ...opts, vectorIndex: 'binary' });
      const buildMs = performance.now() - buildStart;
      // The same file searched exactly: no migration, so the binary index is left in place.
      const exact = await openSqliteStore({ ...opts, vectorIndex: 'int8', migrate: false });

      const db = new Database(dbPath, { readonly: true });
      sqliteVec.load(db);
      const bytes = (like: string, not = '') =>
        db
          .prepare<[], { b: number | null }>(
            `SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE '${like}'${not ? ` AND name NOT LIKE '${not}'` : ''}`,
          )
          .get()?.b ?? 0;
      // Scanned by every query: the codes, the chunk table and the filter columns.
      const bitChunks = bytes('memories_vec_bit_vector_chunks%');
      const bitScanned =
        bitChunks + bytes('memories_vec_bit_chunks') + bytes('memories_vec_bit_metadata%');
      // The id map (k lookups a query) and the rescore column (4k rows a query).
      const bitIds = bytes('memories_vec_bit_rowids%');
      const rescoreColumn = bytes('memories_vec_bit_auxiliary%');
      const int8Chunks = bytes('memories_vec_vector_chunks%');
      const int8Scanned =
        int8Chunks + bytes('memories_vec_chunks') + bytes('memories_vec_metadata%');
      const file = fs.statSync(dbPath).size;
      db.close();

      const queries = Array.from({ length: QUERIES }, point);
      let stats: DenseStats[] = [];
      const timeIt = async (s: typeof binary) => {
        const ms: number[] = [];
        const ids: string[][] = [];
        for (const q of queries) {
          const t = performance.now();
          const hits = await s.dense(grant, q, K);
          ms.push(performance.now() - t);
          ids.push(hits.map((h) => h.id));
        }
        return { ms, ids };
      };
      await timeIt(exact); // warm the page cache for both, so the timings compare scans
      const e = await timeIt(exact);
      const rssBefore = process.memoryUsage().rss;
      stats = [];
      const b = await timeIt(binary);
      const binaryReads = stats.map((x) => x.reads);
      const rssAfter = process.memoryUsage().rss;
      const recallOf = (got: string[][]) => {
        let found = 0;
        for (let i = 0; i < QUERIES; i++) {
          const want = new Set(e.ids[i]!.slice(0, 10));
          found += got[i]!.slice(0, 10).filter((id) => want.has(id)).length;
        }
        return found / (QUERIES * 10);
      };
      await binary.close();

      // The RaBitQ index on the same file (the open drops the binary index and builds it).
      const rqBuildStart = performance.now();
      await (await openSqliteStore({ ...opts, vectorIndex: 'rabitq' })).close();
      const rqBuildMs = performance.now() - rqBuildStart;
      const rqDb = new Database(dbPath, { readonly: true });
      const rqTable = (name: string) =>
        rqDb
          .prepare<[string], { b: number | null }>(
            `SELECT sum(pgsize) AS b FROM dbstat WHERE name = ?`,
          )
          .get(name)?.b ?? 0;
      const rqDisk = {
        codesMB: mb(rqTable('memories_rq') + rqTable('memories_rq_by_seq')),
        rescoreMB: mb(rqTable('memories_rq_vec')),
      };
      const rqFileMB = mb(fs.statSync(dbPath).size);
      rqDb.close();
      const rqRun = async (engine: 'native' | 'typescript') => {
        const rssStart = process.memoryUsage().rss;
        const s = await openSqliteStore({
          ...opts,
          vectorIndex: 'rabitq',
          rabitqEngine: engine,
          migrate: false,
          onDenseStats: (x) => stats.push(x),
        });
        const loadStart = performance.now();
        await s.dense(grant, queries[0]!, K); // loads the engine
        const loadMs = performance.now() - loadStart;
        const rssLoaded = process.memoryUsage().rss;
        stats = [];
        const r = await timeIt(s);
        const reads = stats.map((x) => x.reads);
        const capped = stats.filter((x) => x.capped === true).length / stats.length;
        await s.close();
        return {
          loadSeconds: Math.round(loadMs / 100) / 10,
          rssGrowthMB: mb(rssLoaded - rssStart),
          r,
          reads,
          capped,
        };
      };
      const nat = await rqRun('native');
      const ts = await rqRun('typescript');
      // The engine's own arrays, measured on a fresh native engine (heapBytes).
      const { RabitqReader } = await import('./rabitq-store.js');
      const hdb = new Database(dbPath, { readonly: true });
      sqliteVec.load(hdb);
      const reader = new RabitqReader(hdb, DIM, 'auto', () => {});
      hdb.transaction(() => reader.refresh())();
      const engineHeap = reader.stats().heapBytes;
      reader.release();
      hdb.close();
      await exact.close();
      const mean = (xs: number[]) => Math.round(xs.reduce((a, x) => a + x, 0) / xs.length);

      const result = {
        memories: N,
        dimension: DIM,
        seedSeconds: Math.round(seedMs / 1000),
        buildSeconds: Math.round(buildMs / 100) / 10,
        vectorRamMB: {
          binaryScanned: mb(bitScanned),
          bitChunks: mb(bitChunks),
          withIdMap: mb(bitScanned + bitIds),
        },
        int8MB: { scanned: mb(int8Scanned), chunks: mb(int8Chunks) },
        rescoreColumnMB: mb(rescoreColumn),
        fileMB: mb(file),
        rescoreReadsPerQuery: mean(binaryReads),
        rescoreBytesPerQuery: mean(binaryReads) * DIM,
        recallAt10VsInt8: recallOf(b.ids),
        latencyMs: {
          int8: { p50: pct(e.ms, 0.5), p95: pct(e.ms, 0.95) },
          binary: { p50: pct(b.ms, 0.5), p95: pct(b.ms, 0.95) },
        },
        rssGrowthDuringBinaryQueriesMB: mb(rssAfter - rssBefore),
        rabitq: {
          buildSeconds: Math.round(rqBuildMs / 100) / 10,
          engineResidentMB: mb(engineHeap),
          disk: rqDisk,
          fileMB: rqFileMB,
          rescoreReadsPerQuery: {
            mean: mean(nat.reads),
            p50: pct(nat.reads, 0.5),
            p95: pct(nat.reads, 0.95),
            max: Math.max(...nat.reads),
            cappedShare: nat.capped,
          },
          recallAt10VsInt8: recallOf(nat.r.ids),
          typescriptSameIds: ts.r.ids.every((ids, i) => ids.join() === nat.r.ids[i]!.join()),
          native: {
            p50: pct(nat.r.ms, 0.5),
            p95: pct(nat.r.ms, 0.95),
            loadSeconds: nat.loadSeconds,
            rssGrowthOnLoadMB: nat.rssGrowthMB,
          },
          typescript: {
            p50: pct(ts.r.ms, 0.5),
            p95: pct(ts.r.ms, 0.95),
            loadSeconds: ts.loadSeconds,
            rssGrowthOnLoadMB: ts.rssGrowthMB,
          },
        },
      };
      const json = JSON.stringify(result, null, 2);
      process.stdout.write(`${json}\n`);
      const out = process.env['OORT_BENCH_RAM_OUT'];
      if (out !== undefined && out !== '') fs.writeFileSync(out, `${json}\n`);
      expect(result.recallAt10VsInt8).toBeGreaterThanOrEqual(0.99);
      expect(result.rabitq.recallAt10VsInt8).toBeGreaterThanOrEqual(0.995);
      if (N >= 1_000_000) expect(result.vectorRamMB.binaryScanned).toBeLessThan(150);
    },
    4 * 60 * 60 * 1000,
  );
});
