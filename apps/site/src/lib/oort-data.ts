export type Tier = 'hot' | 'warm' | 'cold';

export const clusters = [
  { name: 'Design', x: 28, y: 30, count: 7, tier: 'hot' as Tier },
  { name: 'Business', x: 40, y: 52, count: 8, tier: 'warm' as Tier },
  { name: 'Health', x: 76, y: 30, count: 5, tier: 'warm' as Tier },
  { name: 'Code', x: 70, y: 72, count: 9, tier: 'hot' as Tier },
  { name: 'Travel', x: 18, y: 80, count: 4, tier: 'cold' as Tier },
];

export const timeline = [
  { q: 'I want to design houses', when: '2m ago', tier: 'hot' as Tier },
  { q: 'I want to learn more about design', when: '3h ago', tier: 'hot' as Tier },
  { q: 'I want to be an artist', when: '4d ago', tier: 'warm' as Tier },
  { q: 'I want to be a fashion designer', when: '6w ago', tier: 'cold' as Tier },
  { q: 'Prefers metric units and dark interfaces', when: '8mo ago', tier: 'cold' as Tier },
];

export const tiers = [
  {
    key: 'hot' as Tier,
    name: 'Photosphere',
    label: 'Hot · in the moment',
    latency: 'No search needed',
    latencyTarget: 'Target: under 15 ms',
    precision: '512-dim int8 vectors',
    store: 'Recent and pinned memories, kept ready',
    pitch:
      'Everything happening right now: what was just said, what the person likes, what they pinned. Always in reach, never searched for.',
    body: 'Active session context, persona facts and pinned rules.',
    recall: 'Instant',
    space: "Only what's in use",
  },
  {
    key: 'warm' as Tier,
    name: 'Kuiper Belt',
    label: 'Warm · remembered',
    latency: 'Keyword p95 4.9 ms · vector p95 19.8 ms',
    latencyTarget: 'Target: 30 to 80 ms',
    precision: '512-dim int8 vectors (binary quantization is Planned)',
    store: 'SQLite with FTS5 (BM25) keyword index plus vectors',
    pitch:
      'The important parts of past conversations, kept as short, clear facts. Found in a blink, and each one can explain why it was recalled.',
    body: 'Distilled facts searched by keyword and vector together.',
    recall: 'In a blink',
    space: 'Compact',
  },
  {
    key: 'cold' as Tier,
    name: 'Oort Cloud',
    label: 'Cold · long ago',
    latency: 'Not measured separately yet',
    latencyTarget: 'Target: 80 to 180 ms',
    precision: 'No vector kept (text, stub and entities stay)',
    store: 'zstd-compressed blob (object storage in the cloud is Planned)',
    pitch:
      'Older history, safely tucked away and out of the way. The text stays, the heavy vector goes, and it comes back when it matters again.',
    body: 'Text, a short stub and entities are kept. The vector is dropped and the rest is compressed.',
    recall: 'In a moment',
    space: 'Dormant',
  },
];

/**
 * Measured on a laptop with the local SQLite engine and 10,000 memories.
 * Vector recall used a stand-in embedder, so it excludes the embedding API round trip.
 */
export const measured = [
  { value: '4.9 ms', label: 'keyword recall, p95', setup: 'SQLite FTS5, 10,000 memories, laptop' },
  {
    value: '19.8 ms',
    label: 'vector recall, p95',
    setup: '10,000 memories, laptop, stand-in embedder. Excludes the embedding API round trip.',
  },
  {
    value: '+27 MB',
    label: 'process memory',
    setup: 'For 10,000 memories, local SQLite engine, laptop',
  },
  {
    value: '4.6 MB',
    label: 'for 4,572 cold memories on disk',
    setup: 'Text, stub and entities, zstd-compressed, local SQLite engine',
  },
];

export type BillingMode = 'managed' | 'byok';
export type PaidPlan = 'Pro' | 'Team';
export type PlanName = 'Free' | PaidPlan;

export type Usage = { saves: number; recalls: number; warmGb: number; coldGb: number };

type Allowance = { price: number; saves: number; recalls: number; warmGb: number; coldGb: number };

/**
 * Structure A (we run the models) and Structure B (you bring your own keys)
 * from docs/research/2026-11-04-pricing.md. Prices are a launch proposal.
 */
export const rates = {
  managed: {
    Free: { price: 0, saves: 5_000, recalls: 10_000, warmGb: 0.1, coldGb: 1 },
    Pro: { price: 19, saves: 25_000, recalls: 50_000, warmGb: 1, coldGb: 20 },
    Team: { price: 99, saves: 600_000, recalls: 1_200_000, warmGb: 20, coldGb: 400 },
    overagePer1k: { saves: 0.2, recalls: 0.12 },
    teamOveragePer1k: { saves: 0.12, recalls: 0.08 },
  },
  byok: {
    Free: { price: 0, saves: 25_000, recalls: 50_000, warmGb: 0.1, coldGb: 1 },
    Pro: { price: 9, saves: 100_000, recalls: 250_000, warmGb: 1, coldGb: 20 },
    Team: { price: 39, saves: 500_000, recalls: 1_250_000, warmGb: 5, coldGb: 100 },
    overagePer1k: { saves: 0.03, recalls: 0.02 },
  },
  storagePerGbMonth: { warm: 0.5, cold: 0.03 },
} as const satisfies {
  managed: Record<PlanName, Allowance> & {
    overagePer1k: { saves: number; recalls: number };
    teamOveragePer1k: { saves: number; recalls: number };
  };
  byok: Record<PlanName, Allowance> & { overagePer1k: { saves: number; recalls: number } };
  storagePerGbMonth: { warm: number; cold: number };
};

