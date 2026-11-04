import { describe, expect, it } from 'vitest';
import { isCurrent } from './model.js';
import { makeMemory } from './store-conformance.js';

const AT = new Date('2026-11-03T12:00:00.000Z');

describe('model', () => {
  it('model.isCurrent-future-validTo-is-current', () => {
    const m = makeMemory({
      id: 'm',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
    });
    expect(isCurrent(m, AT)).toBe(true);
  });

  it('model.isCurrent-past-validTo-is-not', () => {
    const m = makeMemory({
      id: 'm',
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-11-01T00:00:00.000Z',
    });
    expect(isCurrent(m, AT)).toBe(false);
  });

  it('isCurrent-bounds-and-expiredAt', () => {
    const m = makeMemory({
      id: 'm',
      validFrom: '2026-11-03T12:00:00.000Z',
      validTo: '2026-11-04T00:00:00.000Z',
    });
    expect(isCurrent(m, AT)).toBe(true); // validFrom inclusive
    expect(isCurrent(m, new Date('2026-11-04T00:00:00.000Z'))).toBe(false); // validTo exclusive
    expect(isCurrent(m, new Date('2026-11-03T11:59:59.999Z'))).toBe(false);
    expect(isCurrent({ ...m, expiredAt: '2026-11-03T12:00:00.000Z' }, AT)).toBe(false);
  });
});
