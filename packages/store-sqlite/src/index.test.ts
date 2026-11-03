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
  storeConformance,
  vec,
} from '@oortmem/core/store-conformance';
import { ColdBlobCorruptError, createColdCodec, openSqliteStore } from './index.js';

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
      makeMemory({ id: 'private', text, embedding, scope: localScope('p-private') }),
    );
    await store.upsert(makeMemory({ id: 'other', text, embedding, scope: localScope('p-other') }));
    const filter: ScopeFilter = { ...LOCAL, projectIds: [null, 'p-other'] };
    expect(ids(await store.lexical(text, filter, 10))).toEqual(['other']);
    expect(ids(await store.lexical('secret/teams/payments-blue', filter, 10))).toEqual(['other']);
    expect(ids(await store.dense(embedding, filter, 10))).toEqual(['other']);
    expect(ids(await store.list(filter))).toEqual(['other']);
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
    await a.upsert(m);
    await a.recordAccess(['m1'], at);
    await a.setCursor('import:s1', '7');
    await a.close();

    const b = await openSqliteStore(optsIn(dir));
    const got = await b.get('m1');
    expect(got?.embedding).toEqual(vec(3, -1, 4, -1));
    expect(got?.accessLog).toEqual({
      count: 1,
      recent: [at.toISOString()],
      compactedSum: 0,
      compactedAt: null,
    });
    expect(got).toEqual({ ...m, accessLog: got?.accessLog });
    expect(await b.getCursor('import:s1')).toBe('7');
    expect(ids(await b.dense(vec(3, -1, 4, -1), LOCAL, 10))).toEqual(['m1']);
    expect(ids(await b.lexical('persisted', LOCAL, 10))).toEqual(['m1']);
    await b.close();
  });

  it('store.fts-handles-operator-input', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    await store.upsert(makeMemory({ id: 'foo', text: 'the foo flag is on' }));
    await store.upsert(makeMemory({ id: 'quote', text: 'a"b in a string' }));
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
      await expect(store.lexical(q, LOCAL, 10)).resolves.toBeInstanceOf(Array);
    }
    expect(ids(await store.lexical('"foo" OR bar*', LOCAL, 10))).toEqual(['foo']);
    expect(ids(await store.lexical('a"b', LOCAL, 10))).toContain('quote');
    expect(await store.lexical('---', LOCAL, 10)).toEqual([]);
    await store.close();
  });

  it('store.lexical-or-semantics-ranks-more-matches-first', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    await store.upsert(makeMemory({ id: 'one', text: 'redis cache warmed' }));
    await store.upsert(makeMemory({ id: 'two', text: 'redis cache eviction policy' }));
    await store.upsert(makeMemory({ id: 'none', text: 'nothing relevant here' }));
    const hits = await store.lexical('redis eviction policy', LOCAL, 10);
    expect(ids(hits)).toEqual(['two', 'one']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Infinity);
    expect(ids(await store.lexical('redis eviction policy', LOCAL, 1))).toEqual(['two']);
    await store.close();
  });

  it('store.dense-k-counts-only-in-scope', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    // Ten out-of-scope rows sit nearer the query than the one in-scope row.
    for (let i = 0; i < 10; i++) {
      await store.upsert(
        makeMemory({ id: `far-${i}`, embedding: vec(100, i, 0, 0), scope: localScope('p2') }),
      );
    }
    await store.upsert(makeMemory({ id: 'mine', embedding: vec(10, 100, 0, 0) }));
    expect(ids(await store.dense(vec(100, 0, 0, 0), LOCAL, 1))).toEqual(['mine']);
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
    await store.upsert(m);
    await store.setTier('m1', 'cold');
    expect(await store.lexical('zebra-crossing', LOCAL, 10)).toEqual([]);
    expect(await store.lexical('crossing', LOCAL, 10)).toEqual([
      expect.objectContaining({ id: 'm1', tier: 'cold' }),
    ]);
    expect(await store.dense(vec(1, 2, 3, 4), LOCAL, 10)).toEqual([]);
    expect(await store.get('m1')).toEqual({ ...m, tier: 'cold' });

    await store.setTier('m1', 'warm');
    expect(ids(await store.lexical('zebra-crossing', LOCAL, 10))).toEqual(['m1']);
    expect(ids(await store.dense(vec(1, 2, 3, 4), LOCAL, 10))).toEqual(['m1']);
    await store.close();
  });

  it('store.upsert-many-is-atomic', async () => {
    const store = await openSqliteStore(optsIn(freshDir()));
    const before = makeMemory({ id: 'a', text: 'original' });
    await store.upsert(before);
    const err = await rejection(
      store.upsertMany([
        { ...before, text: 'changed' },
        makeMemory({ id: 'b', embedding: vec(1, 2, 3, 4, 5) }),
      ]),
    );
    expect(err).toBeInstanceOf(RangeError);
    expect(await store.get('a')).toEqual(before);
    expect(await store.get('b')).toBeNull();
    await store.close();
  });

  it('store.cold-blob-on-disk-and-forget-removes-it', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    await store.coldPut(makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) }));
    expect(blobFiles(dir)).toEqual([expect.stringMatching(/^c1\.\d+-[0-9a-f]{8}\.zst$/)]);
    expect(fs.existsSync(path.join(dir, 'cold', '.oort-cold'))).toBe(true);

    // A second coldPut replaces the blob: one file per id, the newest snapshot.
    await store.coldPut(makeMemory({ id: 'c1', text: 'second', embedding: vec(4, 3, 2, 1) }));
    expect(blobFiles(dir)).toHaveLength(1);
    expect((await store.coldGet('c1'))?.text).toBe('second');

    await store.forget('c1');
    expect(blobFiles(dir)).toEqual([]);

    // Ids that are not safe file names never escape the cold directory.
    const odd = makeMemory({ id: '../Escape/ME', embedding: vec(1, 2, 3, 4) });
    await store.coldPut(odd);
    expect((await store.coldGet(odd.id))?.embedding).toEqual(vec(1, 2, 3, 4));
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
      store.coldPut(makeMemory({ id: 'g1', embedding: vec(1, 2, 3, 4, 5, 6, 7) })),
    );
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toContain('7');
    expect(await store.get('g1')).toBeNull();
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
      await store.coldPut(makeMemory({ id, embedding: vec(5, -6, 7, -8) }));
      const file = path.join(
        dir,
        'cold',
        blobFiles(dir).find((f) => f.startsWith(`${id}.`))!,
      );
      fs.writeFileSync(file, damage(fs.readFileSync(file)));
      expect(await store.coldGet(id)).toBeNull();
      // The main record is untouched: hydration falls back to it.
      expect((await store.get(id))?.tier).toBe('cold');
    }
    expect(messages).toEqual([
      'oort store: cold blob for memory truncated is corrupt; ignoring it',
      'oort store: cold blob for memory flipped is corrupt; ignoring it',
    ]);
    await store.close();
  });

  it('store.failed-coldPut-keeps-previous-blob', async () => {
    const dir = freshDir();
    const store = await openSqliteStore(optsIn(dir));
    const first = makeMemory({ id: 'c1', text: 'first snapshot', embedding: vec(1, 2, 3, 4) });
    await store.coldPut(first);
    const before = blobFiles(dir);

    // Another connection makes the next cold_index write fail inside the transaction.
    const raw = new Database(path.join(dir, 'oort.sqlite'));
    raw.exec(`CREATE TRIGGER fail_cold BEFORE UPDATE ON cold_index
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    raw.close();
    const err = await rejection(
      store.coldPut(makeMemory({ id: 'c1', text: 'second snapshot', embedding: vec(4, 3, 2, 1) })),
    );
    expect((err as Error).message).toContain('injected failure');

    expect(blobFiles(dir)).toEqual(before);
    expect(await store.coldGet('c1')).toEqual(first);
    expect((await store.get('c1'))?.text).toBe('first snapshot');
    await store.close();
  });

  it('store.concurrent-coldPut-same-id', async () => {
    const dir = freshDir();
    const a = await openSqliteStore(optsIn(dir));
    const b = await openSqliteStore(optsIn(dir));
    const fromA = makeMemory({ id: 'c1', text: 'from a', embedding: vec(1, 1, 1, 1) });
    const fromB = makeMemory({ id: 'c1', text: 'from b', embedding: vec(2, 2, 2, 2) });
    for (let i = 0; i < 20; i++) await Promise.all([a.coldPut(fromA), b.coldPut(fromB)]);
    await a.close();
    await b.close();

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const f of blobFiles(dir)) fs.utimesSync(path.join(dir, 'cold', f), old, old);
    const store = await openSqliteStore({ ...optsIn(dir), log: () => {} }); // sweeps
    const got = await store.coldGet('c1');
    expect([fromA, fromB]).toContainEqual(got);
    expect(got?.embedding).toHaveLength(CONFORMANCE_DIMENSION);
    expect(blobFiles(dir)).toHaveLength(1);
    await store.close();
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
    expect(await store.list(LOCAL, { validOnly: false })).toHaveLength(400);
    await store.close();
  });

  it('store.open-sweeps-orphan-blobs', async () => {
    const dir = freshDir();
    const cold = path.join(dir, 'cold');
    const first = await openSqliteStore(optsIn(dir));
    await first.coldPut(makeMemory({ id: 'kept', embedding: vec(1, 2, 3, 4) }));
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
    expect((await store.coldGet('kept'))?.embedding).toEqual(vec(1, 2, 3, 4));
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
    await store.upsert(makeMemory({ id: 'm1', embedding: vec(1, 2, 3, 4) }));
    await store.coldPut(makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) }));
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
    await a.upsert(makeMemory({ id: 'm1', text: 'written by a', embedding: vec(1, 1, 1, 1) }));
    await b.recordAccess(['m1'], new Date('2026-11-03T10:00:00.000Z'));
    expect((await a.get('m1'))?.accessLog.count).toBe(1);
    expect(ids(await b.lexical('written', LOCAL, 10))).toEqual(['m1']);
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
