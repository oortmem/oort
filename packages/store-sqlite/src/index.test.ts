import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localScope, type Memory, type ScopeFilter } from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  makeMemory,
  storeConformance,
  vec,
} from '@oortmem/core/store-conformance';
import { createColdCodec, openSqliteStore } from './index.js';

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
    expect(fs.readdirSync(path.join(dir, 'cold'))).toEqual(['c1.zst']);
    await store.forget('c1');
    expect(fs.readdirSync(path.join(dir, 'cold'))).toEqual([]);

    // Ids that are not safe file names never escape the cold directory.
    const odd = makeMemory({ id: '../Escape/ME', embedding: vec(1, 2, 3, 4) });
    await store.coldPut(odd);
    expect((await store.coldGet(odd.id))?.embedding).toEqual(vec(1, 2, 3, 4));
    const files = fs.readdirSync(path.join(dir, 'cold'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^~[0-9a-f]{64}\.zst$/);
    expect(fs.existsSync(path.join(dir, 'Escape'))).toBe(false);
    await store.close();
  });

  it('store.open-sweeps-orphan-blobs', async () => {
    const dir = freshDir();
    const cold = path.join(dir, 'cold');
    const first = await openSqliteStore(optsIn(dir));
    await first.coldPut(makeMemory({ id: 'kept', embedding: vec(1, 2, 3, 4) }));
    await first.close();

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const plant = (name: string, aged: boolean) => {
      fs.writeFileSync(path.join(cold, name), 'x');
      if (aged) fs.utimesSync(path.join(cold, name), old, old);
    };
    plant('orphan.zst', true); // never committed: removed
    plant('fresh-orphan.zst', false); // may be another process mid-coldPut: kept
    plant('crashed.123-abcd1234.zst.tmp', true); // interrupted write: removed
    plant('inflight.456-abcd1234.zst.tmp', false); // a write in progress: kept
    plant('notes.txt', true); // not ours: kept
    fs.utimesSync(path.join(cold, 'kept.zst'), old, old); // referenced: kept however old

    const messages: string[] = [];
    const store = await openSqliteStore({ ...optsIn(dir), log: (m) => messages.push(m) });
    expect(fs.readdirSync(cold).sort()).toEqual([
      'fresh-orphan.zst',
      'inflight.456-abcd1234.zst.tmp',
      'kept.zst',
      'notes.txt',
    ]);
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

  it.skipIf(process.platform === 'win32')('store.files-are-owner-only', async () => {
    const home = path.join(freshDir(), 'home');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    const messages: string[] = [];
    const dbPath = path.join(home, 'oort.sqlite');
    const store = await openSqliteStore({
      path: dbPath,
      coldDir: path.join(home, 'cold'),
      dimension: CONFORMANCE_DIMENSION,
      log: (m) => messages.push(m),
    });
    await store.upsert(makeMemory({ id: 'm1', embedding: vec(1, 2, 3, 4) }));
    await store.coldPut(makeMemory({ id: 'c1', embedding: vec(1, 2, 3, 4) }));
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    expect(mode(home)).toBe(0o700);
    expect(mode(path.join(home, 'cold'))).toBe(0o700);
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.join(home, 'cold', 'c1.zst')]) {
      expect(`${path.basename(f)} ${mode(f).toString(8)}`).toBe(`${path.basename(f)} 600`);
    }
    expect(messages).toEqual(['oort store: tightened permissions to 0700 on 1 existing directory']);
    await store.close();
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
    expect(() => codec.decode(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
