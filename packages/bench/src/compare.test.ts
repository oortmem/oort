import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bootstrapMean,
  compareFiles,
  compareRuns,
  pickRuns,
  renderComparison,
  signTest,
} from './compare.js';
import { toJsonl, type QuestionResult } from './per-question.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-compare-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A per-question line with only what compare reads. */
const q = (
  id: string,
  metrics: Record<string, number | null>,
  over: Partial<QuestionResult> = {},
): QuestionResult => ({
  run: 'links=off,speed=full',
  level: 'turn',
  id,
  group: 'multi-session',
  question: `question ${id}`,
  ranks: [],
  returned: 0,
  aboveThreshold: 0,
  linked: 0,
  linkedExpected: 0,
  metrics,
  ...over,
});

describe('sign test', () => {
  it('compare.sign-test-exact-binomial', () => {
    // 9 up, 1 down: 2 * (C(10,0) + C(10,1)) / 2^10.
    const t = signTest([...Array(9).fill(1), -1]);
    expect(t).toMatchObject({ up: 9, down: 1, ties: 0 });
    expect(t.p).toBeCloseTo(22 / 1024, 15);
    expect(signTest(Array(10).fill(0.5)).p).toBeCloseTo(2 / 1024, 12);
    // Larger n stays exact (reference values from exact integer arithmetic).
    expect(signTest([...Array(300).fill(1), ...Array(200).fill(-1)]).p).toBeCloseTo(
      8.940066542253267e-6,
      15,
    );
    expect(signTest([...Array(60).fill(0.1), ...Array(40).fill(-0.2)]).p).toBeCloseTo(
      0.05688793364098079,
      12,
    );
  });

  it('compare.sign-test-leaves-ties-out', () => {
    // Ties count for nothing: 9 up, 1 down and 40 unchanged is the same test as 9 and 1.
    const t = signTest([...Array(9).fill(1), -1, ...Array(40).fill(0)]);
    expect(t).toMatchObject({ up: 9, down: 1, ties: 40 });
    expect(t.p).toBeCloseTo(22 / 1024, 15);
    // An even split is capped at 1, and so is no movement at all.
    expect(signTest([1, 1, 1, -1, -1, 0]).p).toBe(1);
    expect(signTest([0, 0, 0])).toEqual({ up: 0, down: 0, ties: 3, p: 1 });
  });
});

describe('bootstrap', () => {
  it('compare.bootstrap-is-seeded-and-deterministic', () => {
    const diffs = [1, 0, 0, 1, 1, 0, 1, 1, 1, 0, -1, 0];
    const a = bootstrapMean(diffs, { resamples: 2000, seed: 7 });
    expect(bootstrapMean(diffs, { resamples: 2000, seed: 7 })).toEqual(a);
    expect(a.mean).toBeCloseTo(5 / 12, 12);
    expect(a.lo).toBeLessThan(a.mean);
    expect(a.hi).toBeGreaterThan(a.mean);
    // Pinned: the same input, seed and count print this interval on every engine.
    expect([a.lo, a.hi]).toEqual([1 / 12, 3 / 4]);
  });

  it('compare.bootstrap-of-a-constant-is-that-constant', () => {
    expect(bootstrapMean(Array(25).fill(0.25), { resamples: 500 })).toEqual({
      mean: 0.25,
      lo: 0.25,
      hi: 0.25,
    });
    // All ties: no difference, and an interval of exactly zero.
    expect(bootstrapMean([0, 0, 0, 0])).toEqual({ mean: 0, lo: 0, hi: 0 });
    expect(() => bootstrapMean([])).toThrow(/no paired questions/);
  });
});

