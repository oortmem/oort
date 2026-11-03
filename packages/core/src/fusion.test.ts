import { describe, expect, it } from 'vitest';
import { activation, type ActivationParams } from './activation.js';
import type { Hit } from './adapters.js';
import { fuse, rrf } from './fusion.js';
import type { Memory } from './model.js';
import { makeMemory } from './store-conformance.js';

const P: ActivationParams = { d: 0.5, ws: 1.0 };
const NOW = new Date('2026-11-03T12:00:00.000Z');
/** A fixed start date before NOW, so memories are current regardless of the real clock. */
const START = '2026-11-01T00:00:00.000Z';

function hits(...idList: string[]): Hit[] {
  return idList.map((id, i) => ({ id, score: 100 - i, tier: 'warm' }));
}

function byId(...ms: Memory[]): Map<string, Memory> {
  return new Map(ms.map((m) => [m.id, m]));
}

describe('fusion', () => {
  it('rrf-prefers-both-lists', () => {
    const scores = rrf([hits('a', 'b'), hits('c', 'a')]);
    expect(scores.get('a')).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(scores.get('b')).toBeCloseTo(1 / 62, 12);
    expect(scores.get('c')).toBeCloseTo(1 / 61, 12);
    const order = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('rrf-honours-k-and-counts-each-list-once', () => {
    const scores = rrf([hits('a', 'a', 'b')], 10);
    expect(scores.get('a')).toBeCloseTo(1 / 11, 12);
    expect(scores.get('b')).toBeCloseTo(1 / 13, 12);
    expect(rrf([])).toEqual(new Map());
  });

  it('drops-superseded', () => {
    const current = makeMemory({ id: 'current', validFrom: '2026-11-02T00:00:00.000Z' });
    const superseded = makeMemory({
      id: 'superseded',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-11-02T00:00:00.000Z',
      supersededBy: 'current',
    });
    const out = fuse([hits('superseded', 'current')], byId(current, superseded), NOW, {
      activation: P,
    });
    expect(out.map((r) => r.id)).toEqual(['current']);
  });

  it('as-of-keeps-what-was-valid-then', () => {
    const current = makeMemory({ id: 'current', validFrom: '2026-11-02T00:00:00.000Z' });
    const superseded = makeMemory({
      id: 'superseded',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-11-02T00:00:00.000Z',
    });
    const memories = byId(current, superseded);
    const list = [hits('superseded', 'current')];
    const at = (asOf: string) =>
      fuse(list, memories, NOW, { activation: P, asOf }).map((r) => r.id);
    expect(at('2026-11-01T12:00:00.000Z')).toEqual(['superseded']);
    // validTo is exclusive, validFrom inclusive.
    expect(at('2026-11-02T00:00:00.000Z')).toEqual(['current']);
    expect(at('2026-10-31T00:00:00.000Z')).toEqual([]);
  });

  it('fusion.keeps-future-expiry', () => {
    const m = makeMemory({
      id: 'soon',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
    });
    const out = fuse([hits('soon')], byId(m), NOW, { activation: P });
    expect(out.map((r) => r.id)).toEqual(['soon']);
  });

  it('fusion.asOf-ignores-expiredAt', () => {
    const m = makeMemory({
      id: 'm',
      validFrom: START,
      validTo: '2026-12-01T00:00:00.000Z',
      expiredAt: '2026-11-02T00:00:00.000Z',
      endReason: 'superseded',
    });
    const list = [hits('m')];
    const asOf = '2026-11-01T12:00:00.000Z';
    expect(fuse(list, byId(m), NOW, { activation: P, asOf }).map((r) => r.id)).toEqual(['m']);
    expect(fuse(list, byId(m), NOW, { activation: P })).toEqual([]);
  });

  it('adds-a-tenth-of-activation', () => {
    const recent = '2026-11-03T11:00:00.000Z';
    const hot = makeMemory({
      id: 'hot',
      salience: 0.9,
      validFrom: START,
      accessLog: { count: 1, recent: [recent], compactedSum: 0, compactedAt: null },
    });
    const cold = makeMemory({ id: 'cold', salience: 0.1, validFrom: START });
    // `cold` ranks first in the only list, but `hot` has far higher activation.
    const out = fuse([hits('cold', 'hot')], byId(hot, cold), NOW, { activation: P });
    const expected = (m: Memory, rank: number) =>
      1 / (60 + rank) + 0.1 * activation(m.accessLog, m.salience, NOW, P);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('hot');
    expect(out[0]?.score).toBeCloseTo(expected(hot, 2), 12);
    expect(out[1]?.score).toBeCloseTo(expected(cold, 1), 12);
  });

  it('drops-ids-missing-from-memories', () => {
    const a = makeMemory({ id: 'a', validFrom: START });
    const out = fuse([hits('ghost', 'a')], byId(a), NOW, { activation: P });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});
