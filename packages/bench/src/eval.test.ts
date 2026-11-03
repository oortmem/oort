import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localScope, type Memory } from '@oortmem/core';
import { makeMemory } from '@oortmem/core/store-conformance';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { loadEvalRows, runEval, type EvalRow } from './eval.js';
import { buildFixtureRows, FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { generateMemories } from './generate.js';

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
  await store.upsertMany([
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
    expect(all?.rows).toBe(7);
    // Five rows have expected ids: recall@5 = (1 + 1 + 0.5 + 1 + 0) / 5.
    expect(all?.recallAt[5]).toBeCloseTo(0.7);
    expect(all?.recallAt[10]).toBeCloseTo(0.7);
    // First expected hit at rank 1, 1, 1, 1, none.
    expect(all?.mrr).toBeCloseTo(0.8);
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
    const { dbPath, coldDir } = await handBuiltStore();
    const dir = path.dirname(dbPath);
    const snapshot = (): string => {
      const h = createHash('sha256');
      for (const f of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
        else for (const g of fs.readdirSync(p).sort()) h.update(`${f}/${g}`);
      }
      return h.digest('hex');
    };
    const before = snapshot();
    const mtimeBefore = fs.statSync(dbPath).mtimeMs;
    // Recall records accesses; the run must do that on a copy only.
    const report = await runEval({
      rows: ROWS,
      storePath: dbPath,
      coldDir,
      dimension: DIM,
      ks: [5, 10],
      now: new Date(NOW),
    });
    expect(report.groups['overall']?.rows).toBe(7);
    expect(snapshot()).toBe(before);
    expect(fs.statSync(dbPath).mtimeMs).toBe(mtimeBefore);
  });

  it('eval.fixture-in-sync', () => {
    const file = new URL('../eval/fixture.jsonl', import.meta.url);
    const expected = buildFixtureRows(generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
    expect(expected).toHaveLength(20);
    expect(loadEvalRows(fs.readFileSync(file, 'utf8')).rows).toEqual(expected);
  });
});
