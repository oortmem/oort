import { describe, expect, it } from 'vitest';
import {
  fitLogitCalibration,
  logit,
  sampleFor,
  separatingMargin,
  suggestThreshold,
  VOYAGE_DEMO_MARGIN,
  type CalibrationSample,
} from './calibrate.js';

describe('calibrate', () => {
  it('calibrate.threshold-sits-above-abstention-scores', () => {
    const samples: CalibrationSample[] = [
      { category: 'single-fact', expected: [0.91], top: 0.91 },
      { category: 'single-fact', expected: [0.72], top: 0.72 },
      { category: 'knowledge-update', expected: [0.55], top: 0.6 },
      { category: 'abstention', expected: [], top: 0.18 },
      { category: 'abstention', expected: [], top: 0.31 },
      { category: 'abstention', expected: [], top: 0.12 },
    ];
    const r = suggestThreshold(samples, 0);
    // Above the highest abstention score (0.31), rounded up to 0.05.
    expect(r.suggested).toBe(0.35);
    expect(r.falsePositiveAtSuggested).toBe(0);
    expect(r.keptAtSuggested).toBe(1);
  });

  it('calibrate.sample-reads-expected-and-top-scores', () => {
    const s = sampleFor({ question: 'q', expectedMemoryIds: ['b'], category: 'single-fact' }, [
      { id: 'a', score: 0.4 },
      { id: 'b', score: 0.8 },
      { id: 'c' },
    ]);
    expect(s).toEqual({ category: 'single-fact', expected: [0.8], top: 0.8 });
  });

  const sig = (x: number): number => 1 / (1 + Math.exp(-x));
  const pos = (x: number): CalibrationSample => ({
    category: 'single-fact',
    expected: [x],
    top: x,
  });
  const neg = (x: number): CalibrationSample => ({ category: 'abstention', expected: [], top: x });

  it('calibrate.margin-of-separated-logits', () => {
    const m = separatingMargin([pos(8), pos(1.4), neg(0.06), neg(-2.8)]);
    expect(m).toMatchObject({
      lowestAnswerable: 1.4,
      highestAbstention: 0.06,
      answerableBelow: 0,
      abstentionAbove: 0,
    });
  });

  it('calibrate.margin-gives-up-the-fewest-rows-abstention-first', () => {
    // MiniLM on the demo eval: one abstention row (2.29) outscores the weakest answerable rows.
    const m = separatingMargin([pos(8.4), pos(1.89), pos(1.66), pos(1.41), neg(2.29), neg(0.06)]);
    // Dropping the abstention row costs one row; dropping the three answerable ones costs three.
    expect(m).toMatchObject({
      lowestAnswerable: 1.41,
      highestAbstention: 0.06,
      answerableBelow: 0,
      abstentionAbove: 1,
    });
    // At equal cost, an answerable row is kept and the abstention row given up.
    expect(separatingMargin([pos(5), pos(1), neg(2), neg(-1)])).toMatchObject({
      answerableBelow: 0,
      abstentionAbove: 1,
    });
    expect(separatingMargin([pos(5)])).toBeUndefined();
  });

  it('calibrate.fit-maps-the-margin-onto-voyage-and-is-increasing', () => {
    const local = { lowestAnswerable: 1.414, highestAbstention: 0.062 };
    const c = fitLogitCalibration(local);
    expect(c.scale).toBeGreaterThan(0);
    expect(sig(c.scale * local.lowestAnswerable + c.shift)).toBeCloseTo(
      VOYAGE_DEMO_MARGIN.lowestAnswerable,
      9,
    );
    expect(sig(c.scale * local.highestAbstention + c.shift)).toBeCloseTo(
      VOYAGE_DEMO_MARGIN.highestAbstention,
      9,
    );
    // The gate (0.35) lands inside the local margin, where Voyage's sat inside its own.
    const gate = (logit(0.35) - c.shift) / c.scale;
    expect(gate).toBeGreaterThan(local.highestAbstention);
    expect(gate).toBeLessThan(local.lowestAnswerable);
    expect(() => fitLogitCalibration({ lowestAnswerable: 1, highestAbstention: 2 })).toThrow(
      /do not separate/,
    );
    expect(() => logit(1)).toThrow(RangeError);
  });
});
