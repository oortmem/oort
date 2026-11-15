import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { OortConfig } from '@oortmem/core';
import { compareFiles } from './compare.js';
import { loadEvalRows, runEval } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { fakeReranker } from './fake-rerank.js';
import { demoMemories } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW } from './generate.js';
import {
  checkSweepable,
  defaultGates,
  gateLabel,
  keptHits,
  renderSweep,
  simulateLine,
  sweepFile,
  sweepGate,
  type Gate,
} from './gate-sweep.js';
import { loadLongMemEval } from './longmemeval.js';
import {
  parseQuestionResults,
  roundScore,
  toJsonl,
  type QuestionResult,
  type QuestionScores,
} from './per-question.js';
import { runPublicSet, type PublicSet } from './public-sets.js';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { seedStore } from './seed.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-gate-sweep-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const SAMPLE_LME = fileURLToPath(
  new URL('../eval/public/longmemeval-sample.json', import.meta.url),
);
const lme = (): PublicSet =>
  loadLongMemEval(JSON.parse(fs.readFileSync(SAMPLE_LME, 'utf8')) as unknown);

const DEFAULTS = OortConfig.parse({}).recall;
const FLOORS = { coverage: DEFAULTS.minCoverage, dense: DEFAULTS.minDenseScore };
const TODAY: Gate = { kind: 'fixed', t: DEFAULTS.minRerankScore };

/** The next double below `x`. */
function below(x: number): number {
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  b[0] = (b[0] as bigint) - 1n;
  return f[0] as number;
}

/** What a simulated line is compared on: everything the totals and `compare` read. */
const scored = (l: QuestionResult) => ({
  level: l.level,
  id: l.id,
  ranks: l.ranks,
  staleRanks: l.staleRanks,
  returned: l.returned,
  metrics: l.metrics,
});

const OFF = { rerank: 0, coverage: 0, dense: 0 };
/** A line with given per-hit scores; `expected[i]` names which expected id hit i is. */
function line(
  over: Omit<Partial<QuestionResult>, 'scores'> & { scores: Partial<QuestionScores> },
): QuestionResult {
  const n = over.scores.rerank?.length ?? over.scores.coverage?.length ?? 0;
  const scores: QuestionScores = {
    gate: OFF,
    rerank: Array.from({ length: n }, () => null),
    coverage: Array.from({ length: n }, () => 1),
    dense: Array.from({ length: n }, () => null),
    expected: Array.from({ length: n }, () => null),
    ...over.scores,
  };
  const { scores: _, ...rest } = over;
  return {
    run: 'links=off,speed=full',
    level: 'turn',
    id: 'q',
    group: 'g',
    question: 'q?',
    ranks: [],
    returned: n,
    aboveThreshold: n,
    linked: 0,
    linkedExpected: 0,
    metrics: { 'recall@10': null, abstainFp: null },
    ...rest,
    scores,
  };
}

