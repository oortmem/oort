import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionController } from '@oortmem/core';
import { describe, expect, it } from 'vitest';
import { loadDecisionRows, renderDecisionReports, runDecisionEval } from './decide-eval.js';
import { bestCut, fitCalibration, truthOf } from './decide-fit.js';

const rows = loadDecisionRows(
  fs.readFileSync(fileURLToPath(new URL('../eval/decisions.jsonl', import.meta.url)), 'utf8'),
);

describe('decision fixture', () => {
  it('decide.fixture-covers-every-question', () => {
    const count = (k: string) => rows.filter((r) => r.kind === k).length;
    expect(count('gate')).toBe(40);
    expect(count('novel')).toBe(8);
    for (const a of ['NOOP', 'REINFORCE', 'REFINE', 'SUPERSEDE', 'CORRECT', 'ADD']) {
      expect(rows.filter((r) => r.kind === 'reconcile' && r.expect === a)).toHaveLength(8);
    }
  });
});

describe('runDecisionEval', () => {
  it('decide.eval-scores-a-perfect-and-a-reckless-controller', async () => {
    // Answers from the label itself: every metric is perfect.
    let current = 0;
    const oracle: DecisionController = {
      async gate() {
        const r = rows[current]!;
        if (r.kind !== 'gate') throw new Error('not a gate row');
        const t = r.expect.type ?? 'semantic';
        return {
          shouldStore: r.expect.store ? 1 : 0,
          salience: 0.5,
          types: { [t]: 1 },
          volatile: r.expect.volatile === true ? 1 : 0,
          decisions: [],
        };
      },
      async reconcile(_obs, candidates) {
        const r = rows[current]!;
        if (r.kind === 'gate') throw new Error('not a reconcile row');
        return [
          {
            candidateId: candidates[0]?.id ?? null,
            action: r.expect,
            probability: 1,
            decisions: [],
          },
        ];
      },
    };
    const perfect = await runDecisionEval('oracle', oracle, rows, (i) => (current = i));
    expect(perfect.gate.store).toEqual({ correct: 40, total: 40 });
    expect(perfect.reconcileOverall).toEqual({ correct: 48, total: 48 });
    expect(perfect.wrongEnd).toEqual({ correct: 24, total: 24 }); // no wrong end
    expect(perfect.novel).toEqual({ correct: 8, total: 8 });

    // Supersedes everything: every keep row is a wrong end.
    const reckless: DecisionController = {
      ...oracle,
      async reconcile(_obs, candidates) {
        return [
          {
            candidateId: candidates[0]?.id ?? null,
            action: 'SUPERSEDE',
            probability: 1,
            decisions: [],
          },
        ];
      },
    };
    const bad = await runDecisionEval('reckless', reckless, rows, (i) => (current = i));
    expect(bad.wrongEnd).toEqual({ correct: 0, total: 24 });
    expect(renderDecisionReports([perfect, bad])).toContain(
      '| wrong end of a true memory (lower is better) | 0% (0/24) | 100% (24/24) |',
    );
  });
});

describe('fitCalibration', () => {
  it('decide.fit-truth-follows-the-tree', () => {
    const sup = rows.find((r) => r.kind === 'reconcile' && r.expect === 'SUPERSEDE')!;
    expect(truthOf('related', sup)).toBe(true);
    expect(truthOf('conflict', sup)).toBe(true);
    expect(truthOf('mistake', sup)).toBe(false);
    expect(truthOf('samefact', sup)).toBeUndefined();
  });

  it('decide.fit-finds-the-bias-that-separates-a-yes-leaning-model', () => {
    // The model says yes at 0.97 to true rows and 0.9 to false ones: a cut between them.
    const xs = [0.97, 0.98, 0.9, 0.91].map((p, i) => ({ x: Math.log(p / (1 - p)), truth: i < 2 }));
    const cut = bestCut(xs);
    expect(cut).toBeGreaterThan(Math.log(0.91 / 0.09));
    expect(cut).toBeLessThan(Math.log(0.97 / 0.03));
    const gate = rows.filter((r) => r.kind === 'gate');
    const samples = gate.map((row) => ({
      question: 'should_store' as const,
      yes: row.kind === 'gate' && row.expect.store ? 0.97 : 0.9,
      row,
    }));
    const [r] = fitCalibration(samples);
    expect(r).toMatchObject({ question: 'should_store', rows: 40, raw: 24, fitted: 40 });
    expect(r!.bias).toBeLessThan(-2);
  });
});
