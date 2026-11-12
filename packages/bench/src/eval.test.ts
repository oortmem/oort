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
import {
  belowMinRecall10,
  computeMetrics,
  loadEvalRows,
  renderReport,
  renderRun,
  runEval,
  type EvalRow,
} from './eval.js';
import {
  buildDemoRows,
  buildFixtureRows,
  buildHookRows,
  buildWarmUpRows,
  demoMemories,
  FIXTURE_COUNT,
  FIXTURE_SEED,
} from './fixture.js';
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
    await seedStore(store, demoMemories());
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
      // CON-34: changed facts and questions about time (0.25 and 0.00 before, both paths; now
      // 1.00 and 1.00 lexical-only, 0.50 and 1.00 with the fake dense path).
      expect(gated.groups['knowledge-update']?.recallAt[5]).toBeGreaterThanOrEqual(0.5);
      expect(gated.groups['temporal']?.recallAt[5]).toBeGreaterThanOrEqual(0.75);
      expect(gated.groups['temporal']?.staleLeak).toBe(0);
    }
  }, 60_000);

  it('eval.binary-vector-index-and-the-adaptive-stop (CON-17)', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'binary-'));
    const dbPath = path.join(dir, 'oort.sqlite');
    const coldDir = path.join(dir, 'cold');
    const store = await openSqliteStore({ path: dbPath, coldDir, dimension: 512, log: () => {} });
    await seedStore(store, generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
    await store.close();
    const { rows } = loadEvalRows(
      fs.readFileSync(fileURLToPath(new URL('../eval/fixture.jsonl', import.meta.url)), 'utf8'),
    );
    const base = { rows, storePath: dbPath, coldDir, now: GENERATOR_NOW, embed: fakeEmbedder(512) };
    const int8 = await runEval({ ...base, vectorIndex: 'int8' });
    const binary = await runEval({ ...base, vectorIndex: 'binary' });
    expect(int8.vectorIndex).toEqual({ index: 'int8', vectors: FIXTURE_COUNT });
    expect(binary.vectorIndex).toEqual({ index: 'binary', vectors: FIXTURE_COUNT });
    const r10 = (r: typeof int8) => r.groups['overall']?.recallAt[10] ?? 0;
    expect(r10(binary)).toBeGreaterThanOrEqual(r10(int8) - 0.01);
    // A third of the memories archived: the stop leaves cold matches out, and loses no recall.
    const cold = { ...base, coldShare: 1 / 3 };
    const widened = await runEval({ ...cold, recall: { adaptiveStop: 'off' } });
    const stopped = await runEval(cold);
    expect(widened.reads).toMatchObject({ asked: 0, stopped: 0 });
    expect(widened.reads?.hydrated).toBeGreaterThan(0);
    expect(stopped.reads?.stopped).toBeGreaterThan(0);
    expect(stopped.reads?.hydrated).toBeLessThan(widened.reads?.hydrated ?? 0);
    expect(r10(stopped)).toBeGreaterThanOrEqual(r10(widened));
  }, 120_000);

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

  it('fixture.chain-questions-name-their-chain', () => {
    const memories = generateMemories(FIXTURE_COUNT, FIXTURE_SEED);
    const byId = new Map(memories.map((m) => [m.id, m]));
    const rows = buildFixtureRows(memories);
    const chained = rows.filter(
      (r) => r.category === 'knowledge-update' || r.category === 'temporal',
    );
    expect(chained).toHaveLength(10);
    for (const r of chained) {
      // The subject is named as the memories name it, so the question has one chain as its answer.
      const subject = byId.get(r.expectedMemoryIds[0]!)?.entities[0] ?? '';
      expect(r.question, r.question).toContain(subject);
    }
    const temporal = rows.filter((r) => r.category === 'temporal');
    // Two dated questions carry no asOf: recall reads the day from the words.
    expect(
      temporal.filter((r) => r.asOf === undefined && /\d{4}$|\d{4},/.test(r.question)),
    ).toHaveLength(2);
    expect(temporal.filter((r) => r.question.includes('changed over time'))).toHaveLength(1);
  });

  it('eval.fixture-in-sync', () => {
    const read = (name: string): EvalRow[] =>
      loadEvalRows(fs.readFileSync(new URL(`../eval/${name}`, import.meta.url), 'utf8')).rows;
    const memories = demoMemories();
    const expected = buildDemoRows(memories);
    expect(expected).toHaveLength(29);
    // The 23 rows from before the multi-hop rows (CON-146) are unchanged.
    expect(expected.slice(0, 23)).toEqual(
      buildFixtureRows(generateMemories(FIXTURE_COUNT, FIXTURE_SEED)),
    );
    expect(read('fixture.jsonl')).toEqual(expected);
    expect(read('hook.jsonl')).toEqual(buildHookRows(memories));
    expect(read('warm-up.jsonl')).toEqual(buildWarmUpRows());
  });

  it('eval.link-precision', () => {
    const rows: EvalRow[] = [
      { question: 'a', expectedMemoryIds: ['x', 'y'], category: 'multi-hop' },
      { question: 'b', expectedMemoryIds: ['z'], category: 'single-fact' },
      { question: 'c', expectedMemoryIds: [], category: 'abstention' },
    ];
    const none = computeMetrics(
      rows,
      rows.map(() => ({ ids: ['x', 'z'], aboveThreshold: 2 })),
      [10],
    );
    expect(none.groups['overall']?.linkPrecision).toBeNull();
    expect(renderReport(none)).toMatch(/\| overall \| 3 \|.* \| - \|$/m);
    const report = computeMetrics(
      rows,
      [
        // Two linked memories in the top 10, one expected; one linked past rank 10 is not counted.
        {
          ids: ['x', 'y', ...Array.from({ length: 9 }, (_, i) => `f${i}`), 'late'],
          aboveThreshold: 12,
          linked: ['y', 'f0', 'late'],
        },
        { ids: ['q'], aboveThreshold: 1, linked: [] },
        { ids: ['w'], aboveThreshold: 1, linked: ['w'] },
      ],
      [10],
    );
    expect(report.groups['overall']?.linkPrecision).toBeCloseTo(1 / 3);
    expect(report.groups['multi-hop']?.linkPrecision).toBeCloseTo(1 / 2);
    expect(report.groups['single-fact']?.linkPrecision).toBeNull();
    expect(report.groups['abstention']?.linkPrecision).toBe(0);
  });

  it('eval.min-recall10-checks-every-links-mode-and-warm-pass', () => {
    const rows: EvalRow[] = [{ question: 'a', expectedMemoryIds: ['x'] }];
    const at = (hit: boolean) =>
      computeMetrics(rows, [{ ids: hit ? ['x'] : ['n'], aboveThreshold: 1 }], [10]);
    const off = { ...at(true), links: 'off' as const };
    const all = { ...at(false), links: 'all' as const };
    expect(belowMinRecall10([off], 0.5)).toEqual([]);
    // A later mode under the bar fails the run, not only the first.
    expect(belowMinRecall10([off, all], 0.5)).toEqual(['links all: recall@10 0.000']);
    // So does a warm pass under the bar.
    const warm = { ...at(true), links: 'off' as const, warm: at(false) };
    expect(belowMinRecall10([warm], 0.5)).toEqual(['links off (warm): recall@10 0.000']);
    expect(belowMinRecall10([off, all], 0)).toEqual([]);
  });

  it('eval.multi-hop-category-parses', () => {
    const { rows } = loadEvalRows(
      '{"question":"q","expectedMemoryIds":["a"],"category":"multi-hop"}\n',
    );
    expect(rows[0]?.category).toBe('multi-hop');
  });

  it('eval.warm-up-records-on-the-copy-only', async () => {
    const { dbPath, coldDir } = await handBuiltStore();
    // The database and its WAL's content. A reader may leave an empty WAL file and touch the -shm
    // index (shared memory every reader maps); neither is a write.
    const digest = (): string =>
      ['', '-wal']
        .map((x) => {
          const f = dbPath + x;
          if (!fs.existsSync(f) || fs.statSync(f).size === 0) return '-';
          return createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        })
        .join(':');
    const before = digest();
    const warmUp: EvalRow[] = [
      { question: 'billing worker pnpm', expectedMemoryIds: [] },
      { question: 'database migrations', expectedMemoryIds: [] },
    ];
    const report = await runEval({
      rows: ROWS,
      warmUp,
      storePath: dbPath,
      coldDir,
      dimension: DIM,
      now: new Date(NOW),
    });
    expect(digest()).toBe(before);
    expect(report.warmUp).toEqual({ rows: 2, accessCalls: 2, accessIds: 2 });
    expect(report.warm?.groups['overall']?.rows).toBe(8);
    expect(report.groups['overall']?.recallAt[10]).toBeCloseTo(0.75);
    expect(renderRun(report)).toContain('Warm (after 2 warm-up question(s)');
    // Without a warm-up the run has one report and records nothing.
    const plain = await runEval({
      rows: ROWS,
      storePath: dbPath,
      coldDir,
      dimension: DIM,
      now: new Date(NOW),
    });
    expect(plain.warm).toBeUndefined();
    expect(plain.links).toBe('off');
  });

  it('eval.warm-up-must-be-disjoint', async () => {
    const { dbPath, coldDir } = await handBuiltStore();
    await expect(
      runEval({
        rows: ROWS,
        warmUp: [{ question: ' Pnpm  installs', expectedMemoryIds: [] }],
        storePath: dbPath,
        coldDir,
        dimension: DIM,
      }),
    ).rejects.toThrow(/disjoint/);
  });

  it('eval.links-on-is-refused-until-links-exist', async () => {
    const { dbPath, coldDir } = await handBuiltStore();
    await expect(
      runEval({ rows: ROWS, links: 'about', storePath: dbPath, coldDir, dimension: DIM }),
    ).rejects.toThrow(/CON-149/);
  });
});
