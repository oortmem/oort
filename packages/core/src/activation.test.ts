import { describe, expect, it } from 'vitest';
import { activation, appendAccess, tierFor } from './activation.js';
import type { AccessLog } from './model.js';

const p = { d: 0.5, ws: 1.0 };
const now = new Date('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const ago = (h: number): string => new Date(now.getTime() - h * HOUR).toISOString();
const mk = (hours: number[]): AccessLog => ({
  count: hours.length,
  recent: hours.map(ago),
  compactedSum: 0,
  compactedAt: null,
});

describe('activation', () => {
  it('activation.recent-beats-old', () => {
    expect(activation(mk([1]), 0, now, p)).toBeGreaterThan(activation(mk([100]), 0, now, p));
  });

  it('activation.frequency-adds', () => {
    expect(activation(mk([5, 5, 5, 5, 5]), 0, now, p)).toBeGreaterThan(
      activation(mk([5]), 0, now, p),
    );
  });

  it('activation.salience-weight', () => {
    const log = mk([3, 10]);
    const diff = activation(log, 1, now, p) - activation(log, 0, now, p);
    expect(diff).toBeCloseTo(p.ws, 12);
  });

  it('activation.empty-log-is-finite', () => {
    const empty: AccessLog = { count: 0, recent: [], compactedSum: 0, compactedAt: null };
    const a = activation(empty, 0, now, p);
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeCloseTo(Math.log((24 * 365) ** -p.d), 12);
  });

  it('activation.compaction-preserves-order', () => {
    const base = new Date('2025-12-01T00:00:00.000Z');
    const stamps = (n: number): Date[] =>
      Array.from({ length: n }, (_, i) => new Date(base.getTime() + i * HOUR));
    const build = (n: number): AccessLog =>
      stamps(n).reduce<AccessLog>((l, t) => appendAccess(l, t, p), {
        count: 0,
        recent: [],
        compactedSum: 0,
        compactedAt: null,
      });
    const exact = (n: number, at: Date): number =>
      Math.log(
        stamps(n).reduce(
          (s, t) => s + Math.max((at.getTime() - t.getTime()) / HOUR, 1 / 60) ** -p.d,
          0,
        ),
      );
    const at = new Date('2025-12-10T00:00:00.000Z');

    // (c) fold boundaries
    const l32 = build(32);
    expect(l32.recent.length).toBe(32);
    expect(l32.compactedSum).toBe(0);
    const l33 = build(33);
    expect(l33.recent.length).toBe(17);
    expect(l33.count).toBe(33);

    // (a) compacted approximates the exact sum, one fold and two folds
    const l40 = build(40);
    const l50 = build(50);
    expect(Math.abs(activation(l40, 0, at, p) - exact(40, at))).toBeLessThan(0.15);
    expect(Math.abs(activation(l50, 0, at, p) - exact(50, at))).toBeLessThan(0.15);
    expect(activation(build(41), 0, at, p)).toBeGreaterThan(activation(l40, 0, at, p));
    expect(activation(l33, 0, at, p)).toBeGreaterThan(activation(l32, 0, at, p));

    // (b) frequent-recent vs sparse-old
    const t = new Date(base.getTime() + 52 * HOUR);
    const sparse: AccessLog = {
      count: 3,
      recent: [30, 31, 32].map((d) => new Date(base.getTime() - d * 24 * HOUR).toISOString()),
      compactedSum: 0,
      compactedAt: null,
    };
    expect(activation(l50, 0, t, p)).toBeGreaterThan(activation(sparse, 0, t, p));
  });

  it('appendAccess advances mean age across repeated folds', () => {
    const base = new Date('2025-12-01T00:00:00.000Z');
    let log: AccessLog = { count: 0, recent: [], compactedSum: 0, compactedAt: null };
    const ages: number[] = [];
    for (let i = 0; i < 50; i++) {
      const prev = log.compactedAt;
      log = appendAccess(log, new Date(base.getTime() + i * HOUR), p);
      if (log.compactedAt !== prev) ages.push(log.compactedMeanAgeHours ?? 0);
    }
    expect(ages.length).toBe(2);
    expect(ages[1]).toBeGreaterThan(ages[0] ?? Infinity);
  });

  it('appendAccess does not mutate its input', () => {
    const log = mk([1, 2]);
    const snapshot = structuredClone(log);
    appendAccess(log, now, p);
    expect(log).toEqual(snapshot);
  });
});

describe('tierFor', () => {
  const tp = { hotTopN: 5, coldBelow: -2 };
  it('tierFor.pinned-is-hot', () => {
    expect(tierFor(-100, 1000, true, tp)).toBe('hot');
  });
  it('tierFor.below-threshold-is-cold', () => {
    expect(tierFor(-3, 10, false, tp)).toBe('cold');
    expect(tierFor(-1, 10, false, tp)).toBe('warm');
    expect(tierFor(-3, 4, false, tp)).toBe('hot');
  });
});