describe('per-question scores', () => {
  it('scores.rounding-keeps-every-4-decimal-threshold-comparison', () => {
    const xs = [0.35, below(0.35), 0.34995, 0.349949999, 1 / 3, 2 / 3, 0.5, below(0.5), 0, 1, 0.6];
    let seed = 7;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      xs.push(seed / 2 ** 31);
    }
    for (const x of xs) {
      const r = roundScore(x);
      expect(r).toBeLessThanOrEqual(x);
      expect(Math.abs(r - x)).toBeLessThan(1.0001e-4);
      expect(Number(r.toFixed(4))).toBe(r);
      for (let j = 0; j <= 10_000; j += 1) {
        const t = j / 10_000;
        if (r >= t !== x >= t) throw new Error(`x=${x} r=${r} t=${t}`);
      }
    }
  });

  it('scores.public-run-writes-each-hit-score-and-which-hits-are-expected', async () => {
    const r = await runPublicSet({
      set: lme(),
      embed: fakeEmbedder(EMBEDDING_DIMENSION),
      rerank: fakeReranker(),
      gate: false,
    });
    const turn = r.perQuestion.filter((l) => l.level === 'turn');
    expect(r.perQuestion.some((l) => l.scores?.rerank.some((x) => x !== null))).toBe(true);
    for (const l of r.perQuestion) {
      const s = l.scores as QuestionScores;
      expect(s.gate).toEqual(OFF);
      expect(s.rerank).toHaveLength(l.returned);
      expect(s.coverage).toHaveLength(l.returned);
      expect(s.dense).toHaveLength(l.returned);
      expect(s.expected).toHaveLength(l.returned);
      // A reranked question has a score for every hit, best first; one whose rerank was
      // skipped (fusion confident) has none.
      const n = s.rerank.filter((x) => x !== null).length;
      expect([0, l.returned]).toContain(n);
      expect([...s.rerank].sort((a, b) => (b as number) - (a as number))).toEqual(s.rerank);
      // The ranks are where the expected hits sit.
      l.ranks.forEach((rank, j) => {
        if (rank !== null) expect(s.expected[rank - 1]).toBe(j);
      });
      expect(s.expected.filter((e) => e !== null).length).toBeGreaterThanOrEqual(
        l.ranks.filter((x) => x !== null).length,
      );
    }
    const ku = turn.find((l) => l.id === 'sample-ku') as QuestionResult;
    expect(ku.scores?.stale).toHaveLength(ku.returned);
    // A gated run records its thresholds, so the sweep can refuse it.
    const gated = await runPublicSet({ set: lme(), rerank: fakeReranker() });
    expect(gated.perQuestion[0]?.scores?.gate).toEqual({
      rerank: DEFAULTS.minRerankScore,
      coverage: DEFAULTS.minCoverage,
      dense: DEFAULTS.minDenseScore,
    });
  });

  it('scores.older-lines-without-scores-still-parse-and-compare', () => {
    const old = {
      run: 'links=off,speed=full',
      level: 'turn',
      id: 'a',
      group: 'g',
      question: 'q',
      ranks: [1],
      returned: 1,
      aboveThreshold: 1,
      linked: 0,
      linkedExpected: 0,
      metrics: { 'recall@10': 1 },
    };
    const fa = path.join(root, 'old.questions.jsonl');
    const fb = path.join(root, 'new.questions.jsonl');
    fs.writeFileSync(fa, `${JSON.stringify(old)}\n`);
    const withScores = line({ id: 'a', group: 'g', question: 'q', scores: { rerank: [0.9] } });
    fs.writeFileSync(fb, toJsonl([{ ...withScores, ranks: [1], metrics: { 'recall@10': 1 } }]));
    expect(parseQuestionResults(fs.readFileSync(fa, 'utf8'))[0]?.scores).toBeUndefined();
    expect(compareFiles(fa, fb)).toMatch(/\| overall \| recall@10 \| 1 \|/);
    // The sweep needs the scores, and says how to get them.
    expect(() => sweepFile(fa)).toThrow(/no per-hit scores.*--no-gate/s);
  });
});

