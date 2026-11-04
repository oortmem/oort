import { describe, expect, it } from 'vitest';
import { estimateMonthlyCost, plans, planCost } from '@/lib/oort-data';

const usage = (saves: number, recalls: number, warmGb: number, coldGb: number) => ({
  saves,
  recalls,
  warmGb,
  coldGb,
});

describe('plan table', () => {
  it('lists Open Source, Free, Pro, Team and Enterprise in that order', () => {
    expect(plans.map((p) => p.name)).toEqual(['Open Source', 'Free', 'Pro', 'Team', 'Enterprise']);
  });
  it('prices them $0, $0, $19, $99 and "Talk to us"', () => {
    expect(plans.map((p) => p.price)).toEqual(['$0', '$0', '$19', '$99', 'Talk to us']);
  });
  it('labels SOC 2, SLA and private deployment as Planned', () => {
    const all = plans.flatMap((p) => p.features);
    for (const f of all.filter((x) => /SOC 2|SLA|VPC|private deployment/i.test(x))) {
      expect(f).toMatch(/Planned/);
    }
    expect(JSON.stringify(plans)).not.toMatch(/99\.99/);
  });
});

describe('estimateMonthlyCost, we run the models', () => {
  it('Free when usage fits the hard-stop limits', () => {
    expect(estimateMonthlyCost(usage(5_000, 10_000, 0.1, 1))).toEqual({
      plan: 'Free',
      monthly: 0,
      overage: 0,
    });
  });
  it('moves to Pro as soon as one Free limit is passed (Free never bills overage)', () => {
    expect(estimateMonthlyCost(usage(5_001, 10_000, 0.1, 1)).plan).toBe('Pro');
    expect(estimateMonthlyCost(usage(5_000, 10_000, 0.2, 1)).plan).toBe('Pro');
  });
  it('Pro is $19 with 25k saves, 50k recalls, 1 GB warm and 20 GB cold included', () => {
    expect(estimateMonthlyCost(usage(25_000, 50_000, 1, 20))).toEqual({
      plan: 'Pro',
      monthly: 19,
      overage: 0,
    });
  });
  it('Pro overage is $0.20 per 1k saves and $0.12 per 1k recalls', () => {
    expect(planCost('Pro', usage(35_000, 70_000, 1, 20))).toBeCloseTo(19 + 10 * 0.2 + 20 * 0.12, 2);
  });
  it('Pro storage overage is $0.50 per GB warm and $0.03 per GB cold', () => {
    expect(planCost('Pro', usage(25_000, 50_000, 3, 30))).toBeCloseTo(19 + 2 * 0.5 + 10 * 0.03, 2);
  });
  it('Team is $99 with 150k saves, 300k recalls, 5 GB warm and 100 GB cold included', () => {
    expect(planCost('Team', usage(150_000, 300_000, 5, 100))).toBe(99);
  });
  it('picks the cheaper of Pro and Team (with the proposed rates Pro plus overage always wins)', () => {
    expect(estimateMonthlyCost(usage(150_000, 300_000, 5, 100)).plan).toBe('Pro');
    const big = estimateMonthlyCost(usage(5_000_000, 10_000_000, 50, 500));
    expect(big.plan).toBe('Pro');
    expect(big.monthly).toBeCloseTo(19 + 4_975 * 0.2 + 9_950 * 0.12 + 49 * 0.5 + 480 * 0.03, 2);
    expect(planCost('Team', usage(5_000_000, 10_000_000, 50, 500))).toBeCloseTo(
      99 + 4_850 * 0.2 + 9_700 * 0.12 + 45 * 0.5 + 400 * 0.03,
      2,
    );
  });
  it('reports the overage part separately from the base price', () => {
    const e = estimateMonthlyCost(usage(35_000, 50_000, 1, 20));
    expect(e).toEqual({ plan: 'Pro', monthly: 21, overage: 2 });
  });
});

describe('estimateMonthlyCost, bring your own keys', () => {
  it('Free BYO fits 25k saves and 50k recalls', () => {
    expect(estimateMonthlyCost(usage(25_000, 50_000, 0.1, 1), { byok: true }).plan).toBe('Free');
    expect(estimateMonthlyCost(usage(25_001, 50_000, 0.1, 1), { byok: true }).plan).toBe('Pro');
  });
  it('Pro BYO is $9 with 100k saves and 250k recalls included', () => {
    expect(planCost('Pro', usage(100_000, 250_000, 1, 20), true)).toBe(9);
  });
  it('Pro BYO overage is $0.03 per 1k saves and $0.02 per 1k recalls', () => {
    expect(planCost('Pro', usage(110_000, 260_000, 1, 20), true)).toBeCloseTo(
      9 + 10 * 0.03 + 10 * 0.02,
      2,
    );
  });
  it('Team BYO is $39 with 500k saves and 1.25M recalls included', () => {
    expect(planCost('Team', usage(500_000, 1_250_000, 5, 100), true)).toBe(39);
  });
  it('Team BYO wins only at very high usage', () => {
    expect(estimateMonthlyCost(usage(5_000_000, 10_000_000, 50, 500), { byok: true }).plan).toBe(
      'Team',
    );
    expect(estimateMonthlyCost(usage(200_000, 400_000, 2, 30), { byok: true }).plan).toBe('Pro');
  });
  it('is cheaper than managed for the same usage', () => {
    const u = usage(200_000, 400_000, 2, 30);
    expect(estimateMonthlyCost(u, { byok: true }).monthly).toBeLessThan(
      estimateMonthlyCost(u).monthly,
    );
  });
});
