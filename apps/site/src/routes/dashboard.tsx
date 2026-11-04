import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import type React from 'react';
import {
  Activity,
  Building2,
  ChevronRight,
  Database,
  Key,
  LayoutGrid,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { Logo } from '@/components/site/Logo';
import { timeline, tierClass } from '@/lib/oort-data';
import {
  StarMapSection,
  TenantsSection,
  StorageSection,
  KeysSection,
  UsageSection,
  OrganisationSection,
  SettingsSection,
} from '@/components/console/Sections';

const sections: Record<string, () => React.ReactElement> = {
  'Star map': StarMapSection,
  Tenants: TenantsSection,
  Storage: StorageSection,
  'Keys & KMS': KeysSection,
  Usage: UsageSection,
  Organisation: OrganisationSection,
  Settings: SettingsSection,
};

export const Route = createFileRoute('/dashboard')({
  head: () => ({
    meta: [
      { title: 'Console demo | Oort Cloud' },
      {
        name: 'description',
        content:
          'A demo of the Oort Cloud console with sample data: memory star map, tier health, recall latency, tenants and keys.',
      },
      { property: 'og:title', content: 'Oort Cloud console' },
      {
        property: 'og:description',
        content: 'Monitor agent memory across hot, warm and cold tiers.',
      },
    ],
  }),
  component: Dashboard,
});

const nav = [
  ['Overview', LayoutGrid],
  ['Star map', Search],
  ['Tenants', Users],
  ['Storage', Database],
  ['Keys & KMS', Key],
  ['Usage', Activity],
  ['Organisation', Building2],
  ['Settings', Settings],
] as const;

const latency = [
  42, 38, 55, 47, 61, 44, 39, 52, 48, 36, 41, 58, 45, 40, 37, 49, 53, 43, 39, 46, 50, 42, 38, 44,
];

const tenants = [
  {
    name: 'Example retailer · US',
    customers: '21.4M',
    ret: '512M',
    p95: '71 ms',
    region: 'us-east',
  },
  {
    name: 'Example retailer · EU',
    customers: '17.9M',
    ret: '401M',
    p95: '68 ms',
    region: 'eu-west',
  },
  {
    name: 'Example retailer · APAC',
    customers: '10.7M',
    ret: '287M',
    p95: '74 ms',
    region: 'ap-south',
  },
  { name: 'Support agent', customers: '3.2M', ret: '44M', p95: '52 ms', region: 'us-east' },
];

function Dashboard() {
  const [active, setActive] = useState('Overview');
  const [env, setEnv] = useState<'Production' | 'Staging'>('Production');
  return (
    <div className="starfield relative flex min-h-screen">
      <div className="pointer-events-none fixed -right-40 -top-40 size-[600px] animate-orbit-slow rounded-full border border-dashed border-border" />
      <div className="pointer-events-none fixed -right-20 -top-20 size-[360px] rounded-full bg-photon/10 blur-3xl" />
      <aside className="liquid-glass sticky top-4 z-10 m-4 hidden h-[calc(100vh-2rem)] w-60 shrink-0 flex-col rounded-3xl p-4 md:flex">
        <Logo compact />
        <button
          onClick={() => setActive('Organisation')}
          className="press mt-6 w-full rounded-2xl border border-border p-3 text-left transition hover:border-foreground/25"
        >
          <div className="flex items-center gap-3">
            <span className="relative grid size-9 shrink-0 place-items-center rounded-full border border-border bg-void">
              <span className="size-2.5 animate-breathe rounded-full bg-hot glow-photon" />
              <span className="absolute inset-0 rounded-full border border-dashed border-photon/40 animate-orbit-slow" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                Organisation
              </span>
              <span className="block truncate text-sm font-medium">Acme Global</span>
              <span className="block text-[10px] text-muted-foreground">Demo · {env}</span>
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </div>
        </button>
        <nav className="mt-6 space-y-1">
          {nav.map(([label, I]) => (
            <button
              key={label}
              onClick={() => setActive(label)}
              className={`press relative flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm transition ${active === label ? 'bg-foreground/10 text-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,var(--starlight)_25%,transparent)]' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'}`}
            >
              <I className={`size-4 ${active === label ? 'text-photon-glow' : ''}`} /> {label}
              {active === label && (
                <span className="absolute right-3 size-1.5 animate-twinkle rounded-full bg-photon-glow" />
              )}
            </button>
          ))}
        </nav>
        <Link to="/" className="mt-auto text-xs text-muted-foreground">
          ← Back to site
        </Link>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <header className="liquid-glass sticky top-4 z-10 mx-4 mt-4 flex items-center justify-between rounded-full px-6 py-3 md:ml-0">
          <div>
            <h1 className="text-xl font-semibold">{active}</h1>
            <p className="text-xs text-muted-foreground">
              <PlannedBadge kind="Demo" className="mr-1.5" />
              Sample data for a made-up organisation. Not real usage.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border p-1 text-xs">
            {(['Production', 'Staging'] as const).map((e) => (
              <button
                key={e}
                onClick={() => setEnv(e)}
                className={`rounded-full px-3 py-1 ${env === e ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
              >
                {e}
              </button>
            ))}
          </div>
        </header>

        {active !== 'Overview' ? (
          <div key={active} className="animate-rise p-8">
            {(() => {
              const S = sections[active];
              return S ? <S /> : null;
            })()}
          </div>
        ) : (
          <div className="animate-rise space-y-6 p-8">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                ['Memories', '8.41B', 'var(--photon)'],
                ['Photosphere RAM', '142 MB', 'var(--hot)'],
                ['p95 retrieval', '68 ms', 'var(--warm)'],
                ['Month to date', '$41,280', 'var(--cold)'],
              ].map(([k, v, c], i) => (
                <div
                  key={k}
                  className="relative animate-rise rounded-2xl border border-border bg-card/60 p-5 transition hover:border-foreground/20"
                  style={{ animationDelay: `${i * 80}ms` }}
                >
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full" style={{ background: c }} />
                    {k}
                  </p>
                  <p className="mt-2 font-mono text-2xl">{v}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <StarMapSection height={440} panel={false} />
              </div>
              <div className="rounded-2xl border border-border bg-card p-5">
                <p className="font-mono text-xs text-muted-foreground">Tier distribution</p>
                <div className="relative mx-auto mt-4 grid size-48 place-items-center">
                  {[
                    ['var(--cold)', 96, 79],
                    ['var(--warm)', 66, 18],
                    ['var(--hot)', 36, 3],
                  ].map(([c, r, p]) => (
                    <svg
                      key={r as number}
                      className="absolute inset-0 size-full -rotate-90"
                      viewBox="0 0 200 200"
                    >
                      <circle
                        cx="100"
                        cy="100"
                        r={r as number}
                        fill="none"
                        stroke="var(--secondary)"
                        strokeWidth="8"
                      />
                      <circle
                        cx="100"
                        cy="100"
                        r={r as number}
                        fill="none"
                        stroke={c as string}
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={`${(2 * Math.PI * (r as number) * (p as number)) / 100} 999`}
                        style={{ filter: `drop-shadow(0 0 6px ${c})` }}
                      />
                    </svg>
                  ))}
                  <span className="size-3 animate-breathe rounded-full bg-hot glow-photon" />
                </div>
                {[
                  ['Photosphere', 3, 'bg-hot'],
                  ['Kuiper Belt', 18, 'bg-warm'],
                  ['Oort Cloud', 79, 'bg-cold'],
                ].map(([l, p, c]) => (
                  <div key={l as string} className="mt-3 flex items-center gap-2 text-sm">
                    <span className={`size-2 rounded-full ${c}`} />
                    <span className="flex-1">{l}</span>
                    <span className="font-mono">{p}%</span>
                  </div>
                ))}
                <p className="mt-6 text-xs text-muted-foreground">
                  2.1M memories hydrated from Oort in the last 24h.
                </p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <div className="rounded-2xl border border-border bg-card p-5 lg:col-span-2">
                <p className="font-mono text-xs text-muted-foreground">
                  Retrieval latency · last 24h (ms)
                </p>
                <div className="mt-6 flex h-40 items-end gap-1.5">
                  {latency.map((v, i) => (
                    <div
                      key={i}
                      className="flex-1 animate-rise rounded-t bg-gradient-to-t from-photon/40 to-photon-glow transition hover:opacity-80"
                      style={{ height: `${(v / 70) * 100}%` }}
                      title={`${v} ms`}
                    />
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-card p-5">
                <p className="font-mono text-xs text-muted-foreground">Recent recalls</p>
                <ul className="mt-4 space-y-3">
                  {timeline.map((t) => (
                    <li key={t.q} className="flex items-start gap-3 text-sm">
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${tierClass[t.tier]}`}
                      />
                      <span className="flex-1">{t.q}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{t.when}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <p className="border-b border-border px-5 py-4 font-mono text-xs text-muted-foreground">
                Tenants
              </p>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3">Tenant</th>
                    <th className="px-5 py-3">Customers</th>
                    <th className="px-5 py-3">Retrievals / mo</th>
                    <th className="px-5 py-3">p95</th>
                    <th className="px-5 py-3">Region</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.name} className="border-t border-border">
                      <td className="px-5 py-3">{t.name}</td>
                      <td className="px-5 py-3 font-mono">{t.customers}</td>
                      <td className="px-5 py-3 font-mono">{t.ret}</td>
                      <td className="px-5 py-3 font-mono">{t.p95}</td>
                      <td className="px-5 py-3 font-mono text-muted-foreground">{t.region}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