describe('gate simulation', () => {
  it('gate.fixed-drops-each-hit-below-the-threshold-as-recall-does', () => {
    const s = line({ scores: { rerank: [0.9, 0.5, 0.35, below(0.35), 0.1] } }).scores!;
    expect(keptHits(s, { kind: 'fixed', t: 0.35 }, FLOORS)).toEqual([0, 1, 2]);
    expect(keptHits(s, { kind: 'fixed', t: 0 }, FLOORS)).toEqual([0, 1, 2, 3, 4]);
    expect(keptHits(s, { kind: 'fixed', t: 0.95 }, FLOORS)).toEqual([]);
  });

  it('gate.without-a-rerank-score-the-coverage-or-dense-test-decides', () => {
    // A fast run, or a rerank skipped as confident: no rerank scores.
    const s = line({
      scores: { coverage: [1, 0.5, 0.4, 0.2, 0.2], dense: [null, null, 0.7, 0.6, null] },
    }).scores!;
    for (const g of [
      { kind: 'fixed', t: 0.35 },
      { kind: 'fixed', t: 0.9 },
      { kind: 'top', t: 0.9 },
      { kind: 'margin', d: 0.5, floor: 0.9 },
    ] as Gate[]) {
      expect(keptHits(s, g, FLOORS)).toEqual([0, 1, 2, 3]);
    }
    expect(keptHits(s, TODAY, { coverage: 0, dense: 0.6 })).toEqual([0, 1, 2, 3, 4]);
    expect(keptHits(s, TODAY, { coverage: 0.5, dense: 0 })).toEqual([0, 1]);
  });

  it('gate.top-returns-everything-or-nothing', () => {
    const s = line({ scores: { rerank: [0.5, 0.2, 0.05] } }).scores!;
    expect(keptHits(s, { kind: 'top', t: 0.5 }, FLOORS)).toEqual([0, 1, 2]);
    expect(keptHits(s, { kind: 'top', t: 0.51 }, FLOORS)).toEqual([]);
  });

  it('gate.margin-abstains-on-a-close-or-low-top-and-floors-the-rest', () => {
    const s = line({ scores: { rerank: [0.6, 0.45, 0.2] } }).scores!;
    const m = (d: number, floor: number) => keptHits(s, { kind: 'margin', d, floor }, FLOORS);
    expect(m(0.1, 0.3)).toEqual([0, 1]);
    expect(m(0.2, 0.3)).toEqual([]); // 0.6 - 0.45 < 0.2
    expect(m(0.1, 0.65)).toEqual([]); // top under the floor
    expect(m(0, 0.3)).toEqual(keptHits(s, { kind: 'fixed', t: 0.3 }, FLOORS));
    // One hit: the margin is the top score itself.
    const one = line({ scores: { rerank: [0.3] } }).scores!;
    expect(keptHits(one, { kind: 'margin', d: 0.25, floor: 0.1 }, FLOORS)).toEqual([0]);
    expect(keptHits(one, { kind: 'margin', d: 0.35, floor: 0.1 }, FLOORS)).toEqual([]);
  });

  it('gate.labels', () => {
    expect(gateLabel({ kind: 'fixed', t: 0.35 })).toBe('fixed 0.35');
    expect(gateLabel({ kind: 'top', t: 0.4 })).toBe('top 0.40');
    expect(gateLabel({ kind: 'margin', d: 0.1, floor: 0.3 })).toBe('margin 0.10, floor 0.30');
    const gates = defaultGates(0.05, [0.05, 0.1]);
    expect(gates.filter((g) => g.kind === 'fixed')).toHaveLength(20);
    expect(gates.filter((g) => g.kind === 'top')).toHaveLength(20);
    expect(gates.filter((g) => g.kind === 'margin')).toHaveLength(40);
    expect(gates.map(gateLabel)).toContain('fixed 0.35');
  });

  it('gate.simulated-line-rescores-ranks-and-metrics', () => {
    // Hits: an expected id at 2, a stale one at 1, another expected at 4.
    const l = line({
      group: 'knowledge-update',
      ranks: [2, 4, null],
      staleRanks: [1],
      metrics: { 'recall@10': 1, mrr: 1, staleAboveCurrent: 0 },
      scores: {
        rerank: [0.8, 0.7, 0.3, 0.2],
        expected: [null, 0, null, 1],
        stale: [0, null, null, null],
      },
    });
    const sim = simulateLine(l, TODAY, FLOORS);
    expect(sim.ranks).toEqual([2, null, null]);
    expect(sim.staleRanks).toEqual([1]);
    expect(sim.returned).toBe(2);
    expect(sim.metrics['recall@10']).toBeCloseTo(1 / 3);
    expect(sim.metrics['mrr']).toBe(0.5);
    expect(sim.metrics['staleAboveCurrent']).toBe(1);
    const abs = line({ abstention: true, scores: { rerank: [0.3] } });
    expect(simulateLine(abs, TODAY, FLOORS).metrics['abstainFp']).toBe(0);
    expect(simulateLine(abs, { kind: 'fixed', t: 0.3 }, FLOORS).metrics['abstainFp']).toBe(1);
  });
});

