import { createFileRoute, Link } from '@tanstack/react-router';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';

export const Route = createFileRoute('/enterprise')({
  head: () => ({
    meta: [
      { title: 'Enterprise — Oort Cloud at global scale' },
      {
        name: 'description',
        content:
          'How a global retailer runs personal AI agents for 50 million members on Oort: regional cells, BYOK, tiered cost control.',
      },
      { property: 'og:title', content: 'Oort Cloud for enterprise' },
      {
        property: 'og:description',
        content:
          'Memory for millions of customers with per-customer encryption and flat infrastructure cost.',
      },
    ],
  }),
  component: Enterprise,
});

const flow = [
  ['Brand apps', 'Web · iOS · Android · in-store kiosks · support chat'],
  ['Agent layer', 'Shopping assistant, support agent, coach agent — all call one memory API'],
  ['Oort edge gateway', 'Auth, rate limits, tenant + customer routing, read hook < 80 ms'],
  ['Regional cells', 'US · EU · APAC — data never leaves its region'],
  ['Tiers per cell', 'Photosphere (hot RAM) → Kuiper (warm index) → Oort (object storage)'],
  ['Customer KMS', "One data key per member, wrapped by the brand's own key"],
];

const numbers = [
  ['50M', 'members with personal memory'],
  ['1.2B', 'retrievals / month'],
  ['~3%', 'of memories hot at any time'],
  ['$0.02', 'per GB-month for frozen history'],
];

function Enterprise() {
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="starfield mx-auto max-w-7xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
          Enterprise · example scenario
        </p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold">
          One memory for every customer. Built for millions.
        </h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Picture a global sportswear brand. Every member talks to an assistant that remembers their
          size, sports, injuries, past orders and what they said in-store last spring. Here is how
          that runs on Oort.
        </p>

        <div className="mt-12 grid grid-cols-2 gap-5 md:grid-cols-4">
          {numbers.map(([v, l]) => (
            <div key={l} className="rounded-2xl border border-border bg-card p-6">
              <p className="font-mono text-3xl">{v}</p>
              <p className="mt-1 text-sm text-muted-foreground">{l}</p>
            </div>
          ))}
        </div>

        <h2 className="mt-20 text-3xl font-semibold">How the system fits together</h2>
        <div className="mt-8 space-y-3">
          {flow.map(([t, d], i) => (
            <div
              key={t}
              className="flex items-center gap-5 rounded-2xl border border-border bg-card p-5"
              style={{ marginLeft: `${Math.min(i, 3) * 2}%` }}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-photon font-mono text-sm text-primary-foreground">
                {i + 1}
              </span>
              <div>
                <p className="font-semibold">{t}</p>
                <p className="text-sm text-muted-foreground">{d}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-20 grid gap-6 md:grid-cols-3">
          {[
            [
              'Organisation & teams',
              'Workspaces per brand or region, SSO/SAML, role-based access for engineering, data and privacy teams.',
            ],
            [
              'Cost stays flat',
              'As member histories grow 50×, stale memory freezes into object storage. Bills track activity, not age.',
            ],
            [
              'Privacy on request',
              'A member deletes their account: their key is destroyed and every tier becomes unreadable instantly.',
            ],
            [
              'Seasonal spikes',
              'Launch day traffic is absorbed by the hot tier; warm and cold scale independently.',
            ],
            [
              'Audit & compliance',
              'Per-call audit log, SOC 2, GDPR, CCPA. Dedicated VPC or fully self-hosted.',
            ],
            [
              'Billing',
              'Annual commit with usage tiers; chargeback reports per brand, region and agent.',
            ],
          ].map(([t, d]) => (
            <div key={t} className="iris-border rounded-2xl bg-card p-6">
              <h3 className="font-semibold">{t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>

        <div className="mt-20 text-center">
          <Link
            to="/dashboard"
            className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground"
          >
            See the enterprise console
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
