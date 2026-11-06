import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { localScope, type Memory, type ScopeFilter } from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  makeMemory,
  seedCold,
  storeConformance,
  vec,
} from '@oortmem/core/store-conformance';
import { ColdBlobCorruptError, createColdCodec, openSqliteStore } from './index.js';
import { TG } from '@oortmem/core/store-conformance';
import { localGrant } from '@oortmem/core';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-store-sqlite-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A fresh, empty directory under the suite's temp root. */
function freshDir(): string {
  return fs.mkdtempSync(path.join(root, 'case-'));
}

function optsIn(dir: string, dimension = CONFORMANCE_DIMENSION) {
  return { path: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold'), dimension };
}

storeConformance('sqlite', () => openSqliteStore(optsIn(freshDir())));

const LOCAL: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};

/** The cold blob files (not the marker or temp files) under `dir/cold`. */
function blobFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(dir, 'cold'))
    .filter((f) => f.endsWith('.zst'))
    .sort();
}

function ids(xs: { id: string }[]): string[] {
  return xs.map((x) => x.id);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('sqlite store', () => {
  it('store.private-project-isolation', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    const text = 'Staging deploys use the vault path secret/teams/payments-blue';
    const embedding = vec(9, 9, 9, 9);
    await store.upsert(
      TG,
      makeMemory({ id: 'private', text, embedding, scope: localScope('p-private') }),
    );
    await store.upsert(
      TG,
      makeMemory({ id: 'other', text, embedding, scope: localScope('p-other') }),
    );
    const filter: ScopeFilter = { ...LOCAL, projectIds: [null, 'p-other'] };
    expect(ids(await store.lexical(localGrant(filter), text, 10))).toEqual(['other']);
    expect(ids(await store.lexical(localGrant(filter), 'secret/teams/payments-blue', 10))).toEqual([
      'other',
    ]);
    expect(ids(await store.dense(localGrant(filter), embedding, 10))).toEqual(['other']);
    expect(ids(await store.list(localGrant(filter)))).toEqual(['other']);
    await store.close();
  });

  it('store.refuses-dimension-mismatch', async () => {
    const dir = freshDir();
    const first = await openSqliteStore(optsIn(dir, 4));
    await first.close();
    const err = await rejection(openSqliteStore(optsIn(dir, 8)));
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('4');
    expect(message).toContain('8');
    // The original dimension still opens.
    const again = await openSqliteStore(optsIn(dir, 4));
    await again.close();
  });

  it('store.persists-across-reopen', async () => {
    const dir = freshDir();
    const m = makeMemory({ id: 'm1', text: 'persisted claim', embedding: vec(3, -1, 4, -1) });
    const at = new Date('2026-11-03T09:00:00.000Z');
    const a = await openSqliteStore(optsIn(dir));
    await a.upsert(TG, m);
    await a.recordAccess(TG, ['m1'], at);
    await a.setCursor(TG, 'import:s1', '7');
    await a.close();

    const b = await openSqliteStore(optsIn(dir));
    const got = await b.get(TG, 'm1');
    expect(got?.embedding).toEqual(vec(3, -1, 4, -1));
    expect(got?.accessLog).toEqual({
      count: 1,
      recent: [at.toISOString()],
      compactedSum: 0,
      compactedAt: null,
    });
    expect(got).toEqual({ ...m, accessLog: got?.accessLog });
    expect(await b.getCursor(TG, 'import:s1')).toBe('7');
    expect(ids(await b.dense(localGrant(LOCAL), vec(3, -1, 4, -1), 10))).toEqual(['m1']);
    expect(ids(await b.lexical(localGrant(LOCAL), 'persisted', 10))).toEqual(['m1']);
    await b.close();
  });

  it('store.fts-handles-operator-input', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    await store.upsert(TG, makeMemory({ id: 'foo', text: 'the foo flag is on' }));
    await store.upsert(TG, makeMemory({ id: 'quote', text: 'a"b in a string' }));
    const inputs = [
      '"foo" OR bar*',
      'a"b',
      'NEAR(foo bar)',
      'foo AND NOT',
      '(((',
      'col:foo',
      '^foo',
      '"',
      '',
      '---',
    ];
    for (const q of inputs) {
      await expect(store.lexical(localGrant(LOCAL), q, 10)).resolves.toBeInstanceOf(Array);
    }
    expect(ids(await store.lexical(localGrant(LOCAL), '"foo" OR bar*', 10))).toEqual(['foo']);
    expect(ids(await store.lexical(localGrant(LOCAL), 'a"b', 10))).toContain('quote');
    expect(await store.lexical(localGrant(LOCAL), '---', 10)).toEqual([]);
    await store.close();
  });

  it('store.lexical-or-semantics-ranks-more-matches-first', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    await store.upsert(TG, makeMemory({ id: 'one', text: 'redis cache warmed' }));
    await store.upsert(TG, makeMemory({ id: 'two', text: 'redis cache eviction policy' }));
    await store.upsert(TG, makeMemory({ id: 'none', text: 'nothing relevant here' }));
    const hits = await store.lexical(localGrant(LOCAL), 'redis eviction policy', 10);
    expect(ids(hits)).toEqual(['two', 'one']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Infinity);
    expect(ids(await store.lexical(localGrant(LOCAL), 'redis eviction policy', 1))).toEqual([
      'two',
    ]);
    await store.close();
  });

  it('store.dense-k-counts-only-in-scope', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    // Ten out-of-scope rows sit nearer the query than the one in-scope row.
    for (let i = 0; i < 10; i++) {
      await store.upsert(
        TG,
        makeMemory({ id: `far-${i}`, embedding: vec(100, i, 0, 0), scope: localScope('p2') }),
      );
    }
    await store.upsert(TG, makeMemory({ id: 'mine', embedding: vec(10, 100, 0, 0) }));
    expect(ids(await store.dense(localGrant(LOCAL), vec(100, 0, 0, 0), 1))).toEqual(['mine']);
    await store.close();
  });

  it('store.set-tier-cold-hides-text-and-vector', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    const m = makeMemory({
      id: 'm1',
      text: 'zebra-crossing detail lives only in text',
      stub: 'crossing stub',
      embedding: vec(1, 2, 3, 4),
    });
    await store.upsert(TG, m);
    await store.setTier(TG, 'm1', 'cold');
    expect(await store.lexical(localGrant(LOCAL), 'zebra-crossing', 10)).toEqual([]);
    expect(await store.lexical(localGrant(LOCAL), 'crossing', 10)).toEqual([
      expect.objectContaining({ id: 'm1', tier: 'cold' }),
    ]);
    expect(await store.dense(localGrant(LOCAL), vec(1, 2, 3, 4), 10)).toEqual([]);
    expect(await store.get(TG, 'm1')).toEqual({ ...m, tier: 'cold' });

    await store.setTier(TG, 'm1', 'warm');
    expect(ids(await store.lexical(localGrant(LOCAL), 'zebra-crossing', 10))).toEqual(['m1']);
    expect(ids(await store.dense(localGrant(LOCAL), vec(1, 2, 3, 4), 10))).toEqual(['m1']);
    await store.close();
  });

  it('store.upsert-many-is-atomic', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    const before = makeMemory({ id: 'a', text: 'original' });
    await store.upsert(TG, before);
    const err = await rejection(
      store.upsertMany(TG, [
        { ...before, text: 'changed' },
        makeMemory({ id: 'b', embedding: vec(1, 2, 3, 4, 5) }),
      ]),
    );
    expect(err).toBeInstanceOf(RangeError);
    expect(await store.get(TG, 'a')).toEqual(before);
    expect(await store.get(TG, 'b')).toBeNull();
    await store.close();
  });

  it('store.cold-blob-on-disk-and-forget-removes-it', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    await seedCold(store, makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) }));
    expect(blobFiles(dir)).toEqual([expect.stringMatching(/^c1\.\d+-[0-9a-f]{8}\.zst$/)]);
    expect(fs.existsSync(path.join(dir, 'cold', '.oort-cold'))).toBe(true);

    // Hydrating (a warm upsert) drops the blob; the next eviction writes a new one.
    await seedCold(store, makeMemory({ id: 'c1', text: 'second', embedding: vec(4, 3, 2, 1) }));
    expect(blobFiles(dir)).toHaveLength(1);
    expect((await store.coldGet(TG, 'c1'))?.text).toBe('second');

    await store.forget(TG, 'c1');
    expect(blobFiles(dir)).toEqual([]);

    // Ids that are not safe file names never escape the cold directory.
    const odd = makeMemory({ id: '../Escape/ME', embedding: vec(1, 2, 3, 4) });
    await seedCold(store, odd);
    expect((await store.coldGet(TG, odd.id))?.embedding).toEqual(vec(1, 2, 3, 4));
    expect(blobFiles(dir)).toEqual([
      expect.stringMatching(/^~[0-9a-f]{64}\.\d+-[0-9a-f]{8}\.zst$/),
    ]);
    expect(fs.existsSync(path.join(dir, 'Escape'))).toBe(false);
    await store.close();
  });

  it('store.coldPut-rejects-wrong-dimension', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    const err = await rejection(
      store.coldPut(TG, makeMemory({ id: 'g1', embedding: vec(1, 2, 3, 4, 5, 6, 7) })),
    );
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toContain('7');
    expect(await store.get(TG, 'g1')).toBeNull();
    expect(blobFiles(dir)).toEqual([]);
    await store.close();
  });

  it('store.coldGet-returns-null-for-corrupt-blob', async () => {
    const dir = freshDir();
    const messages: string[] = [];
    const store = await openSqliteStore({ ...optsIn(dir), log: (m) => messages.push(m) });
    for (const [id, damage] of [
      ['truncated', (b: Buffer) => b.subarray(0, Math.floor(b.length / 2))],
      ['flipped', (b: Buffer) => Buffer.from(b.map((x, i) => (i === b.length - 6 ? x ^ 1 : x)))],
    ] as const) {
      await seedCold(store, makeMemory({ id, embedding: vec(5, -6, 7, -8) }));
      const file = path.join(
        dir,
        'cold',
        blobFiles(dir).find((f) => f.startsWith(`${id}.`))!,
      );
      fs.writeFileSync(file, damage(fs.readFileSync(file)));
      expect(await store.coldGet(TG, id)).toBeNull();
      // The main record is untouched: hydration falls back to it.
      expect((await store.get(TG, id))?.tier).toBe('cold');
    }
    expect(messages).toEqual([
      'oort store: cold blob for memory truncated is corrupt; ignoring it',
      'oort store: cold blob for memory flipped is corrupt; ignoring it',
    ]);
    await store.close();
  });

  /**
   * A row that is warm again but still indexes a cold copy: `setTier` up from
   * cold keeps the copy (consolidation never does this; recall re-upserts).
   * The only way an eviction replaces a previous blob.
   */
  async function warmWithPreviousBlob(
    store: Awaited<ReturnType<typeof openSqliteStore>>,
    m: Memory,
  ): Promise<Memory> {
    await seedCold(store, m);
    await store.setTier(TG, m.id, 'warm');
    const live = await store.get(TG, m.id);
    if (live === null) throw new Error(`lost ${m.id}`);
    return live;
  }

  it('store.failed-coldPut-keeps-previous-blob', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    const first = makeMemory({ id: 'c1', text: 'first snapshot', embedding: vec(1, 2, 3, 4) });
    const live = await warmWithPreviousBlob(store, first);
    const before = blobFiles(dir);

    // Another connection makes the next cold_index write fail inside the transaction.
    const raw = new Database(path.join(dir, 'oort.sqlite'));
    raw.exec(`CREATE TRIGGER fail_cold BEFORE UPDATE ON cold_index
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    raw.close();
    const err = await rejection(store.coldPut(TG, { ...live, embedding: vec(4, 3, 2, 1) }));
    expect((err as Error).message).toContain('injected failure');

    expect(blobFiles(dir)).toEqual(before);
    expect(await store.coldGet(TG, 'c1')).toEqual(first);
    expect(await store.get(TG, 'c1')).toEqual(live);
    await store.close();
  });

  it('store.failed-coldPutMany-leaves-no-blobs-and-keeps-previous', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    const first = makeMemory({ id: 'c1', text: 'first snapshot', embedding: vec(1, 2, 3, 4) });
    const c1 = await warmWithPreviousBlob(store, first);
    const c2 = makeMemory({ id: 'c2', embedding: vec(1, 1, 1, 1) });
    const c3 = makeMemory({ id: 'c3', embedding: vec(2, 2, 2, 2) });
    await store.upsertMany(TG, [c2, c3]);
    const before = blobFiles(dir);

    // Fail the third row's cold_index write, after the first two were written in the transaction.
    const raw = new Database(path.join(dir, 'oort.sqlite'));
    raw.exec(`CREATE TRIGGER fail_cold BEFORE INSERT ON cold_index
      WHEN NEW.id = 'c3' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    raw.close();
    const err = await rejection(
      store.coldPutMany(TG, [c2, { ...c1, embedding: vec(4, 3, 2, 1) }, c3]),
    );
    expect((err as Error).message).toContain('injected failure');

    expect(blobFiles(dir)).toEqual(before);
    expect(await store.coldGet(TG, 'c1')).toEqual(first);
    expect(await store.get(TG, 'c1')).toEqual(c1);
    expect(await store.get(TG, 'c2')).toEqual(c2);
    expect(await store.coldGet(TG, 'c2')).toBeNull();
    expect(await store.get(TG, 'c3')).toEqual(c3);
    await store.close();
  });

  it('store.coldPutMany-unlinks-previous-blobs-after-commit', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    const c1 = await warmWithPreviousBlob(
      store,
      makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) }),
    );
    const c2 = await warmWithPreviousBlob(
      store,
      makeMemory({ id: 'c2', embedding: vec(1, 2, 3, 4) }),
    );
    const c3 = makeMemory({ id: 'c3', embedding: vec(1, 1, 1, 1) });
    await store.upsert(TG, c3);
    const previous = blobFiles(dir);
    expect(previous).toHaveLength(2);
    const again = vec(4, 3, 2, 1);
    expect(
      await store.coldPutMany(TG, [{ ...c1, embedding: again }, { ...c2, embedding: again }, c3]),
    ).toEqual({ skipped: [] });
    const now = blobFiles(dir);
    expect(now).toHaveLength(3);
    for (const f of previous) expect(now).not.toContain(f);
    expect((await store.coldGet(TG, 'c1'))?.embedding).toEqual(again);
    await store.close();
  });

  it('store.skipped-eviction-unlinks-its-blob', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    const kept = makeMemory({ id: 'kept', embedding: vec(1, 2, 3, 4) });
    const raced = makeMemory({ id: 'raced', embedding: vec(4, 3, 2, 1) });
    await store.upsertMany(TG, [kept, raced]);
    // `raced` changes after the snapshot was read: its blob is written, then skipped.
    const later = {
      ...raced,
      validTo: new Date().toISOString(),
      updatedAt: '2999-01-01T00:00:00.000Z',
    };
    await store.upsert(TG, later);
    expect(await store.coldPutMany(TG, [kept, raced])).toEqual({ skipped: ['raced'] });
    expect(blobFiles(dir)).toEqual([expect.stringMatching(/^kept\./)]);
    expect(await store.get(TG, 'raced')).toEqual(later);
    expect(await store.coldGet(TG, 'raced')).toBeNull();
    await store.close();
  });

  it('store.concurrent-coldPut-same-id', async () => {
    const dir = freshDir();
    const a = await openSqliteStore(optsIn(dir));
    const b = await openSqliteStore(optsIn(dir));
    const m = makeMemory({ id: 'c1', text: 'contended', embedding: vec(1, 1, 1, 1) });
    const fromA = { ...m, embedding: vec(1, 1, 1, 1) };
    const fromB = { ...m, embedding: vec(2, 2, 2, 2) };
    for (let i = 0; i < 20; i++) {
      await a.upsert(TG, m); // warm again: drops the last round's cold copy
      const results = await Promise.all([a.coldPut(TG, fromA), b.coldPut(TG, fromB)]);
      // Both read the same snapshot; exactly one eviction lands, the other is skipped.
      expect(results.flatMap((r) => r.skipped)).toEqual(['c1']);
    }
    await a.close();
    await b.close();

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const f of blobFiles(dir)) fs.utimesSync(path.join(dir, 'cold', f), old, old);
    const messages: string[] = [];
    const store = await openSqliteStore({ ...optsIn(dir), log: (x) => messages.push(x) }); // sweeps
    expect(messages).toEqual([]); // the skipped blobs were unlinked, not left for the sweep
    const got = await store.coldGet(TG, 'c1');
    expect([fromA, fromB]).toContainEqual(got);
    expect(got?.embedding).toHaveLength(CONFORMANCE_DIMENSION);
    expect(blobFiles(dir)).toHaveLength(1);
    await store.close();
  });

  it('store.busy-timeout-option', { timeout: 30_000 }, async () => {
    const dir = freshDir();
    const opts = optsIn(dir);
    await (await openSqliteStore(opts)).close(); // schema in place
    const open = await openSqliteStore({ ...opts, busyTimeoutMs: 250 });
    const holder = new Database(opts.path);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const busy = expect.objectContaining({ code: expect.stringMatching(/^SQLITE_BUSY/) });
      // A write on an open handle gives up after ~250 ms instead of the 5 s default. Under 4 s
      // tells the two apart; a loaded machine wakes a sleeping busy handler late, so not 750 ms.
      let t = performance.now();
      await expect(open.upsert(TG, makeMemory({ id: 'w' }))).rejects.toEqual(busy);
      let ms = performance.now() - t;
      expect(ms).toBeGreaterThanOrEqual(200);
      expect(ms).toBeLessThan(4000);
      // Opening takes the write lock (schema check), so it gives up just as fast.
      t = performance.now();
      await expect(openSqliteStore({ ...opts, busyTimeoutMs: 250 })).rejects.toEqual(busy);
      ms = performance.now() - t;
      expect(ms).toBeGreaterThanOrEqual(200);
      expect(ms).toBeLessThan(4000);
      // Reads never wait on a writer under WAL.
      expect(await open.list(localGrant(LOCAL), { validOnly: false })).toEqual([]);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    await open.upsert(TG, makeMemory({ id: 'w' }));
    expect(await open.get(TG, 'w')).not.toBeNull();
    await open.close();
    await expect(openSqliteStore({ ...opts, busyTimeoutMs: -1 })).rejects.toThrow(RangeError);
  });

  it('store.parallel-writers-no-busy', async () => {
    const dir = freshDir();
    const opts = optsIn(dir);
    // Two worker threads: truly parallel connections (and no umask in workers).
    const worker = new URL('../test/parallel-writer.mjs', import.meta.url);
    const run = (tag: string) =>
      new Promise<string[]>((resolve, reject) => {
        const w = new Worker(worker, { workerData: { ...opts, tag, n: 200 } });
        w.once('message', resolve);
        w.once('error', reject);
      });
    const errors = (await Promise.all([run('W1'), run('W2')])).flat();
    expect(errors).toEqual([]);
    const store = await openSqliteStore(opts);
    expect(await store.list(localGrant(LOCAL), { validOnly: false })).toHaveLength(400);
    await store.close();
  });

  it('store.open-sweeps-orphan-blobs', async () => {
    const dir = freshDir();
    const cold = path.join(dir, 'cold');
    const first = await openSqliteStore(optsIn(dir));
    await seedCold(first, makeMemory({ id: 'kept', embedding: vec(1, 2, 3, 4) }));
    await first.close();
    const [kept] = blobFiles(dir);

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const plant = (name: string, aged: boolean) => {
      fs.writeFileSync(path.join(cold, name), 'x');
      if (aged) fs.utimesSync(path.join(cold, name), old, old);
    };
    plant('orphan.123-abcd1234.zst', true); // never committed: removed
    plant('fresh.123-abcd1234.zst', false); // may be another process mid-coldPut: kept
    plant('crashed.123-abcd1234.zst.tmp', true); // interrupted write: removed
    plant('inflight.456-abcd1234.zst.tmp', false); // a write in progress: kept
    plant('notes.zst', true); // not a blob name: kept
    plant('notes.txt', true); // not ours: kept
    fs.utimesSync(path.join(cold, kept!), old, old); // referenced: kept however old

    const messages: string[] = [];
    const store = await openSqliteStore({ ...optsIn(dir), log: (m) => messages.push(m) });
    expect(fs.readdirSync(cold).sort()).toEqual(
      [
        '.oort-cold',
        'fresh.123-abcd1234.zst',
        'inflight.456-abcd1234.zst.tmp',
        kept!,
        'notes.txt',
        'notes.zst',
      ].sort(),
    );
    expect(messages).toEqual([
      'oort store: removed 1 orphan cold blob(s) and 1 stale temp file(s)',
    ]);
    expect((await store.coldGet(TG, 'kept'))?.embedding).toEqual(vec(1, 2, 3, 4));
    await store.close();

    // Nothing left to sweep: no notice.
    const quiet: string[] = [];
    await (await openSqliteStore({ ...optsIn(dir), log: (m) => quiet.push(m) })).close();
    expect(quiet).toEqual([]);
  });

  it('store.sweep-needs-marker', async () => {
    // A populated directory the store did not create (a misconfigured shared dir).
    const dir = freshDir();
    const cold = path.join(dir, 'cold');
    fs.mkdirSync(cold, { mode: 0o700 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.writeFileSync(path.join(cold, 'looks-like.123-abcd1234.zst'), 'x');
    fs.utimesSync(path.join(cold, 'looks-like.123-abcd1234.zst'), old, old);
    const messages: string[] = [];
    const store = await openSqliteStore({ ...optsIn(dir), log: (m) => messages.push(m) });
    expect(fs.readdirSync(cold)).toEqual(['looks-like.123-abcd1234.zst']);
    expect(messages).toEqual([
      `oort: ${cold} has no .oort-cold marker; orphan cold blob sweep disabled`,
    ]);
    await store.close();
  });

  it.skipIf(process.platform === 'win32')('store.files-are-owner-only', async () => {
    // A project root the caller owns: never chmodded, only warned about.
    const project = path.join(freshDir(), 'project');
    fs.mkdirSync(project);
    fs.chmodSync(project, 0o755);
    const messages: string[] = [];
    const dbPath = path.join(project, 'oort.sqlite');
    const coldDir = path.join(project, '.oort', 'cold');
    const store = await openSqliteStore({
      path: dbPath,
      coldDir,
      dimension: CONFORMANCE_DIMENSION,
      log: (m) => messages.push(m),
    });
    await store.upsert(TG, makeMemory({ id: 'm1', embedding: vec(1, 2, 3, 4) }));
    await seedCold(store, makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) }));
    const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);
    expect(mode(project)).toBe('755');
    expect(mode(path.join(project, '.oort'))).toBe('700');
    expect(mode(coldDir)).toBe('700');
    const blob = fs.readdirSync(coldDir).find((f) => f.endsWith('.zst'))!;
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.join(coldDir, blob)]) {
      expect(`${path.basename(f)} ${mode(f)}`).toBe(`${path.basename(f)} 600`);
    }
    expect(messages).toEqual([
      `oort: ${project} is readable by group/others; memory files inside are 0600`,
    ]);
    await store.close();

    // A loose cold directory is the store's own: tightened.
    const loose = path.join(freshDir(), 'cold');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o755);
    const notes: string[] = [];
    const other = await openSqliteStore({
      path: path.join(path.dirname(loose), 'oort.sqlite'),
      coldDir: loose,
      dimension: CONFORMANCE_DIMENSION,
      log: (m) => notes.push(m),
    });
    expect(mode(loose)).toBe('700');
    expect(notes).toEqual(['oort store: tightened permissions to 0700 on the cold directory']);
    await other.close();
  });

  it('store.two-handles-share-one-file', async () => {
    const dir = freshDir();
    const a = await openSqliteStore(optsIn(dir));
    const b = await openSqliteStore(optsIn(dir));
    await a.upsert(TG, makeMemory({ id: 'm1', text: 'written by a', embedding: vec(1, 1, 1, 1) }));
    await b.recordAccess(TG, ['m1'], new Date('2026-11-03T10:00:00.000Z'));
    expect((await a.get(TG, 'm1'))?.accessLog.count).toBe(1);
    expect(ids(await b.lexical(localGrant(LOCAL), 'written', 10))).toEqual(['m1']);
    await a.close();
    await b.close();
  });
});

