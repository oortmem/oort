import { describe, expect, it } from 'vitest';
import { estimateMonthlyCost, plans } from '@/lib/oort-data';

describe('pricing', () => {
  it('Pro is $49 with 500k retrievals and 100k writes included', () => {
    expect(estimateMonthlyCost(500_000, 100_000, 0, 0)).toBe(49);
  });
  it('warm storage costs $0.25/GB and cold $0.03/GB on Pro', () => {
    expect(estimateMonthlyCost(0, 0, 10, 100)).toBe(49 + 2.5 + 3);
  });
  it('Enterprise base is $999', () => {
    expect(plans.find((p) => p.name === 'Enterprise')?.price).toBe('$999');
  });
});
