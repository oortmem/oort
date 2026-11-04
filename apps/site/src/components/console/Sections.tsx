import { useState } from 'react';
import { Copy, Plus, RotateCw, Trash2, Check } from 'lucide-react';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { estimateMonthlyCost } from '@/lib/oort-data';

export { StarMapSection } from './StarMap';
export { OrganisationSection } from './Organisation';

const card = 'rounded-2xl border border-border bg-card p-5';
const label = 'font-mono text-xs text-muted-foreground';

const tenantRows = [
  {
    name: 'Example retailer · US',
    customers: '21.4M',
    ret: '512M',
    p95: '71 ms',
    region: 'us-east',
    status: 'Healthy',
  },
  {
    name: 'Example retailer · EU',
    customers: '17.9M',
    ret: '401M',
    p95: '68 ms',
    region: 'eu-west',
    status: 'Healthy',
  },
  {
    name: 'Example retailer · APAC',
    customers: '10.7M',
    ret: '287M',
    p95: '74 ms',
    region: 'ap-south',
    status: 'Rebalancing',
  },
  {
    name: 'Support agent',
    customers: '3.2M',
    ret: '44M',
    p95: '52 ms',
    region: 'us-east',
    status: 'Healthy',
  },
  {
    name: 'Loyalty concierge',
    customers: '1.1M',
    ret: '12M',
    p95: '49 ms',
    region: 'eu-west',
    status: 'Healthy',
  },
];