/**
 * A realistic cold memory: a ~400-character de-contextualised claim with the
 * decisions observe records on a supersede, and a 512-d int8 embedding built
 * the usual way (a unit-normalised vector, symmetric scalar quantisation to
 * the full int8 range).
 */
function realisticMemory(): Memory {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const float = Array.from({ length: 512 }, gauss);
  const norm = Math.hypot(...float);
  const unit = float.map((x) => x / norm);
  const maxAbs = Math.max(...unit.map(Math.abs));
  const embedding = Int8Array.from(unit, (x) => Math.round((x / maxAbs) * 127));
  const at = '2026-11-03T12:00:00.000Z';
  const text =
    'The auth service moved from port 3000 to port 8080 when the team split the login backend ' +
    'out of the monolith in October; all internal callers now route through auth-service-8080, ' +
    'and the old port is closed at the load balancer. Local development still uses docker ' +
    'compose, so run `pnpm dev:auth` before the web app, otherwise sign-in requests time out ' +
    'after thirty seconds with a gateway error.';
  return makeMemory({
    id: '4f1c2a9e-7b3d-4e8a-9c21-5d6f7a8b9c0d',
    scope: localScope('oort-1a2b3c4d'),
    text,
    stub: 'auth service port 8080 auth-service-8080',
    entities: ['auth-service-8080', 'port 8080', 'docker compose'],
    salience: 0.72,
    accessLog: { count: 3, recent: [at, at, at], compactedSum: 0, compactedAt: null },
    validFrom: at,
    lastConfirmedAt: at,
    supersedes: '9b2e41f0-3c5d-4a7e-8f19-2d4c6b8a0e13',
    source: {
      harness: 'claude-code',
      sessionId: '0d3a7c52-61b4-4f0e-9a8d-2c7e5b1f4a96',
      turnRef: 'msg_01HZX4K9Q2',
      decisions: [
        { stage: 'gate', question: 'store?', answer: 'yes', probability: 0.91 },
        { stage: 'reconcile', question: 'action', answer: 'SUPERSEDE', probability: 0.77 },
        { stage: 'temporal', question: 'order', answer: 'in-order', probability: 1 },
        { stage: 'write', question: 'action', answer: 'SUPERSEDE', probability: 0.77 },
      ],
    },
    embedding,
    createdAt: at,
    updatedAt: at,
  });
}

