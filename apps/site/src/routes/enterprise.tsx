import { createFileRoute, Link } from '@tanstack/react-router';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { PlannedBadge } from '@/components/site/PlannedBadge';

export const Route = createFileRoute('/enterprise')({
  head: () => ({
    meta: [
      { title: 'Enterprise | An example scenario for Oort Cloud' },
      {
        name: 'description',
        content:
          'A hypothetical scenario: a retailer with 50 million members and personal AI agents, and how it could run on Oort.',
      },
      { property: 'og:title', content: 'Oort Cloud for enterprise' },
      {
        property: 'og:description',
        content: 'A hypothetical scenario for memory at the scale of millions of customers.',
      },
    ],
  }),
  component: Enterprise,
});

const flow: [string, string, boolean][] = [
  ['Brand apps', 'Web, iOS, Android, in-store kiosks, support chat', false],
  ['Agent layer', 'Shopping assistant, support agent, coach agent. All call one memory API', false],
  ['Oort gateway', 'Auth, rate limits, tenant and customer routing', true],
  ['Regional cells', 'US, EU and APAC, so data stays in its region', true],
  ['Tiers per cell', 'Photosphere (hot) to Kuiper Belt (warm) to Oort Cloud (cold)', false],
  ['Customer keys', "One data key per member, wrapped by the brand's own key", true],
];

const numbers = [
  ['50M', 'members, assumed for this scenario'],
  ['1.2B', 'recalls a month, assumed for this scenario'],
];

function Enterprise() {
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="starfield mx-auto max-w-7xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
          Enterprise · hypothetical scenario
        </p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold">
          One memory for every customer, at the scale of millions.
        </h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Picture a retailer with 50M members. Every member talks to an assistant that remembers
          their size, sports, injuries, past orders and what they said in-store last spring. This is
          a hypothetical scenario, not a customer. Here is how it could run on Oort. Parts that are
          not built yet are labelled.
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
          {flow.map(([t, d, planned], i) => (
            <div
              key={t}
              className="flex items-center gap-5 rounded-2xl border border-border bg-card p-5"
              style={{ marginLeft: `${Math.min(i, 3) * 2}%` }}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-photon font-mono text-sm text-primary-foreground">
                {i + 1}
              </span>
              <div>
                <p className="font-semibold">
                  {t} {planned && <PlannedBadge className="ml-1" />}
                </p>
                <p className="text-sm text-muted-foreground">{d}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-20 grid gap-6 md:grid-cols-3">
          {(
            [
              [
                'Organisation and teams',
                'Workspaces per brand or region, SSO and SAML, role-based access for engineering, data and privacy teams.',
                true,
              ],
              [
                'Cost that follows activity',
                'As member histories grow, stale memory goes cold and is compressed. The goal is that bills track activity, not age.',
                false,
              ],
              [
                'Privacy on request',
                'A member deletes their account and their key is destroyed, so every tier becomes unreadable. Today you can forget single memories from the CLI.',
                true,
              ],
              [
                'Seasonal spikes',
                'The tiers are designed to scale independently, so launch day traffic does not need cold storage to grow.',
                true,
              ],
              [
                'Audit and compliance',
                'A per-call audit log, SOC 2, GDPR and CCPA, and a dedicated VPC. Fully self-hosted is possible today with the open source engine.',
                true,
              ],
              [
                'Billing',
                'Annual commit with usage tiers, and chargeback reports per brand, region and agent.',
                true,
              ],
            ] as const
          ).map(([t, d, planned]) => (
            <div key={t} className="iris-border rounded-2xl bg-card p-6">
              <h3 className="font-semibold">
                {t} {planned && <PlannedBadge className="ml-1" />}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>

        <div className="mt-20 text-center">
          <Link
            to="/dashboard"
            className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground"
          >
            See the console demo
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