export function TenantsSection() {
  const [q, setQ] = useState('');
  const rows = tenantRows.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter tenants…"
          className="w-64 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm outline-none"
        />
        <button className="press flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground">
          <Plus className="size-3.5" /> New tenant
        </button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {['Tenant', 'Customers', 'Retrievals / mo', 'p95', 'Region', 'Status'].map((h) => (
              <th key={h} className="px-5 py-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.name} className="border-t border-border transition hover:bg-secondary/50">
              <td className="px-5 py-3">{t.name}</td>
              <td className="px-5 py-3 font-mono">{t.customers}</td>
              <td className="px-5 py-3 font-mono">{t.ret}</td>
              <td className="px-5 py-3 font-mono">{t.p95}</td>
              <td className="px-5 py-3 font-mono text-muted-foreground">{t.region}</td>
              <td className="px-5 py-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${t.status === 'Healthy' ? 'bg-photon/15 text-photon-glow' : 'bg-ember/15 text-ember'}`}
                >
                  {t.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StorageSection() {
  const tiers = [
    {
      n: 'Photosphere · hot',
      used: '1.2 TB',
      cap: '2 TB',
      p: 60,
      c: 'bg-hot',
      note: 'int8 vectors in RAM (sample figures)',
    },
    {
      n: 'Kuiper · warm',
      used: '38 TB',
      cap: '64 TB',
      p: 59,
      c: 'bg-warm',
      note: '512-dim int8 + BM25 keyword (binary quantization is Planned)',
    },
    {
      n: 'Oort · cold',
      used: '412 TB',
      cap: 'no cap',
      p: 100,
      c: 'bg-cold',
      note: 'text, stub and entities, zstd-compressed',
    },
  ];
  const [ttl, setTtl] = useState(30);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {tiers.map((t) => (
          <div key={t.n} className={card}>
            <p className={label}>{t.n}</p>
            <p className="mt-2 font-mono text-2xl">
              {t.used} <span className="text-sm text-muted-foreground">/ {t.cap}</span>
            </p>
            <div className="mt-3 h-2 rounded-full bg-secondary">
              <div
                className={`h-2 rounded-full ${t.c} transition-all duration-700`}
                style={{ width: `${t.p}%` }}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{t.note}</p>
          </div>
        ))}
      </div>
      <div className={card}>
        <p className={label}>Eviction policy</p>
        <div className="mt-4 flex items-center gap-4">
          <span className="text-sm">Freeze warm memories untouched for</span>
          <input
            type="range"
            min={7}
            max={180}
            value={ttl}
            onChange={(e) => setTtl(+e.target.value)}
            className="flex-1 accent-[var(--photon)]"
          />
          <span className="w-20 font-mono text-sm">{ttl} days</span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Longer waits keep more in the warm tier. Savings depend on your data and are not estimated
          here.
        </p>
      </div>
    </div>
  );
}

export function KeysSection() {
  const [keys, setKeys] = useState([
    { name: 'prod-server', key: 'oort_live_8f2a…91c', created: 'Mar 2, 2026', last: '2s ago' },
    { name: 'staging', key: 'oort_test_31bd…0ea', created: 'Jan 18, 2026', last: '1h ago' },
  ]);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="overflow-hidden rounded-2xl border border-border bg-card lg:col-span-2">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <p className={label}>API keys</p>
          <button
            onClick={() =>
              setKeys([
                ...keys,
                {
                  name: `key-${keys.length + 1}`,
                  key: `oort_live_${Math.random().toString(16).slice(2, 6)}…${Math.random().toString(16).slice(2, 5)}`,
                  created: 'Today',
                  last: 'never',
                },
              ])
            }
            className="press flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground"
          >
            <Plus className="size-3.5" /> Create key
          </button>
        </div>
        {keys.map((k) => (
          <div
            key={k.key}
            className="flex animate-rise items-center gap-4 border-t border-border px-5 py-3 text-sm first:border-0"
          >
            <span className="w-28">{k.name}</span>
            <span className="flex-1 font-mono text-muted-foreground">{k.key}</span>
            <span className="text-xs text-muted-foreground">used {k.last}</span>
            <button
              onClick={() => {
                setCopied(k.key);
                setTimeout(() => setCopied(null), 1200);
              }}
              className="press"
              aria-label="Copy"
            >
              {copied === k.key ? (
                <Check className="size-4 text-photon-glow" />
              ) : (
                <Copy className="size-4 text-muted-foreground" />
              )}
            </button>
            <button
              onClick={() => setKeys(keys.filter((x) => x.key !== k.key))}
              className="press"
              aria-label="Revoke"
            >
              <Trash2 className="size-4 text-destructive" />
            </button>
          </div>
        ))}
      </div>
      <div className={card}>
        <p className={label}>
          Customer encryption <PlannedBadge className="ml-2" />
        </p>
        <p className="mt-3 text-sm">
          Provider: <span className="font-mono">AWS KMS · eu-west-1</span>
        </p>
        <p className="mt-1 text-sm">
          Per-customer DEKs: <span className="font-mono">51.2M</span>
        </p>
        <p className="mt-1 text-sm">
          Last root rotation: <span className="font-mono">14 days ago</span>
        </p>
        <button className="press mt-5 flex items-center gap-2 rounded-full border border-border px-4 py-2 text-xs">
          <RotateCw className="size-3.5" /> Rotate root key
        </button>
      </div>
    </div>
  );
}

export function UsageSection() {
  const [r, setR] = useState(2_000_000);
  const [w, setW] = useState(300_000);
  const days = [62, 70, 68, 75, 81, 79, 88, 92, 85, 90, 97, 102, 99, 108];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className={`${card} lg:col-span-2`}>
        <p className={label}>Retrievals per day (millions)</p>
        <div className="mt-6 flex h-48 items-end gap-2">
          {days.map((v, i) => (
            <div
              key={i}
              className="flex-1 origin-bottom animate-rise rounded-t bg-photon/80 transition hover:bg-photon-glow"
              style={{ height: `${(v / 110) * 100}%`, animationDelay: `${i * 40}ms` }}
              title={`${v}M`}
            />
          ))}
        </div>
      </div>
      <div className={card}>
        <p className={label}>Cost estimator (launch proposal)</p>
        <label className="mt-4 block text-xs text-muted-foreground">
          Recalls / mo: <span className="font-mono text-foreground">{r.toLocaleString()}</span>
        </label>
        <input
          type="range"
          min={0}
          max={5_000_000}
          step={50_000}
          value={r}
          onChange={(e) => setR(+e.target.value)}
          className="w-full accent-[var(--photon)]"
        />
        <label className="mt-3 block text-xs text-muted-foreground">
          Saves / mo: <span className="font-mono text-foreground">{w.toLocaleString()}</span>
        </label>
        <input
          type="range"
          min={0}
          max={1_000_000}
          step={10_000}
          value={w}
          onChange={(e) => setW(+e.target.value)}
          className="w-full accent-[var(--photon)]"
        />
        <p className="mt-5 font-mono text-3xl">
          $
          {estimateMonthlyCost({
            saves: w,
            recalls: r,
            warmGb: 4,
            coldGb: 40,
          }).monthly.toLocaleString()}
        </p>
        <p className="text-xs text-muted-foreground">with 4 GB warm · 40 GB cold</p>
      </div>
    </div>
  );
}

export function SettingsSection() {
  const [s, setS] = useState({ rerank: true, pii: true, audit: true, residency: false });
  const rows: [keyof typeof s, string, string][] = [
    ['rerank', 'Smart rerank', 'Voyage rerank of the top 30 candidates when it helps'],
    ['pii', 'Secret scrubbing', 'Scrub secrets before a memory is saved'],
    ['audit', 'Audit log streaming (Planned)', 'Send every recall and forget to your SIEM'],
    ['residency', 'Strict data residency (Planned)', 'Never route a tenant outside its region'],
  ];
  return (
    <div className="max-w-2xl overflow-hidden rounded-2xl border border-border bg-card">
      {rows.map(([k, t, d]) => (
        <button
          key={k}
          onClick={() => setS({ ...s, [k]: !s[k] })}
          role="switch"
          aria-checked={s[k]}
          className="press flex w-full items-center gap-4 border-t border-border px-5 py-4 text-left first:border-0"
        >
          <span className="flex-1">
            <span className="block text-sm">{t}</span>
            <span className="text-xs text-muted-foreground">{d}</span>
          </span>
          <span
            className={`relative h-5 w-9 rounded-full transition ${s[k] ? 'bg-photon' : 'bg-secondary'}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-starlight transition-all ${s[k] ? 'left-[18px]' : 'left-0.5'}`}
            />
          </span>
        </button>
      ))}
    </div>
  );
}
