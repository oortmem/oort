import { describe, expect, it } from 'vitest';
import { sampleFor, suggestThreshold, type CalibrationSample } from './calibrate.js';

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
});