describe('simulated gate matches a gated run', () => {
  const check = (open: QuestionResult[], gated: QuestionResult[]) => {
    checkSweepable(open);
    const sim = open.map((l) => simulateLine(l, TODAY, FLOORS));
    expect(sim.map(scored)).toEqual(gated.map(scored));
    // Not vacuous: the gate changed something in this run.
    expect(open.map(scored)).not.toEqual(gated.map(scored));
  };

  it('simulate.longmemeval-sample-full-speed-with-the-fake-reranker', async () => {
    const opts = {
      set: lme(),
      embed: fakeEmbedder(EMBEDDING_DIMENSION),
      rerank: fakeReranker(),
      ks: [1, 5, 10],
    };
    const open = await runPublicSet({ ...opts, gate: false });
    const gated = await runPublicSet(opts);
    check(open.perQuestion, gated.perQuestion);
  });

  it('simulate.longmemeval-sample-fast-speed-without-a-reranker', async () => {
    const opts = {
      set: lme(),
      embed: fakeEmbedder(EMBEDDING_DIMENSION),
      rerank: fakeReranker(),
      speed: 'fast' as const,
      ks: [1, 5, 10],
    };
    const open = await runPublicSet({ ...opts, gate: false });
    const gated = await runPublicSet(opts);
    expect(open.perQuestion.every((l) => l.scores?.rerank.every((x) => x === null))).toBe(true);
    check(open.perQuestion, gated.perQuestion);
  });

  it('simulate.demo-fixture-with-the-fake-reranker', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'demo-'));
    const storePath = path.join(dir, 'oort.sqlite');
    const coldDir = path.join(dir, 'cold');
    const store = await openSqliteStore({
      path: storePath,
      coldDir,
      dimension: EMBEDDING_DIMENSION,
      log: () => {},
    });
    await seedStore(store, demoMemories());
    await store.close();
    const opts = {
      rows: loadEvalRows(fs.readFileSync(new URL('../eval/fixture.jsonl', import.meta.url), 'utf8'))
        .rows,
      storePath,
      coldDir,
      ks: [1, 5, 10],
      now: GENERATOR_NOW,
      embed: fakeEmbedder(EMBEDDING_DIMENSION),
      rerank: fakeReranker(),
      // A loaded machine must not time the reranker out in one run and not the other.
      recall: { rerankBudgetMs: 0 },
      warn: () => {},
    };
    const open = await runEval({ ...opts, gate: false });
    const gated = await runEval(opts);
    check(open.perQuestion ?? [], gated.perQuestion ?? []);
  });
});