const cents = (n: number) => Math.round(n * 100) / 100;

/** Free is a hard stop, so it only applies when the usage fits inside it. */
export function fitsFree(u: Usage, byok = false) {
  const f = rates[byok ? 'byok' : 'managed'].Free;
  return (
    u.saves <= f.saves && u.recalls <= f.recalls && u.warmGb <= f.warmGb && u.coldGb <= f.coldGb
  );
}

/** Monthly cost of a paid plan for a usage profile: base price plus overage. */
export function planCost(plan: PaidPlan, u: Usage, byok = false) {
  const r = rates[byok ? 'byok' : 'managed'];
  const p = r[plan];
  const per1k = plan === 'Team' && 'teamOveragePer1k' in r ? r.teamOveragePer1k : r.overagePer1k;
  const over =
    (Math.max(0, u.saves - p.saves) / 1000) * per1k.saves +
    (Math.max(0, u.recalls - p.recalls) / 1000) * per1k.recalls +
    Math.max(0, u.warmGb - p.warmGb) * rates.storagePerGbMonth.warm +
    Math.max(0, u.coldGb - p.coldGb) * rates.storagePerGbMonth.cold;
  return cents(p.price + over);
}

/** Cheapest plan that can serve the usage, with the overage part split out. */
export function estimateMonthlyCost(u: Usage, opts: { byok?: boolean } = {}) {
  const byok = opts.byok ?? false;
  if (fitsFree(u, byok)) return { plan: 'Free' as PlanName, monthly: 0, overage: 0 };
  const pro = planCost('Pro', u, byok);
  const team = planCost('Team', u, byok);
  const plan: PaidPlan = team < pro ? 'Team' : 'Pro';
  const monthly = plan === 'Team' ? team : pro;
  const base = rates[byok ? 'byok' : 'managed'][plan].price;
  return { plan: plan as PlanName, monthly, overage: cents(monthly - base) };
}

/** Shown plainly on the pricing and account pages. */
export const proLine = 'Pro: no API keys needed; your memories stay on your machine';

/** Pro's consumer price line (the Stripe price is tax-inclusive). */
export const proPriceLine = '$19/month, VAT included where applicable';

export const plans = [
  {
    name: 'Open Source',
    price: '$0',
    unit: 'self-hosted',
    who: 'Run it yourself. Free and open source.',
    included: ['Unlimited, you bring your own keys', 'Your own machines, SQLite engine'],
    features: [
      'Apache 2.0 engine and CLI (TypeScript)',
      'Local SQLite engine with zstd cold blobs',
      'Python SDK (Planned)',
      'Desktop Explorer app (Planned)',
    ],
    cta: 'Get the code',
  },
  {
    name: 'Free',
    price: '$0',
    unit: 'hosted, no card',
    who: 'For trying things out. Stops at the limit, never bills.',
    included: ['5,000 saves', '10,000 recalls', '100 MB warm', '1 GB cold'],
    features: ['Hard stop at the limits', 'No card needed', 'Smart rerank runs when it helps'],
    cta: 'Get early access',
  },
  {
    name: 'Pro',
    price: '$19',
    unit: '/ month',
    who: 'For products with real users.',
    included: ['25,000 saves', '50,000 recalls', '1 GB warm', '20 GB cold'],
    features: [
      'No API keys needed; your memories stay on your machine',
      'Extra use: $0.20 per 1k saves, $0.12 per 1k recalls',
      'Extra storage: $0.50 per GB warm, $0.03 per GB cold',
      'Smart rerank runs when it helps',
    ],
    cta: 'Get Pro',
    featured: true,
  },
  {
    name: 'Team',
    price: '$99',
    unit: '/ month',
    who: 'For bigger products and teams.',
    included: ['600,000 saves', '1,200,000 recalls', '20 GB warm', '400 GB cold'],
    features: [
      'Extra use: $0.12 per 1k saves, $0.08 per 1k recalls',
      'SSO (Planned)',
      'Shared org memory (Planned)',
      'Priority support',
    ],
    cta: 'Get early access',
  },
  {
    name: 'Enterprise',
    price: 'Talk to us',
    unit: '',
    who: 'For large teams and millions of customers.',
    included: ['Contract limits'],
    features: [
      'Bring your own keys',
      'Private deployment (Planned)',
      'SOC 2 and an uptime SLA (Planned, not available today)',
    ],
    cta: 'Talk to us',
  },
];

/** Same plans at the bring-your-own-keys rates (Structure B). */
export const byokPlans = {
  Free: ['25,000 saves', '50,000 recalls', '100 MB warm', '1 GB cold'],
  Pro: ['100,000 saves', '250,000 recalls', '1 GB warm', '20 GB cold'],
  Team: ['500,000 saves', '1,250,000 recalls', '5 GB warm', '100 GB cold'],
} as const;

export const byokPrice = { Free: '$0', Pro: '$9', Team: '$39' } as const;
export const byokOverage = {
  Pro: 'Extra use: $0.03 per 1k saves, $0.02 per 1k recalls',
  Team: 'Extra use: $0.03 per 1k saves, $0.02 per 1k recalls',
} as const;

export const tierClass: Record<Tier, string> = {
  hot: 'bg-hot',
  warm: 'bg-warm',
  cold: 'bg-cold',
};