describe('cold codec', () => {
  it('cold.roundtrip-compresses', () => {
    const codec = createColdCodec();
    const m = realisticMemory();
    expect(m.text.length).toBeGreaterThanOrEqual(390);
    expect(m.text.length).toBeLessThanOrEqual(410);
    const naive = JSON.stringify({
      ...m,
      embedding: Buffer.from(m.embedding!.buffer).toString('base64'),
    });
    const encoded = codec.encode(m);
    expect(codec.decode(encoded)).toEqual(m);
    const ratio = encoded.length / Buffer.byteLength(naive);
    expect(ratio).toBeLessThan(0.6);

    const bare = makeMemory({ id: 'bare' });
    expect(codec.decode(codec.encode(bare))).toEqual(bare);
    expect(codec.decode(codec.encode(bare)).embedding).toBeUndefined();
  });

  it('cold.decode-under-3ms', () => {
    const codec = createColdCodec();
    const encoded = codec.encode(realisticMemory());
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      codec.decode(encoded);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = ((times[49] ?? 0) + (times[50] ?? 0)) / 2;
    expect(median).toBeLessThan(3);
  });

  it('cold.decode-rejects-corrupt-frames', () => {
    const codec = createColdCodec();
    expect(() => codec.decode(new Uint8Array([1, 2, 3]))).toThrow(ColdBlobCorruptError);
    expect(() => codec.decode(new Uint8Array([]))).toThrow(ColdBlobCorruptError);
    const unknown = Buffer.from(codec.encode(realisticMemory()));
    unknown[0] = 0x09;
    expect(() => codec.decode(unknown)).toThrow(/unsupported frame version 9/);
  });

  it('cold.decode-rejects-truncated-frame', () => {
    const codec = createColdCodec({ dimension: 512 });
    const blob = codec.encode(realisticMemory());
    for (const at of [0.25, 0.5, 0.75]
      .map((f) => Math.floor(blob.length * f))
      .concat(blob.length - 1)) {
      expect(() => codec.decode(blob.subarray(0, at)), `truncated at ${at}`).toThrow(
        ColdBlobCorruptError,
      );
    }
  });

  it('cold.decode-rejects-bitflip', () => {
    const codec = createColdCodec({ dimension: 512 });
    const blob = codec.encode(realisticMemory());
    // Version byte excluded (that is the unknown-version case); every other region:
    // JSON length, compressed JSON, embedding length, embedding bytes, CRC.
    const positions = [1, 4, 10, Math.floor(blob.length / 2), blob.length - 300, blob.length - 520];
    for (const at of [...positions, blob.length - 4, blob.length - 1]) {
      const flipped = Uint8Array.from(blob);
      flipped[at] = (flipped[at] ?? 0) ^ 0x10;
      expect(() => codec.decode(flipped), `bit flip at ${at}`).toThrow(ColdBlobCorruptError);
    }
  });

  it('cold.decodes-v1-frames-and-checks-dimension', () => {
    const m = makeMemory({ id: 'v1', embedding: vec(1, -2, 3, -4) });
    const { embedding, ...rest } = m;
    const json = zstdCompressSync(Buffer.from(JSON.stringify(rest)));
    const head = Buffer.alloc(5);
    head[0] = 0x01;
    head.writeUInt32BE(json.length, 1);
    const v1 = Buffer.concat([head, json, Buffer.from([1]), Buffer.from(embedding!.buffer)]);
    expect(createColdCodec({ dimension: 4 }).decode(v1)).toEqual(m);
    expect(() => createColdCodec({ dimension: 8 }).decode(v1)).toThrow(ColdBlobCorruptError);
    expect(() => createColdCodec({ dimension: 4 }).decode(v1.subarray(0, v1.length - 1))).toThrow(
      ColdBlobCorruptError,
    );
  });
});
