import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Reranker } from '@oortmem/core';
import { computeMetrics, renderReport, scoreRow, type EvalRow, type RowOutcome } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { fakeReranker } from './fake-rerank.js';
import { EMBEDDING_DIMENSION } from './generate.js';
import { loadLongMemEval, STALE_ORDER_UNKNOWN } from './longmemeval.js';
import {
  parseQuestionResults,
  questionResults,
  questionsPathFor,
  runLabel,
  toJsonl,
} from './per-question.js';
import { parseSpeeds, publicMain, type PublicArgs } from './public-main.js';
import { runPublicSet } from './public-sets.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-per-question-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const SAMPLE_LME = fileURLToPath(
  new URL('../eval/public/longmemeval-sample.json', import.meta.url),
);
const sample = (): Record<string, unknown>[] =>
  JSON.parse(fs.readFileSync(SAMPLE_LME, 'utf8')) as Record<string, unknown>[];

const ku = (over: Partial<EvalRow> = {}): EvalRow => ({
  question: 'where is the service now',
  expectedMemoryIds: ['new'],
  notExpectedMemoryIds: ['old'],
  category: 'knowledge-update',
  ...over,
});
const out = (ids: string[]): RowOutcome => ({ ids, aboveThreshold: ids.length });

describe('stale above current', () => {
  it('stale-above-current.ranks-the-outdated-answer-against-the-current-one', () => {
    const score = (ids: string[], row = ku()) => scoreRow(row, out(ids), [10]).staleAboveCurrent;
    expect(score(['old', 'x', 'new'])).toBe(1);
    expect(score(['new', 'old'])).toBe(0);
    // Only the outdated answer came back: it ranks above a current one that is missing.
    expect(score(['x', 'old'])).toBe(1);
    // Neither came back: the outdated answer is not above the current one.
    expect(score(['x'])).toBe(0);
    // Past the top 10 does not count, as for stale-leak.
    expect(score([...Array.from({ length: 10 }, (_, i) => `f${i}`), 'old'])).toBe(0);
    // Several rounds per answer: the best of each is compared.
    const rounds = ku({ expectedMemoryIds: ['n1', 'n2'], notExpectedMemoryIds: ['o1', 'o2'] });
    expect(score(['n2', 'o1', 'n1'], rounds)).toBe(0);
    expect(score(['o2', 'n1'], rounds)).toBe(1);
  });

  it('stale-above-current.only-for-rows-with-both-answers-and-a-known-order', () => {
    const score = (row: EvalRow) => scoreRow(row, out(['old', 'new']), [10]).staleAboveCurrent;
    expect(score(ku({ notExpectedMemoryIds: undefined }))).toBeNull();
    expect(score(ku({ expectedMemoryIds: [] }))).toBeNull();
    expect(score(ku({ staleOrderUnknown: true }))).toBeNull();
    const rows = [ku(), ku(), ku({ staleOrderUnknown: true }), ku({ category: 'single-fact' })];
    const r = computeMetrics(
      rows,
      [out(['old', 'new']), out(['new', 'old']), out(['old', 'new']), out(['new'])],
      [10],
    );
    // The unknown-order row is left out: one of two, not two of three.
    expect(r.groups['knowledge-update']?.staleAboveCurrent).toBe(0.5);
    // Stale-leak still counts every row that lists an outdated answer.
    expect(r.groups['knowledge-update']?.staleLeak).toBe(1);
    expect(renderReport(r)).toMatch(/\| Stale-leak \| Stale above current \| Abstain FP \|/);
  });

  it('stale-above-current.longmemeval-marks-questions-whose-current-answer-is-not-known', () => {
    const plain = loadLongMemEval(sample());
    const kuQ = plain.haystacks[1]?.questions[0];
    expect(kuQ).toMatchObject({ group: 'knowledge-update', stale: ['k-old#0'] });
    expect(kuQ?.staleOrderUnknown).toBeUndefined();
    // The same question under an id on the list (it asks for the earlier value).
    expect(STALE_ORDER_UNKNOWN['50635ada']).toMatch(/earlier value/);
    const renamed = sample().map((q) =>
      q['question_id'] === 'sample-ku' ? { ...q, question_id: '50635ada' } : q,
    );
    const listed = loadLongMemEval(renamed).haystacks[1]?.questions[0];
    expect(listed).toMatchObject({ staleOrderUnknown: true, stale: ['k-old#0'] });
    // Every listed id is a LongMemEval question id, and each says why.
    for (const [id, why] of Object.entries(STALE_ORDER_UNKNOWN)) {
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      expect(why).not.toBe('');
    }
  });
});

