import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { localScope, tokenizeLexical, type Memory } from '@oortmem/core';
import { makeMemory, seedCold, vec } from '@oortmem/core/store-conformance';
import Database from 'better-sqlite3';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { loadEvalRows, runEval, type EvalRow } from './eval.js';
import { buildFixtureRows, FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { fakeEmbedder } from './fake-embed.js';
import { GENERATOR_NOW, generateMemories } from './generate.js';
import { seedStore } from './seed.js';
import { TG } from '@oortmem/core/store-conformance';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-bench-eval-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = '2026-06-01T00:00:00.000Z';
const DIM = 4;

function mem(id: string, text: string, extra: Partial<Memory> = {}): Memory {
  return makeMemory({
    id,
    text,
    stub: text,
    scope: localScope(),
    validFrom: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

/** A tiny store whose recall outcomes are known by hand. */
async function handBuiltStore(): Promise<{ dbPath: string; coldDir: string }> {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const dbPath = path.join(dir, 'oort.sqlite');
  const coldDir = path.join(dir, 'cold');
  const store = await openSqliteStore({ path: dbPath, coldDir, dimension: DIM, log: () => {} });
  await store.upsertMany(TG, [
    mem('m0', 'auth service listens on port 3000', {
      validFrom: '2025-01-01T00:00:00.000Z',
      validTo: '2026-01-01T00:00:00.000Z',
      expiredAt: '2026-01-01T00:00:00.000Z',
      endReason: 'superseded',
      supersededBy: 'm1',
    }),
    mem('m1', 'auth service listens on port 8080', { supersedes: 'm0' }),
    mem('m2', 'billing worker uses pnpm for installs'),
    mem('m3', 'deploy runs on fridays via github actions'),
    mem('m4', 'database migrations live in db/migrations'),
    // Same words, ordered by salience, so the lowest-salience one ranks third.
    mem('m5', 'rollback runbook for releases', { salience: 0.9 }),
    mem('m6', 'rollback runbook for releases', { salience: 0.5 }),
    mem('m7', 'rollback runbook for releases', { salience: 0.1 }),
  ]);
  await store.close();
  return { dbPath, coldDir };
}

const ROWS: EvalRow[] = [
  {
    question: 'auth service port',
    expectedMemoryIds: ['m1'],
    notExpectedMemoryIds: ['m0'],
    category: 'knowledge-update',
  },
  { question: 'pnpm installs', expectedMemoryIds: ['m2'], category: 'single-fact' },
  { question: 'deploy github actions', expectedMemoryIds: ['m4', 'm3'], category: 'single-fact' },
  {
    question: 'auth service port',
    expectedMemoryIds: ['m0'],
    notExpectedMemoryIds: ['m1'],
    asOf: '2025-06-01T00:00:00.000Z',
    category: 'temporal',
  },
  {
    question: 'auth service port',
    expectedMemoryIds: ['m1'],
    notExpectedMemoryIds: ['m0'],
    asOf: '2025-06-01T00:00:00.000Z',
    category: 'temporal',
  },
  { question: 'rollback runbook', expectedMemoryIds: ['m7'], category: 'multi-session' },
  { question: 'kubernetes zeppelin', expectedMemoryIds: [], category: 'abstention' },
  { question: 'auth port', expectedMemoryIds: [], category: 'abstention' },
];

describe('eval', () => {
  it('eval.metrics-on-fixture', async () => {
    const { dbPath, coldDir } = await handBuiltStore();
    const report = await runEval({
      rows: ROWS,
      storePath: dbPath,
      coldDir,
      dimension: DIM,
      ks: [5, 10],
      now: new Date(NOW),
    });
    const all = report.groups['overall'];
    expect(all?.rows).toBe(8);
    // Six rows have expected ids: recall@5 = (1 + 1 + 0.5 + 1 + 0 + 1) / 6.
    expect(all?.recallAt[5]).toBeCloseTo(0.75);
    expect(all?.recallAt[10]).toBeCloseTo(0.75);
    // First expected hit at rank 1, 1, 1, 1, none, 3: MRR@10 = (4 + 0 + 1/3) / 6.
    expect(all?.mrr).toBeCloseTo(13 / 18);
    expect(report.groups['multi-session']?.mrr).toBeCloseTo(1 / 3);
    // Three rows list not-expected ids; only the wrong as-of one leaks m0.
    expect(all?.staleLeak).toBeCloseTo(1 / 3);
    // Of two abstention rows, only "auth port" returns something.
    expect(all?.abstainFp).toBeCloseTo(0.5);
    const single = report.groups['single-fact'];
    expect(single?.rows).toBe(2);
    expect(single?.recallAt[5]).toBeCloseTo(0.75);
    expect(single?.staleLeak).toBeNull();
    expect(report.groups['knowledge-update']?.staleLeak).toBe(0);
    expect(report.groups['temporal']?.staleLeak).toBeCloseTo(0.5);
    expect(report.skippedEmpty).toBe(0);
  });

  it('eval.skips-empty-questions', async () => {
    const importRow = {
      memoryId: 'm2',
      question: '',
      expectedMemoryIds: ['m2'],
      asOf: '2026-02-01T00:00:00.000Z',
    };
    const text = [
      JSON.stringify(importRow),
      '',
      JSON.stringify({ question: '   ', expectedMemoryIds: ['m1'] }),
      JSON.stringify({ question: 'pnpm installs', expectedMemoryIds: ['m2'] }),
    ].join('\n');
    const loaded = loadEvalRows(text);
    expect(loaded.skippedEmpty).toBe(2);
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.rows[0]?.question).toBe('pnpm installs');

    const { dbPath, coldDir } = await handBuiltStore();
    const report = await runEval({
      rows: loaded.rows,
      skippedEmpty: loaded.skippedEmpty,
      storePath: dbPath,
      coldDir,
      dimension: DIM,
      ks: [5, 10],
      now: new Date(NOW),
    });
    expect(report.skippedEmpty).toBe(2);
    expect(report.groups['overall']?.rows).toBe(1);
    expect(() => loadEvalRows('{"question": 3}')).toThrow(/line 1/);
    expect(() => loadEvalRows('not json')).toThrow(/line 1/);
  });

  it('eval.never-writes-live-store', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'live-'));
    const dbPath = path.join(dir, 'oort.sqlite');
    const coldDir = path.join(dir, 'cold');
    const store = await openSqliteStore({ path: dbPath, coldDir, dimension: DIM, log: () => {} });
    await store.upsertMany(TG, [mem('w1', 'warm memory about caching')]);
    // A cold memory the row below hydrates: on a live store that is a write.
    await seedCold(
      store,
      mem('c1', 'zeppelin hydration marker', { embedding: vec(1, 2, 3, 4), tier: 'cold' }),
    );
    // A second connection keeps the WAL (and shm) alive after the store closes.
    const other = new Database(dbPath);
    other.prepare('SELECT count(*) FROM memories').get();
    await store.close();
    const wal = `${dbPath}-wal`;
    expect(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'a non-empty WAL must exist').toBe(
      true,
    );
    const blobs = fs.readdirSync(coldDir).filter((f) => f.endsWith('.zst'));
    expect(blobs).toHaveLength(1);

    /** Contents of the db, the WAL and every cold blob (the shm is only read-marks, shared by readers). */
    const snapshot = (): string => {
      const h = createHash('sha256');
      for (const f of [dbPath, wal]) h.update(path.basename(f)).update(fs.readFileSync(f));
      for (const f of fs.readdirSync(coldDir).sort()) {
        h.update(f).update(fs.readFileSync(path.join(coldDir, f)));
      }
      return h.digest('hex');
    };
    const lock = (mode: 'ro' | 'rw'): void => {
      const [d, f] = mode === 'ro' ? [0o500, 0o400] : [0o700, 0o600];
      for (const x of [dir, coldDir]) fs.chmodSync(x, d);
      for (const x of fs.readdirSync(dir)) {
        if (x !== 'cold') fs.chmodSync(path.join(dir, x), f);
      }
      for (const x of fs.readdirSync(coldDir)) fs.chmodSync(path.join(coldDir, x), f);
    };
    const before = snapshot();
    lock('ro');
    let after = '';
    try {
      // Any write to the live directory now throws.
      expect(() => fs.writeFileSync(path.join(dir, 'probe'), 'x')).toThrow();
      const report = await runEval({
        rows: [
          { question: 'zeppelin hydration', expectedMemoryIds: ['c1'] },
          { question: 'caching', expectedMemoryIds: ['w1'] },
        ],
        storePath: dbPath,
        coldDir,
        dimension: DIM,
        ks: [5, 10],
        now: new Date(NOW),
      });
      // The cold memory was found (hydrated on the copy), so the run did real work.
      expect(report.groups['overall']?.recallAt[10]).toBe(1);
      after = snapshot();
    } finally {
      lock('rw');
      other.close();
    }
    expect(after).toBe(before);
    expect(fs.readdirSync(coldDir).filter((f) => f.endsWith('.zst'))).toEqual(blobs);
  });

  it('eval.warns-about-missing-cold-blobs', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'missing-'));
    const dbPath = path.join(dir, 'oort.sqlite');
    const coldDir = path.join(dir, 'cold');
    const store = await openSqliteStore({ path: dbPath, coldDir, dimension: DIM, log: () => {} });
    await seedCold(
      store,
      mem('c1', 'zeppelin hydration marker', { embedding: vec(1, 2, 3, 4), tier: 'cold' }),
    );
    await store.close();
    for (const f of fs.readdirSync(coldDir))
      if (f.endsWith('.zst')) fs.rmSync(path.join(coldDir, f));
    const warnings: string[] = [];
    await runEval({
      rows: [{ question: 'zeppelin', expectedMemoryIds: ['c1'] }],
      storePath: dbPath,
      coldDir,
      dimension: DIM,
      now: new Date(NOW),
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/1 cold blob/);
    expect(warnings[0]).not.toContain('c1');
  });

  it('eval.abstain-threshold', async () => {
    const { dbPath, coldDir } = await handBuiltStore();
    const rows: EvalRow[] = [
      { question: 'auth port', expectedMemoryIds: [], category: 'abstention' },
    ];
    const base = { rows, storePath: dbPath, coldDir, dimension: DIM, now: new Date(NOW) };
    // No threshold: any returned memory is a false positive.
    expect((await runEval(base)).groups['abstention']?.abstainFp).toBe(1);
    // Fused scores here are small (RRF scaled by at most 1.05); a high cut-off suppresses them.
    expect((await runEval({ ...base, abstainThreshold: 10 })).groups['abstention']?.abstainFp).toBe(
      0,
    );
    expect(
      (await runEval({ ...base, abstainThreshold: -10 })).groups['abstention']?.abstainFp,
    ).toBe(1);
  });

  it('eval.relevance-gate-on-the-demo-fixture', async () => {
    // CON-45 acceptance: abstention false positives at most 0.1, single-fact recall@5 down by at
    // most 0.05 against no gate. Lexical-only and with the fake dense path.
    const dir = fs.mkdtempSync(path.join(root, 'demo-'));
    const dbPath = path.join(dir, 'oort.sqlite');
    const coldDir = path.join(dir, 'cold');
    const store = await openSqliteStore({ path: dbPath, coldDir, dimension: 512, log: () => {} });
    await seedStore(store, generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
    await store.close();
    const { rows } = loadEvalRows(
      fs.readFileSync(fileURLToPath(new URL('../eval/fixture.jsonl', import.meta.url)), 'utf8'),
    );
    for (const embed of [undefined, fakeEmbedder(512)]) {
      const base = {
        rows,
        storePath: dbPath,
        coldDir,
        now: GENERATOR_NOW,
        ...(embed !== undefined && { embed }),
      };
      const gated = await runEval(base);
      const open = await runEval({ ...base, gate: false });
      expect(open.groups['abstention']?.abstainFp).toBe(1);
      expect(gated.groups['abstention']?.abstainFp).toBeLessThanOrEqual(0.1);
      const r5 = (r: typeof gated) => r.groups['single-fact']?.recallAt[5] ?? 0;
      expect(r5(gated)).toBeGreaterThanOrEqual(r5(open) - 0.05);
      expect(gated.groups['overall']?.recallAt[5]).toBeGreaterThanOrEqual(
        (open.groups['overall']?.recallAt[5] ?? 0) - 0.05,
      );
    }
  }, 60_000);

  it('fixture.single-fact-questions-have-unique-answers', () => {
    const memories = generateMemories(FIXTURE_COUNT, FIXTURE_SEED);
    const rows = buildFixtureRows(memories).filter((r) => r.category === 'single-fact');
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      const qt = new Set(tokenizeLexical(r.question));
      expect(qt.size).toBeGreaterThan(0);
      const answers = memories.filter((m) => {
        const have = new Set(tokenizeLexical(m.text));
        return [...qt].every((t) => have.has(t));
      });
      expect(
        answers.map((m) => m.id),
        r.question,
      ).toEqual(r.expectedMemoryIds);
    }
  });

  it('eval.fixture-in-sync', () => {
    const file = new URL('../eval/fixture.jsonl', import.meta.url);
    const expected = buildFixtureRows(generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
    expect(expected).toHaveLength(20);
    expect(loadEvalRows(fs.readFileSync(file, 'utf8')).rows).toEqual(expected);
  });
});
