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
    latency: '< 15 ms',
    precision: 'int8 in RAM',
    store: 'Reactive tables / local memory',
    pitch:
      'Everything happening right now — what was just said, what the person likes, what they pinned. Always in reach, never searched for.',
    body: 'Active session context, persona facts and pinned rules. Injected with zero search.',
    recall: 'Instant',
    space: "Only what's in use",
  },
  {
    key: 'warm' as Tier,
    name: 'Kuiper Belt',
    label: 'Warm · remembered',
    latency: '30–80 ms',
    precision: 'Matryoshka 512d · binary quantized',
    store: 'Document store + BM25',
    pitch:
      'The important parts of past conversations, kept as short, clear summaries. Found in a blink — nothing you share gets lost.',
    body: 'Distilled facts and episodic summaries searched by hybrid lexical + dense recall.',
    recall: 'In a blink',
    space: 'Compact',
  },
  {
    key: 'cold' as Tier,
    name: 'Oort Cloud',
    label: 'Cold · long ago',
    latency: '80–180 ms',
    precision: '0 bits in RAM (elision stub)',
    store: 'Object storage + zstd dictionary',
    pitch:
      'Older wishes and history, safely tucked away and out of the way. Bring one back in a moment whenever it matters again.',
    body: 'Vectors evicted entirely. A 35-token stub hydrates the full memory on demand in < 3 ms.',
    recall: 'In a moment',
    space: 'Dormant',
  },
];

export const plans = [
  {
    name: 'Open Source',
    price: '$0',
    unit: 'self-hosted',
    ops: 'Unlimited (bring your own keys)',
    warm: 'Self-hosted',
    cold: 'Self-hosted',
    features: [
      'Apache 2.0 SDK (TS + Python)',
      'Local sqlite-vec + zstd engine',
      'Desktop Explorer app',
    ],
    cta: 'Get the code',
  },
  {
    name: 'Developer',
    price: '$0',
    unit: '/ month',
    ops: '50k retrievals · 10k writes',
    warm: '1 GB included',
    cold: '10 GB included',
    features: ['Managed hot tier', 'Hybrid rerank', 'Community support'],
    cta: 'Start free',
  },
  {
    name: 'Pro',
    price: '$49',
    unit: '/ month',
    ops: '500k retrievals · 100k writes',
    warm: '$0.25 / GB-month',
    cold: '$0.03 / GB-month',
    features: ['Per-customer encryption', 'Usage-based overage', 'Activation analytics'],
    cta: 'Go Pro',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: '$999',
    unit: '/ month',
    ops: '10M retrievals · 2M writes',
    warm: '$0.18 / GB-month',
    cold: '$0.02 / GB-month',
    features: ['BYOK / customer KMS', 'Dedicated VPC', '99.99% SLA, SOC 2'],
    cta: 'Talk to sales',
  },
];

/** Estimated monthly Oort Pro cost for a usage profile. */
export function estimateMonthlyCost(
  retrievals: number,
  writes: number,
  warmGb: number,
  coldGb: number,
) {
  const base = 49;
  const extraR = (Math.max(0, retrievals - 500_000) / 1000) * 0.06;
  const extraW = (Math.max(0, writes - 100_000) / 1000) * 0.1;
  return Math.round((base + extraR + extraW + warmGb * 0.25 + coldGb * 0.03) * 100) / 100;
}

/** Flat FP32 vector DB baseline: everything stays in hot RAM. */
export function flatVectorCost(totalGb: number) {
  return Math.round(totalGb * 6 * 100) / 100;
}

export const tierClass: Record<Tier, string> = {
  hot: 'bg-hot',
  warm: 'bg-warm',
  cold: 'bg-cold',
};