describe('per-question results', () => {
  const rows: EvalRow[] = [
    ku(),
    { question: 'a', expectedMemoryIds: ['x', 'y'], category: 'multi-session' },
    { question: 'b', expectedMemoryIds: ['z'], category: 'single-fact' },
    { question: 'c', expectedMemoryIds: [], category: 'abstention' },
  ];
  const outcomes: RowOutcome[] = [
    out(['old', 'new']),
    { ids: ['q', 'y', 'x'], aboveThreshold: 3, linked: ['y'] },
    out([]),
    { ids: ['w'], aboveThreshold: 0 },
  ];

  it('per-question.ranks-and-the-fields-totals-come-from', () => {
    const lines = questionResults(rows, outcomes, [1, 5, 10], {
      run: 'links=off',
      level: 'memory',
    });
    expect(lines.map((l) => l.id)).toEqual(['1', '2', '3', '4']);
    expect(lines[0]).toMatchObject({
      run: 'links=off',
      level: 'memory',
      group: 'knowledge-update',
      ranks: [2],
      staleRanks: [1],
      metrics: { 'recall@1': 0, 'recall@10': 1, mrr: 0.5, staleLeak: 1, staleAboveCurrent: 1 },
    });
    expect(lines[1]).toMatchObject({
      ranks: [3, 2],
      returned: 3,
      linked: 1,
      linkedExpected: 1,
      metrics: { 'recall@1': 0, 'recall@5': 1, mrr: 0.5, staleLeak: null, abstainFp: null },
    });
    expect(lines[1]?.staleRanks).toBeUndefined();
    expect(lines[2]?.ranks).toEqual([null]);
    expect(lines[3]).toMatchObject({
      abstention: true,
      aboveThreshold: 0,
      metrics: { abstainFp: 0 },
    });
  });

  it('per-question.means-are-the-totals', () => {
    const ks = [1, 5, 10];
    const totals = computeMetrics(rows, outcomes, ks).groups['overall'];
    const lines = questionResults(rows, outcomes, ks, { run: 'r', level: 'memory' });
    const mean = (name: string): number | null => {
      const xs = lines.flatMap((l) =>
        typeof l.metrics[name] === 'number' ? [l.metrics[name]] : [],
      );
      return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    for (const k of ks) expect(mean(`recall@${k}`)).toBeCloseTo(totals?.recallAt[k] as number);
    expect(mean('mrr')).toBeCloseTo(totals?.mrr as number);
    expect(mean('staleLeak')).toBe(totals?.staleLeak);
    expect(mean('staleAboveCurrent')).toBe(totals?.staleAboveCurrent);
    expect(mean('abstainFp')).toBe(totals?.abstainFp);
  });

  it('per-question.jsonl-round-trips-and-names-a-bad-line', () => {
    const lines = questionResults(rows, outcomes, [10], {
      run: runLabel({ links: 'all', speed: 'fast' }),
      level: 'turn',
      ids: ['a', 'b', 'c', 'd'],
    });
    expect(lines[0]?.run).toBe('links=all,speed=fast');
    const text = toJsonl(lines);
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(4);
    expect(parseQuestionResults(text)).toEqual(JSON.parse(JSON.stringify(lines)));
    expect(() => parseQuestionResults(`${text}not json\n`, 'x.jsonl')).toThrow(
      /x\.jsonl, line 5: not valid JSON/,
    );
    const bad = { ...lines[0], ranks: [0] };
    expect(() => parseQuestionResults(JSON.stringify(bad))).toThrow(/line 1: ranks/);
    expect(questionsPathFor('/r/run.json')).toBe('/r/run.questions.jsonl');
    expect(questionsPathFor('/r/run')).toBe('/r/run.questions.jsonl');
  });
});

describe('public sets: per-question lines and speed', () => {
  const set = loadLongMemEval(sample());

  it('per-question.public-run-writes-turn-and-session-lines', async () => {
    const r = await runPublicSet({ set, ks: [5, 10] });
    expect(r.speed).toBe('full');
    const turn = r.perQuestion.filter((l) => l.level === 'turn');
    const session = r.perQuestion.filter((l) => l.level === 'session');
    expect(turn.map((l) => l.id)).toEqual(['sample-ms', 'sample-ku', 'sample-ku_abs']);
    // Abstention questions have no answer sessions to score.
    expect(session.map((l) => l.id)).toEqual(['sample-ms', 'sample-ku']);
    expect(new Set(r.perQuestion.map((l) => l.run))).toEqual(new Set(['links=off,speed=full']));
    const kuLine = session.find((l) => l.id === 'sample-ku');
    expect(kuLine?.group).toBe('knowledge-update');
    expect(kuLine?.staleRanks).toHaveLength(1);
    expect(kuLine?.metrics['staleAboveCurrent']).not.toBeUndefined();
    expect(r.session?.groups['knowledge-update']?.staleAboveCurrent).toBe(
      kuLine?.metrics['staleAboveCurrent'],
    );
  });

  it('speed.fast-leaves-the-reranker-out', async () => {
    const base = fakeReranker();
    let calls = 0;
    const rerank: Reranker = {
      rerank: (...a) => {
        calls++;
        return base.rerank(...a);
      },
    };
    const embed = fakeEmbedder(EMBEDDING_DIMENSION);
    const full = await runPublicSet({ set, embed, rerank, gate: false });
    expect(calls).toBeGreaterThan(0);
    calls = 0;
    const fast = await runPublicSet({ set, embed, rerank, gate: false, speed: 'fast' });
    expect(calls).toBe(0);
    expect(fast.speed).toBe('fast');
    expect(fast.perQuestion[0]?.run).toBe('links=off,speed=fast');
    expect(full.perQuestion[0]?.run).toBe('links=off,speed=full');
  });

  it('speed.parses-a-list-or-grid', () => {
    expect(parseSpeeds(undefined)).toEqual(['full']);
    expect(parseSpeeds('grid')).toEqual(['full', 'fast']);
    expect(parseSpeeds('fast, full,fast')).toEqual(['fast', 'full']);
    expect(() => parseSpeeds('lexical')).toThrow(/--speed takes full, fast or grid/);
  });

  it('per-question.written-beside---out-for-every-run-of-the-grid', async () => {
    const outFile = path.join(root, 'lme.json');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const args: PublicArgs = {
      set: 'longmemeval',
      file: SAMPLE_LME,
      unpinned: true,
      fetch: false,
      plan: false,
      yes: false,
      embed: 'fake',
      rerank: 'none',
      links: 'off,all',
      speed: 'grid',
      noGate: false,
      k: '5,10',
      json: false,
      out: outFile,
      cacheDir: root,
    };
    expect(await publicMain(args, () => {})).toBe(0);
    const totals = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      entities: string;
      questions: string;
      runs: { links: string; speed: string }[];
    };
    expect(totals.runs.map((r) => `${r.links}/${r.speed}`)).toEqual([
      'off/full',
      'off/fast',
      'all/full',
      'all/fast',
    ]);
    expect(totals.entities).toBe('none');
    expect(totals.questions).toBe('lme.questions.jsonl');
    const lines = parseQuestionResults(
      fs.readFileSync(path.join(root, 'lme.questions.jsonl'), 'utf8'),
    );
    // 3 turn-level and 2 session-level lines per run, 4 runs.
    expect(lines).toHaveLength(20);
    expect([...new Set(lines.map((l) => l.run))]).toEqual([
      'links=off,speed=full',
      'links=off,speed=fast',
      'links=all,speed=full',
      'links=all,speed=fast',
    ]);
  });
});
