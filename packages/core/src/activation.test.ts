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
    const build = (n: number): AccessLog => {
      let log: AccessLog = { count: 0, recent: [], compactedSum: 0, compactedAt: null };
      for (let i = 0; i < n; i++) log = appendAccess(log, new Date(base.getTime() + i * HOUR));
      return log;
    };
    const at = new Date('2025-12-10T00:00:00.000Z');
    const a40 = build(40);
    const a41 = build(41);
    expect(a40.recent.length).toBeLessThanOrEqual(32);
    expect(a41.count).toBe(41);
    expect(activation(a41, 0, at, p)).toBeGreaterThan(activation(a40, 0, at, p));

    // Compacting one log must not change its ranking against an uncompacted one.
    const uncompacted = build(32);
    const compacted = build(33);
    expect(compacted.compactedSum).toBeGreaterThan(0);
    expect(activation(compacted, 0, at, p)).toBeGreaterThan(activation(uncompacted, 0, at, p));

    // Frequent-recent vs sparse-old.
    const frequent = build(40);
    const sparse = mk([24 * 30, 24 * 31, 24 * 32]);
    const t = new Date(base.getTime() + 40 * HOUR + 2 * HOUR);
    const sparseAt: AccessLog = {
      ...sparse,
      recent: [0, 1, 2].map((i) => new Date(base.getTime() - (30 + i) * 24 * HOUR).toISOString()),
    };
    expect(activation(frequent, 0, t, p)).toBeGreaterThan(activation(sparseAt, 0, t, p));
  });

  it('appendAccess does not mutate its input', () => {
    const log = mk([1, 2]);
    const snapshot = structuredClone(log);
    appendAccess(log, now);
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