describe('compareRuns', () => {
  const a = [
    q('1', { 'recall@10': 0, mrr: 0, staleLeak: null }),
    q('2', { 'recall@10': 1, mrr: 0.5, staleLeak: null }),
    q('3', { 'recall@10': 0.5, mrr: 1, staleLeak: 1 }, { group: 'knowledge-update' }),
  ];
  const b = [
    q('1', { 'recall@10': 1, mrr: 1, staleLeak: null }),
    q('2', { 'recall@10': 1, mrr: 0.5, staleLeak: null }),
    q('3', { 'recall@10': 1, mrr: 1, staleLeak: 0 }, { group: 'knowledge-update' }),
  ];

  it('compare.pairs-questions-per-metric-and-group', () => {
    const c = compareRuns(a, b, { resamples: 200 });
    expect(c.questions).toBe(3);
    const row = (group: string, metric: string) =>
      c.rows.find((r) => r.group === group && r.metric === metric);
    expect(row('overall', 'recall@10')).toMatchObject({
      level: 'turn',
      n: 3,
      a: 0.5,
      b: 1,
      sign: { up: 2, down: 0, ties: 1, p: 0.5 },
    });
    expect(row('overall', 'recall@10')?.diff.mean).toBeCloseTo(0.5);
    // A metric a question does not count toward is left out of its pairs.
    expect(row('overall', 'staleLeak')).toMatchObject({ n: 1, a: 1, b: 0 });
    expect(row('multi-session', 'staleLeak')).toBeUndefined();
    expect(row('knowledge-update', 'mrr')).toMatchObject({ n: 1, sign: { ties: 1, p: 1 } });
    const text = renderComparison(c);
    expect(text).toContain('| overall | recall@10 | 3 | 0.500 | 1.000 | +0.500 |');
    expect(text).toContain('2 / 0 / 1 | 0.500 |');
  });

  it('compare.mismatched-question-sets-error-clearly', () => {
    expect(() => compareRuns(a, b.slice(0, 2), { labels: ['A', 'B'] })).toThrow(
      /did not ask the same questions: 1 only in A \(turn 3\), 0 only in B\..*same --limit/,
    );
    expect(() => compareRuns(a, [...b, q('9', {})], { labels: ['A', 'B'] })).toThrow(
      /0 only in A, 1 only in B \(turn 9\)/,
    );
    const renamed = b.map((x) => (x.id === '2' ? { ...x, question: 'another question' } : x));
    expect(() => compareRuns(a, renamed)).toThrow(/1 question id\(s\) name a different question/);
    expect(() => compareRuns([...a, a[0] as QuestionResult], b, { labels: ['A', 'B'] })).toThrow(
      /A lists question 1 \(turn\) more than once/,
    );
  });

  it('compare.levels-are-compared-apart', () => {
    const s = (x: QuestionResult): QuestionResult => ({ ...x, level: 'session' });
    const c = compareRuns([...a, ...a.map(s)], [...b, ...b.map(s)], { resamples: 100 });
    expect(new Set(c.rows.map((r) => r.level))).toEqual(new Set(['turn', 'session']));
    // A session line has no turn twin: the sets differ.
    expect(() => compareRuns([...a, ...a.map(s)], b)).toThrow(/3 only in/);
  });
});

describe('picking runs', () => {
  const off = (id: string) => q(id, { mrr: 0 });
  const on = (id: string) => q(id, { mrr: 1 }, { run: 'links=all,speed=full' });

  it('compare.one-run-a-side-needs-no-name', () => {
    expect(pickRuns([off('1')], [on('1')])).toEqual([
      ['links=off,speed=full', 'links=all,speed=full'],
    ]);
  });

  it('compare.the-same-grid-is-compared-run-by-run', () => {
    const grid = [off('1'), on('1')];
    expect(pickRuns(grid, grid)).toEqual([
      ['links=off,speed=full', 'links=off,speed=full'],
      ['links=all,speed=full', 'links=all,speed=full'],
    ]);
  });

  it('compare.names-pick-runs-from-one-file', () => {
    const grid = [off('1'), on('1')];
    expect(pickRuns(grid, grid, { a: 'links=off,speed=full', b: 'links=all,speed=full' })).toEqual([
      ['links=off,speed=full', 'links=all,speed=full'],
    ]);
    expect(() => pickRuns(grid, [off('1')])).toThrow(/--run-a and --run-b/);
    expect(() => pickRuns(grid, grid, { a: 'links=user', b: 'links=all,speed=full' })).toThrow(
      /--run-a links=user: not in file a/,
    );
  });

  it('compare.files-end-to-end', () => {
    const fa = path.join(root, 'a.questions.jsonl');
    const fb = path.join(root, 'b.questions.jsonl');
    fs.writeFileSync(fa, toJsonl([off('1'), off('2'), on('1'), on('2')]));
    fs.writeFileSync(fb, toJsonl([off('1'), off('2'), on('1'), on('2')]));
    const text = compareFiles(fa, fa, {
      runA: 'links=off,speed=full',
      runB: 'links=all,speed=full',
      resamples: 100,
    });
    expect(text).toContain('| overall | mrr | 2 | 0.000 | 1.000 | +1.000 | +1.000 to +1.000 |');
    // Two files of the same grid: one comparison per run, all ties.
    const json = JSON.parse(compareFiles(fa, fb, { json: true, resamples: 50 })) as unknown[];
    expect(json).toHaveLength(2);
    fs.writeFileSync(fb, toJsonl([off('1')]));
    expect(() => compareFiles(fa, fb, { runA: 'links=off,speed=full' })).toThrow(
      /did not ask the same questions/,
    );
    fs.writeFileSync(fb, '{"run":"x"}\n');
    expect(() => compareFiles(fa, fb)).toThrow(/line 1: level must be a string/);
  });
});
