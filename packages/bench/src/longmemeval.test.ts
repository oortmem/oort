import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { datasetPath } from './datasets.js';
import {
  checkKnowledgeUpdateOverrides,
  KNOWLEDGE_UPDATE_OVERRIDES,
  loadLongMemEval,
  type KnowledgeUpdateOverrides,
} from './longmemeval.js';
import { runPublicSet, type Question } from './public-sets.js';

const sample = (): Record<string, unknown>[] =>
  JSON.parse(
    fs.readFileSync(new URL('../eval/public/longmemeval-sample.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>[];

/** The sample's knowledge-update question: Summit Gym (`k-old`), then Harbor Fitness (`k-new`). */
const kuOf = (overrides?: KnowledgeUpdateOverrides): Question | undefined =>
  loadLongMemEval(sample(), overrides).haystacks.find((h) => h.id === 'sample-ku')?.questions[0];

const earlier: KnowledgeUpdateOverrides = {
  'sample-ku': { kind: 'earlier', expected: 'k-old', stale: 'k-new', why: 'asks for the old gym' },
};
const recallOnly: KnowledgeUpdateOverrides = {
  'sample-ku': { kind: 'recall-only', why: 'asks for both gyms' },
};

describe('knowledge-update labels', () => {
  it('ku-labels.the-later-answer-session-is-current-by-default', () => {
    expect(kuOf({})).toMatchObject({
      evidence: ['k-new#1'],
      stale: ['k-old#0'],
      answerSessions: ['k-new'],
      staleSessions: ['k-old'],
    });
  });

  it('ku-labels.an-earlier-value-override-swaps-current-and-stale', () => {
    expect(kuOf(earlier)).toMatchObject({
      evidence: ['k-old#0'],
      stale: ['k-new#1'],
      answerSessions: ['k-old'],
      staleSessions: ['k-new'],
    });
  });

  it('ku-labels.a-recall-only-override-expects-every-answer-and-has-no-stale-label', () => {
    const q = kuOf(recallOnly);
    expect(q).toMatchObject({
      evidence: ['k-old#0', 'k-new#1'],
      answerSessions: ['k-old', 'k-new'],
    });
    expect(q?.stale).toBeUndefined();
    expect(q?.staleSessions).toBeUndefined();
  });

  it('ku-labels.an-override-that-does-not-fit-its-question-is-refused', () => {
    const load = (o: KnowledgeUpdateOverrides) => () => loadLongMemEval(sample(), o);
    expect(
      load({ 'sample-ku': { kind: 'earlier', expected: 'k-old', stale: 'noise-1', why: 'x' } }),
    ).toThrow(/sample-ku: the override names noise-1, which is not one of its answer sessions/);
    // Naming the later session as current is what the default already does.
    expect(
      load({ 'sample-ku': { kind: 'earlier', expected: 'k-new', stale: 'k-old', why: 'x' } }),
    ).toThrow(/sample-ku: k-new is the later answer session/);
    expect(load({ 'sample-ms': { kind: 'recall-only', why: 'x' } })).toThrow(
      /sample-ms: not a knowledge-update question/,
    );
    expect(load({ 'sample-ku_abs': { kind: 'recall-only', why: 'x' } })).toThrow(
      /sample-ku_abs: not a knowledge-update question/,
    );
  });

  it('ku-labels.check-names-every-override-that-does-not-fit-the-file', () => {
    expect(checkKnowledgeUpdateOverrides(sample(), earlier)).toEqual([]);
    expect(
      checkKnowledgeUpdateOverrides(sample(), {
        ...recallOnly,
        '0000beef': { kind: 'recall-only', why: 'x' },
        'sample-ms': { kind: 'recall-only', why: 'x' },
      }),
    ).toEqual([
      '0000beef: not in the file',
      'sample-ms: not a knowledge-update question with two answer sessions',
    ]);
  });

  it('ku-labels.scores-use-the-corrected-labels', async () => {
    const lines = async (o: KnowledgeUpdateOverrides) =>
      (await runPublicSet({ set: loadLongMemEval(sample(), o), ks: [10] })).perQuestion.filter(
        (l) => l.id === 'sample-ku',
      );
    // Earlier value: one expected and one outdated answer at both levels, all metrics scored.
    for (const l of await lines(earlier)) {
      expect(l.ranks).toHaveLength(1);
      expect(l.staleRanks).toHaveLength(1);
      expect(l.metrics['staleLeak']).not.toBeNull();
      expect(l.metrics['staleAboveCurrent']).not.toBeNull();
    }
    // Recall only: both answers expected, neither counts toward stale-leak or stale above current.
    const only = await lines(recallOnly);
    expect(only.map((l) => l.level)).toEqual(['turn', 'session']);
    for (const l of only) {
      expect(l.ranks).toHaveLength(2);
      expect(l.staleRanks).toBeUndefined();
      expect(l.metrics['recall@10']).not.toBeNull();
      expect(l.metrics['staleLeak']).toBeNull();
      expect(l.metrics['staleAboveCurrent']).toBeNull();
    }
  });

  it('ku-labels.every-override-says-why', () => {
    const entries = Object.entries(KNOWLEDGE_UPDATE_OVERRIDES);
    for (const [id, o] of entries) {
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      expect(o.why).not.toBe('');
      if (o.kind === 'earlier') {
        expect(o.expected).not.toBe(o.stale);
        // LongMemEval names a question's answer sessions `answer_<hash>_<n>`.
        expect(o.expected).toMatch(/^answer_[0-9a-f]{8}_\d$/);
        expect(o.stale).toMatch(/^answer_[0-9a-f]{8}_\d$/);
      }
    }
    expect(entries.filter(([, o]) => o.kind === 'earlier')).toHaveLength(8);
    expect(entries.filter(([, o]) => o.kind === 'recall-only')).toHaveLength(8);
  });
});

/**
 * The table against the pinned LongMemEval_S file, when it is in the cache
 * (`pnpm eval --set longmemeval --fetch` puts it there) or `OORT_LONGMEMEVAL_FILE` names
 * it. CI does not download datasets, so there the test is skipped.
 */
const PINNED = process.env['OORT_LONGMEMEVAL_FILE'] ?? datasetPath('longmemeval');

describe('knowledge-update labels against the pinned file', () => {
  it('ku-labels.the-table-fits-the-pinned-file', { timeout: 60_000 }, (ctx) => {
    if (!fs.existsSync(PINNED)) {
      ctx.skip(
        `${PINNED} is not there: run \`pnpm eval --set longmemeval --fetch\` or set OORT_LONGMEMEVAL_FILE`,
      );
    }
    const json = JSON.parse(fs.readFileSync(PINNED, 'utf8')) as Record<string, unknown>[];
    // Every id is in the file, is a knowledge-update question with two answer sessions, and
    // each named session is one of them (an earlier-value override names the earlier one current).
    expect(checkKnowledgeUpdateOverrides(json)).toEqual([]);
    const ku = loadLongMemEval(json)
      .haystacks.flatMap((h) => h.questions)
      .filter((q) => q.group === 'knowledge-update');
    expect(ku).toHaveLength(72);
    const scored = ku.filter((q) => q.stale !== undefined);
    // 70 have two answer sessions; the 8 recall-only ones have no stale label.
    expect(scored).toHaveLength(62);
    for (const [id, o] of Object.entries(KNOWLEDGE_UPDATE_OVERRIDES)) {
      const q = ku.find((x) => x.id === id);
      if (o.kind === 'earlier') {
        expect(q).toMatchObject({ answerSessions: [o.expected], staleSessions: [o.stale] });
      } else {
        expect(q?.staleSessions).toBeUndefined();
        expect(q?.answerSessions).toHaveLength(2);
      }
    }
  });
});
