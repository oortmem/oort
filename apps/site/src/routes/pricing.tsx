import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { WaitlistForm } from '@/components/site/WaitlistForm';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import {
  byokOverage,
  byokPlans,
  byokPrice,
  estimateMonthlyCost,
  plans,
  proLine,
  proPriceLine,
  tiers,
} from '@/lib/oort-data';

export const Route = createFileRoute('/pricing')({
  head: () => ({
    meta: [
      { title: 'Pricing | Oort Cloud' },
      {
        name: 'description',
        content:
          'Open source and free to self-host. Hosted Free, Pro $19/month (VAT included where applicable), Team $99 a month. Prices are a launch proposal.',
      },
      { property: 'og:title', content: 'Oort Cloud pricing' },
      {
        property: 'og:description',
        content: 'Pay for saves and recalls. Old memories cost almost nothing to keep.',
      },
    ],
  }),
  component: Pricing,
});

function Pricing() {
  const [byok, setByok] = useState(false);
  const [gb, setGb] = useState(20);
  const [recalls, setRecalls] = useState(100_000);
  const [saves, setSaves] = useState(50_000);
  const warm = Math.round(gb * 0.15 * 100) / 100;
  const cold = Math.round((gb - warm) * 100) / 100;
  const est = estimateMonthlyCost({ saves, recalls, warmGb: warm, coldGb: cold }, { byok });
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="mx-auto max-w-7xl px-6 py-20">
        <h1 className="text-5xl font-semibold">Pay for what you save and recall.</h1>
        <p className="mt-4 max-w-xl text-muted-foreground">
          A save is one thing your agent asks Oort to remember. A recall is one search for memories.
          Fresh memories cost a little, old ones almost nothing. Smart rerank runs when it helps, so
          you do not pay for it on every recall.
        </p>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          Hosted Oort Cloud is not open yet. Today you run the open source engine on your own
          machine, with your own keys or with Oort Pro.
        </p>
        <p className="mt-3 max-w-xl text-base font-medium">
          {proLine}. {proPriceLine}.
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
                    ? 'Warm storage is the included managed tier by default. Extra is $0.50 per GB a month.'
                    : 'Costs almost nothing to keep: $0.03 per GB a month beyond the included amount.'}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card/60 p-5">
          <button
            role="switch"
            aria-checked={byok}
            aria-label="Bring your own keys"
            onClick={() => setByok(!byok)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${byok ? 'bg-primary' : 'bg-secondary'}`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-foreground transition-all ${byok ? 'left-[22px]' : 'left-0.5'}`}
            />
          </button>
          <div className="flex-1 text-sm">
            <p className="font-medium">Bring your own keys</p>
            <p className="text-muted-foreground">
              You supply your own Voyage, TypeSafe and Anthropic keys and pay those providers
              directly. Oort then charges only for storage and orchestration, so the plans cost less
              and include more.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-5">
          {plans.map((p) => {
            const key = p.name as keyof typeof byokPlans;
            const useByok = byok && p.name in byokPlans;
            const price = useByok ? byokPrice[key] : p.price;
            const included = useByok ? byokPlans[key] : p.included;
            const over = useByok && key !== 'Free' ? byokOverage[key] : undefined;
            const features = useByok
              ? [
                  ...(over ? [over] : []),
                  ...p.features.filter((f) => !f.startsWith('Extra use') && !f.startsWith('Same')),
                ]
              : p.features;
            return (
              <div
                key={p.name}
                className={`flex flex-col rounded-2xl border border-border bg-card p-6 ${p.featured ? 'iris-border glow-photon' : ''}`}
              >
                <p className="font-mono text-xs uppercase text-muted-foreground">{p.name}</p>
                <p className="mt-4">
                  <span className="text-3xl font-semibold">{price}</span>{' '}
                  <span className="text-sm text-muted-foreground">{p.unit}</span>
                </p>
                <p className="mt-2 text-sm text-muted-foreground">{p.who}</p>
                <ul className="mt-4 space-y-0.5 text-sm">
                  {included.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                <ul className="mt-5 flex-1 space-y-2 text-sm">
                  {features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-photon-glow" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {p.name === 'Open Source' ? (
                  <a
                    href="https://github.com/oortmem/oort"
                    className="mt-8 rounded-full border border-border py-2.5 text-center text-sm font-medium"
                  >
                    {p.cta}
                  </a>
                ) : p.name === 'Enterprise' ? (
                  <Link
                    to="/enterprise"
                    className="mt-8 rounded-full border border-border py-2.5 text-center text-sm font-medium"
                  >
                    {p.cta}
                  </Link>
                ) : p.name === 'Pro' && !byok ? (
                  // Sign in first (the account page redirects), then straight on to Checkout.
                  <Link
                    to="/account"
                    search={{ subscribe: 'pro' }}
                    className="press mt-8 rounded-full bg-primary py-2.5 text-center text-sm font-medium text-primary-foreground"
                  >
                    {p.cta}
                  </Link>
                ) : (
                  <a
                    href="#early-access"
                    className={`mt-8 rounded-full py-2.5 text-center text-sm font-medium ${p.featured ? 'bg-primary text-primary-foreground' : 'border border-border'}`}
                  >
                    {p.name === 'Pro' ? 'Get early access' : p.cta}
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Prices are a launch proposal. Free is a hard stop: it never bills and never asks for a
          card.
        </p>
        <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
          Oort Pro ({proPriceLine}) works with the engine on your machine: Oort makes the Voyage,
          TypeSafe and Anthropic calls for you, so you need no keys of your own. Pro stops at 25,000
          saves and 50,000 recalls a month; extra use is not billed yet. The warm and cold storage
          amounts apply to hosted Oort Cloud, which is <PlannedBadge />. Your own keys pricing is
          for hosted Oort Cloud too.
        </p>

        <div className="mt-16">
          <WaitlistForm source="pricing" id="early-access" />
        </div>

        <div className="mt-20 rounded-2xl border border-border bg-card p-8">
          <h2 className="text-2xl font-semibold">What would it cost?</h2>
          <div className="mt-6 grid gap-8 md:grid-cols-2">
            <div className="space-y-6">
              <label className="block text-sm">
                How much your app remembers: <span className="font-mono">{gb} GB</span>
                <input
                  type="range"
                  min={1}
                  max={500}
                  value={gb}
                  onChange={(e) => setGb(+e.target.value)}
                  className="mt-2 w-full accent-[var(--photon)]"
                />
              </label>
              <label className="block text-sm">
                Saves each month: <span className="font-mono">{saves.toLocaleString()}</span>
                <input
                  type="range"
                  min={1000}
                  max={5_000_000}
                  step={1000}
                  value={saves}
                  onChange={(e) => setSaves(+e.target.value)}
                  className="mt-2 w-full accent-[var(--photon)]"
                />
              </label>
              <label className="block text-sm">
                Recalls each month: <span className="font-mono">{recalls.toLocaleString()}</span>
                <input
                  type="range"
                  min={1000}
                  max={10_000_000}
                  step={1000}
                  value={recalls}
                  onChange={(e) => setRecalls(+e.target.value)}
                  className="mt-2 w-full accent-[var(--photon)]"
                />
              </label>
            </div>
            <div className="space-y-4">
              <div className="rounded-xl border border-photon p-5 glow-photon">
                <p className="text-xs text-muted-foreground">
                  Estimate: {est.plan} plan{byok ? ', your own keys' : ''}
                </p>
                <p className="mt-2 font-mono text-3xl">${est.monthly.toLocaleString()}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {est.overage > 0
                    ? `Includes $${est.overage.toLocaleString()} of extra use and storage.`
                    : 'Fits inside what the plan includes.'}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                We assume about 15% stays in the Kuiper Belt and the rest rests quietly in the Oort
                Cloud. {byok ? 'Your own provider bills are extra. ' : ''}Prices are a launch
                proposal.
              </p>
              <p className="text-xs text-muted-foreground">
                Private deployment, SOC 2 and an uptime SLA are <PlannedBadge />, so they are not
                part of any price here.
              </p>
            </div>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
