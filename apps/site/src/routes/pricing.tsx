import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { plans, tiers, estimateMonthlyCost, flatVectorCost } from '@/lib/oort-data';

const plain: Record<
  string,
  { who: string; use: string; recent: string; old: string; features: string[] }
> = {
  'Open Source': {
    who: 'Run it yourself, free forever.',
    use: 'No limits',
    recent: 'On your own machines',
    old: 'On your own machines',
    features: [
      'Full code, free to use',
      'Works on your laptop or servers',
      'Desktop app to explore memories',
    ],
  },
  Developer: {
    who: 'For trying things out.',
    use: '50,000 recalls a month',
    recent: '1 GB included',
    old: '10 GB included',
    features: ['We host it for you', 'Smarter, more relevant answers', 'Community help'],
  },
  Pro: {
    who: 'For products with real users.',
    use: '500,000 recalls a month',
    recent: '$0.25 per GB',
    old: '$0.03 per GB',
    features: [
      "Each customer's memories locked separately",
      'Pay only for extra use',
      'See how memory is used',
    ],
  },
  Enterprise: {
    who: 'For large teams and millions of customers.',
    use: '10 million recalls a month',
    recent: '$0.18 per GB',
    old: '$0.02 per GB',
    features: [
      'Use your own encryption keys',
      'Your own private setup',
      'Guaranteed uptime and security reviews',
    ],
  },
};

export const Route = createFileRoute('/pricing')({
  head: () => ({
    meta: [
      { title: 'Pricing — Oort Cloud' },
      {
        name: 'description',
        content:
          'Free and open source forever. Managed Oort Cloud from $0, Pro $49/month, Enterprise $999/month with BYOK.',
      },
      { property: 'og:title', content: 'Oort Cloud pricing' },
      {
        property: 'og:description',
        content: 'Pay for what your app recalls. Old memories cost almost nothing.',
      },
    ],
  }),
  component: Pricing,
});

function Pricing() {
  const [gb, setGb] = useState(200);
  const [ret, setRet] = useState(2_000_000);
  const warm = Math.round(gb * 0.15);
  const cold = gb - warm;
  const oort = estimateMonthlyCost(ret, ret / 5, warm, cold);
  const flat = flatVectorCost(gb);
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="mx-auto max-w-7xl px-6 py-20">
        <h1 className="text-5xl font-semibold">Pay for what you recall.</h1>
        <p className="mt-4 max-w-xl text-muted-foreground">
          You pay for how often your app remembers something. Fresh memories cost a little, old ones
          almost nothing.
        </p>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {tiers.map((t) => (
            <div key={t.key} className="rounded-2xl border border-border bg-card/60 p-6">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className={`size-2.5 rounded-full bg-${t.key}`} />
                {t.name}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.key === 'hot' ? 'Right now' : t.key === 'warm' ? 'Recent' : 'Long ago'} ·
                recalled {t.recall.toLowerCase()}
              </p>
              <p className="mt-3 text-sm text-muted-foreground">{t.pitch}</p>
              <p className="mt-3 text-xs">
                {t.key === 'hot'
                  ? 'Included in every plan.'
                  : t.key === 'warm'
                    ? 'Small monthly cost per GB.'
                    : 'Costs almost nothing to keep.'}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`flex flex-col rounded-2xl border border-border bg-card p-7 ${p.featured ? 'iris-border glow-photon' : ''}`}
            >
              <p className="font-mono text-xs uppercase text-muted-foreground">{p.name}</p>
              <p className="mt-4">
                <span className="text-4xl font-semibold">{p.price}</span>{' '}
                <span className="text-sm text-muted-foreground">{p.unit}</span>
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{plain[p.name]?.who}</p>
              <p className="mt-4 text-sm">{plain[p.name]?.use}</p>
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <p>
                  <span className="text-warm">Kuiper Belt</span> · {plain[p.name]?.recent}
                </p>
                <p>
                  <span className="text-cold">Oort Cloud</span> · {plain[p.name]?.old}
                </p>
              </div>
              <ul className="mt-6 flex-1 space-y-2 text-sm">
                {(plain[p.name]?.features ?? p.features).map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-4 text-photon-glow" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                to={p.name === 'Enterprise' ? '/enterprise' : '/signin'}
                className={`mt-8 rounded-full py-2.5 text-center text-sm font-medium ${p.featured ? 'bg-primary text-primary-foreground' : 'border border-border'}`}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-20 rounded-2xl border border-border bg-card p-8">
          <h2 className="text-2xl font-semibold">What would it cost?</h2>
          <div className="mt-6 grid gap-8 md:grid-cols-2">
            <div className="space-y-6">
              <label className="block text-sm">
                How much your app remembers: <span className="font-mono">{gb} GB</span>
                <input
                  type="range"
                  min={10}
                  max={2000}
                  value={gb}
                  onChange={(e) => setGb(+e.target.value)}
                  className="mt-2 w-full accent-[var(--photon)]"
                />
              </label>
              <label className="block text-sm">
                Times it recalls something each month:{' '}
                <span className="font-mono">{ret.toLocaleString()}</span>
                <input
                  type="range"
                  min={100000}
                  max={20000000}
                  step={100000}
                  value={ret}
                  onChange={(e) => setRet(+e.target.value)}
                  className="mt-2 w-full accent-[var(--photon)]"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-xl border border-border p-5">
                <p className="text-xs text-muted-foreground">A typical memory database</p>
                <p className="mt-2 font-mono text-3xl">${flat.toLocaleString()}</p>
              </div>
              <div className="rounded-xl border border-photon p-5 glow-photon">
                <p className="text-xs text-muted-foreground">Oort Pro (estimate)</p>
                <p className="mt-2 font-mono text-3xl">${Math.round(oort).toLocaleString()}</p>
              </div>
              <p className="col-span-2 text-xs text-muted-foreground">
                We assume about 15% stays in the Kuiper Belt and the rest rests quietly in the Oort
                Cloud.
              </p>
            </div>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
