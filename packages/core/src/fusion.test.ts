import { describe, expect, it } from 'vitest';
import { activation, type ActivationParams } from './activation.js';
import type { Hit } from './adapters.js';
import { ACTIVATION_BOOST, activationBoost, fuse, rrf, sigmoid } from './fusion.js';
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

  it('fusion.asOf-skips-a-corrected-fact', () => {
    // A corrected fact was never true, so no instant in valid time shows it.
    const wrong = makeMemory({
      id: 'wrong',
      validFrom: START,
      expiredAt: '2026-11-03T00:00:00.000Z',
      endReason: 'corrected',
    });
    const right = makeMemory({ id: 'right', validFrom: START });
    const list = [hits('wrong', 'right')];
    const asOf = '2026-11-02T00:00:00.000Z';
    expect(fuse(list, byId(wrong, right), NOW, { activation: P, asOf }).map((r) => r.id)).toEqual([
      'right',
    ]);
  });

  it('fusion.known-at-shows-what-was-believed-then', () => {
    // Believed from 11-01, found wrong on 11-03; the correction was recorded on 11-03.
    const wrong = makeMemory({
      id: 'wrong',
      validFrom: START,
      createdAt: START,
      expiredAt: '2026-11-03T00:00:00.000Z',
      endReason: 'corrected',
    });
    const right = makeMemory({
      id: 'right',
      validFrom: START,
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    // Superseded on 11-03 (recorded then), so on 11-02 it was still believed current.
    const old = makeMemory({
      id: 'old',
      validFrom: START,
      validTo: '2026-11-03T00:00:00.000Z',
      createdAt: START,
      expiredAt: '2026-11-03T00:00:00.000Z',
      endReason: 'superseded',
    });
    const list = [hits('wrong', 'right', 'old')];
    const ms = byId(wrong, right, old);
    const knownAt = (at: string) =>
      fuse(list, ms, NOW, { activation: P, view: { mode: 'known-at', knownAt: at } }).map(
        (r) => r.id,
      );
    expect(knownAt('2026-11-02T00:00:00.000Z')).toEqual(['wrong', 'old']);
    expect(knownAt('2026-11-04T00:00:00.000Z')).toEqual(['right']);
  });

  it('fusion.history-keeps-every-version-but-corrected-ones', () => {
    const old = makeMemory({
      id: 'old',
      validFrom: START,
      validTo: '2026-11-02T00:00:00.000Z',
      expiredAt: '2026-11-02T00:00:00.000Z',
      endReason: 'superseded',
    });
    const cur = makeMemory({ id: 'cur', validFrom: '2026-11-02T00:00:00.000Z' });
    const wrong = makeMemory({
      id: 'wrong',
      validFrom: START,
      expiredAt: '2026-11-02T00:00:00.000Z',
      endReason: 'corrected',
    });
    const out = fuse([hits('old', 'cur', 'wrong')], byId(old, cur, wrong), NOW, {
      activation: P,
      view: { mode: 'history' },
    });
    expect(out.map((r) => r.id)).toEqual(['old', 'cur']);
  });

  // Activation is a multiplicative boost (band 0.05), not additive: single-list RRF ranks differ
  // by (r-1)/61, so the band reorders at most ~3 ranks.
  it('fusion.multiplies-rrf-by-bounded-activation-boost', () => {
    const recent = '2026-11-03T11:00:00.000Z';
    const hot = makeMemory({
      id: 'hot',
      salience: 0.9,
      validFrom: START,
      accessLog: { count: 1, recent: [recent], compactedSum: 0, compactedAt: null },
    });
    const cold = makeMemory({ id: 'cold', salience: 0.1, validFrom: START });
    const out = fuse([hits('cold', 'hot')], byId(hot, cold), NOW, { activation: P });
    const expected = (m: Memory, rank: number) =>
      (1 / (60 + rank)) *
      (1 + ACTIVATION_BOOST * sigmoid(activation(m.accessLog, m.salience, NOW, P)));
    expect(out).toHaveLength(2);
    const score = (id: string) => out.find((r) => r.id === id)?.score;
    expect(score('hot')).toBeCloseTo(expected(hot, 2), 12);
    expect(score('cold')).toBeCloseTo(expected(cold, 1), 12);
  });

  it('fusion.relevance-dominates-activation', () => {
    const r = makeMemory({ id: 'R', salience: 0.1, validFrom: START });
    const hot = Array.from({ length: 32 }, (_, i) =>
      new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
    );
    const s = makeMemory({
      id: 'S',
      salience: 0.9,
      validFrom: START,
      accessLog: { count: 32, recent: hot, compactedSum: 0, compactedAt: null },
    });
    expect(activation(r.accessLog, r.salience, NOW, P)).toBeLessThan(-3);
    expect(activation(s.accessLog, s.salience, NOW, P)).toBeGreaterThan(2);
    const filler = Array.from({ length: 8 }, (_, i) => `f${i}`);
    const list1 = hits('R', ...filler, 'S');
    const list2 = hits('R');
    const out = fuse([list1, list2], byId(r, s), NOW, { activation: P });
    expect(out.map((x) => x.id)).toEqual(['R', 'S']);
  });

  it('fusion.activation-breaks-near-ties', () => {
    const recent = '2026-11-03T11:00:00.000Z';
    const hot = makeMemory({
      id: 'hot',
      validFrom: START,
      accessLog: { count: 1, recent: [recent], compactedSum: 0, compactedAt: null },
    });
    const cold = makeMemory({ id: 'cold', validFrom: START });
    // Same rank in two separate lists: identical RRF.
    const out = fuse([hits('cold'), hits('hot')], byId(hot, cold), NOW, { activation: P });
    expect(out.map((x) => x.id)).toEqual(['hot', 'cold']);
    expect(out[0]?.rrf).toBeCloseTo(out[1]?.rrf ?? NaN, 12);
  });

  it('fusion.boost-bounded', () => {
    for (let a = -20; a <= 20; a += 0.5) {
      const b = activationBoost(a);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(1 + ACTIVATION_BOOST);
    }
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(1000)).toBe(1);
    // End to end: fused / rrf stays in [1, 1 + ACTIVATION_BOOST] for a cold and a hot memory.
    const hot = makeMemory({
      id: 'hot',
      validFrom: START,
      accessLog: {
        count: 32,
        recent: Array.from({ length: 32 }, (_, i) =>
          new Date(NOW.getTime() - (i + 1) * 1000).toISOString(),
        ),
        compactedSum: 0,
        compactedAt: null,
      },
    });
    const cold = makeMemory({ id: 'cold', validFrom: START });
    for (const o of fuse([hits('hot', 'cold')], byId(hot, cold), NOW, { activation: P })) {
      expect(o.score / o.rrf).toBeGreaterThanOrEqual(1);
      expect(o.score / o.rrf).toBeLessThanOrEqual(1 + ACTIVATION_BOOST);
    }
  });

  it('fusion.lexical-top-hit-falls-at-most-three-places', () => {
    const hotLog = {
      count: 32,
      recent: Array.from({ length: 32 }, (_, k) =>
        new Date(NOW.getTime() - (k + 1) * 1000).toISOString(),
      ),
      compactedSum: 0,
      compactedAt: null,
    };
    const first = makeMemory({ id: 'p1', salience: 0, validFrom: START });
    const rest = Array.from({ length: 9 }, (_, k) =>
      makeMemory({ id: `p${k + 2}`, salience: 1, validFrom: START, accessLog: hotLog }),
    );
    expect(sigmoid(activation(first.accessLog, first.salience, NOW, P))).toBeLessThan(0.05);
    expect(sigmoid(activation(rest[0]!.accessLog, 1, NOW, P))).toBeGreaterThan(0.95);
    const ids = ['p1', ...rest.map((m) => m.id)];
    const out = fuse([hits(...ids)], byId(first, ...rest), NOW, { activation: P });
    expect(out.findIndex((r) => r.id === 'p1')).toBeLessThanOrEqual(3);
  });

  it('drops-ids-missing-from-memories', () => {
    const a = makeMemory({ id: 'a', validFrom: START });
    const out = fuse([hits('ghost', 'a')], byId(a), NOW, { activation: P });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});