describe('sweep', () => {
  /** Ten answerable questions and four abstention ones, with known scores. */
  const lines = (): QuestionResult[] => {
    const out: QuestionResult[] = [];
    for (let i = 0; i < 10; i++) {
      // The expected hit scores 0.3 + i * 0.05, behind a distractor at 0.2.
      const top = (30 + i * 5) / 100;
      out.push(
        line({
          id: `a${i}`,
          group: i < 5 ? 'single' : 'multi',
          ranks: [1],
          metrics: { 'recall@10': 1, abstainFp: null },
          scores: { rerank: [top, 0.2], expected: [0, null] },
        }),
      );
    }
    for (let i = 0; i < 4; i++) {
      out.push(
        line({
          id: `x${i}`,
          group: 'abstention',
          abstention: true,
          metrics: { 'recall@10': null, abstainFp: 1 },
          scores: { rerank: [(25 + i * 10) / 100, 0.24] },
        }),
      );
    }
    return out;
  };

  it('sweep.reports-recall-and-false-positives-against-today', () => {
    const s = sweepGate(lines(), { resamples: 200, seed: 1 });
    expect(s.baseline).toBe('fixed 0.35');
    const row = (label: string) => s.rows.find((r) => r.gate === label)!;
    const today = row('fixed 0.35');
    // Expected hits at 0.30 .. 0.75: 0.30 is under 0.35.
    expect(today.levels[0]?.recall10).toBeCloseTo(0.9);
    // Abstention tops at 0.25, 0.35, 0.45, 0.55: three return something.
    expect(today.abstainFp).toBeCloseTo(0.75);
    expect(today.levels[0]?.recallDiff).toEqual({ mean: 0, lo: 0, hi: 0 });
    const strict = row('fixed 0.50');
    expect(strict.levels[0]?.recall10).toBeCloseTo(0.6);
    expect(strict.abstainFp).toBeCloseTo(0.25);
    expect(strict.levels[0]?.recallDiff?.mean).toBeCloseTo(-0.3);
    expect(strict.levels[0]?.recallDiff?.lo).toBeLessThan(0);
    expect(strict.fpDiff?.mean).toBeCloseTo(-0.5);
    // Today's gate also drops the distractor; top-score abstention keeps it.
    expect(today.levels[0]?.hits).toBeCloseTo(0.9);
    expect(row('top 0.35').levels[0]?.hits).toBeCloseTo(1.8);
    expect(row('top 0.35').abstainFp).toBeCloseTo(0.75);
    expect(today.groups['single']).toBeCloseTo(0.8);
    expect(today.groups['multi']).toBe(1);
  });

  it('sweep.marks-the-pareto-front', () => {
    const s = sweepGate(lines(), { resamples: 50 });
    for (const r of s.rows) {
      const dominated = s.rows.some(
        (o) =>
          o.levels[0]!.recall10! >= r.levels[0]!.recall10! &&
          o.abstainFp! <= r.abstainFp! &&
          (o.levels[0]!.recall10! > r.levels[0]!.recall10! || o.abstainFp! < r.abstainFp!),
      );
      expect(r.front).toBe(!dominated);
    }
    expect(s.rows.some((r) => r.front)).toBe(true);
    // Abstention tops lead the next hit by 0.01 to 0.31, answerable ones by at least 0.10.
    expect(s.rows.find((r) => r.gate === 'margin 0.02, floor 0.00')?.front).toBe(true);
    expect(s.rows.find((r) => r.gate === 'fixed 0.00')?.front).toBe(false);
  });

  it('sweep.is-deterministic-and-renders-a-table', () => {
    const file = path.join(root, 'sweep.questions.jsonl');
    fs.writeFileSync(file, toJsonl(lines()));
    const a = sweepFile(file, { resamples: 300 });
    expect(sweepFile(file, { resamples: 300 })).toBe(a);
    expect(a).toMatch(/\| Gate \| Front \|/);
    expect(a).toMatch(/\| fixed 0\.35 \(today\) \|/);
    expect(JSON.parse(sweepFile(file, { resamples: 300, json: true })).baseline).toBe('fixed 0.35');
    const text = renderSweep(sweepGate(lines(), { resamples: 10 }));
    expect(text).toMatch(/interval/);
    // The per-group table leaves out the abstention group, which has no recall.
    expect(text).toMatch(/\| Gate \| single \| multi \|\n/);
  });

  it('sweep.refuses-what-it-cannot-simulate', () => {
    const gated = lines().map((l) => ({
      ...l,
      scores: { ...l.scores!, gate: { rerank: 0.35, coverage: 0.5, dense: 0.6 } },
    }));
    expect(() => checkSweepable(gated)).toThrow(/gate on.*--no-gate/s);
    const linked = lines();
    linked[0] = { ...linked[0]!, scores: { ...linked[0]!.scores!, linked: [1] } };
    expect(() => checkSweepable(linked)).toThrow(/link.*--links off/s);
    const cut = lines();
    cut[0] = { ...cut[0]!, returned: 60 };
    expect(() => checkSweepable(cut)).toThrow(/--k at most 50/);
    const stop = lines();
    stop[0] = { ...stop[0]!, scores: { ...stop[0]!.scores!, adaptiveStop: true } };
    expect(() => checkSweepable(stop)).toThrow(/adaptive stop/);
    const two = [...lines(), ...lines().map((l) => ({ ...l, run: 'links=off,speed=fast' }))];
    const file = path.join(root, 'two.questions.jsonl');
    fs.writeFileSync(file, toJsonl(two));
    expect(() => sweepFile(file, { resamples: 10 })).toThrow(/--run/);
    // A run without a reranker: every gate is the coverage test, so only the baseline is shown.
    const fast = lines().map((l) => ({
      ...l,
      scores: { ...l.scores!, rerank: l.scores!.rerank.map(() => null) },
    }));
    const s = sweepGate(fast, { resamples: 10 });
    expect(s.reranked).toBe(false);
    expect(s.rows.map((r) => r.gate)).toEqual(['fixed 0.35']);
    expect(renderSweep(s)).toMatch(/no reranker/);
    expect(sweepFile(file, { resamples: 10, run: 'links=off,speed=fast' })).toMatch(/speed=fast/);
  });
});
