import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { proLine, proPriceLine } from '@/lib/oort-data';
import type { Overview } from '@/server/account';

const STATUS: Record<string, string> = {
  none: 'No subscription',
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment failed, Stripe is retrying',
  unpaid: 'Unpaid',
  canceled: 'Canceled',
  incomplete: 'Waiting for the first payment',
  incomplete_expired: 'First payment did not go through',
  paused: 'Paused',
};

export const statusLabel = (s: string) => STATUS[s] ?? s;

const n = (x: number) => x.toLocaleString('en-US');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

export type NewKey = { key: string; prefix: string; name: string };

export interface AccountActions {
  subscribe: () => Promise<string | null>;
  manage: () => Promise<string | null>;
  createKey: (name: string) => Promise<NewKey | string>;
  revoke: (id: string) => Promise<string | null>;
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono">
          {n(used)} / {n(limit)}
        </span>
      </div>
      <div
        className="mt-2 h-2 rounded-full bg-secondary"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AccountView({
  overview: o,
  actions,
  notice,
}: {
  overview: Overview;
  actions: AccountActions;
  notice?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<NewKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    if (err) setError(err);
    setBusy(false);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await actions.createKey(name);
    if (typeof r === 'string') setError(r);
    else {
      setFresh(r);
      setCopied(false);
      setName('');
    }
    setBusy(false);
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.key);
      setCopied(true);
    } catch {
      setError('Copy did not work here. Select the key and copy it by hand.');
    }
  };

  return (
    <div className="space-y-8">
      {notice ? (
        <p role="status" className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-ember/40 bg-ember/10 px-4 py-3 text-sm">
          {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">Plan</h2>
        <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Plan</dt>
          <dd>{o.plan === 'pro' ? 'Oort Pro' : 'Free'}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{statusLabel(o.status)}</dd>
          {o.currentPeriodEnd ? (
            <>
              <dt className="text-muted-foreground">
                {o.status === 'canceled' ? 'Ended' : 'Renews'}
              </dt>
              <dd>{day(o.currentPeriodEnd)}</dd>
            </>
          ) : null}
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">
          {proLine}. {proPriceLine}. Cancel any time in Manage billing.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {!o.entitled ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(actions.subscribe)}
              className="press rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              Subscribe to Pro
            </button>
          ) : null}
          {o.hasBilling ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(actions.manage)}
              className="rounded-full border border-border px-5 py-2 text-sm font-medium disabled:opacity-60"
            >
              Manage billing
            </button>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">This month</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {o.usage.month} (UTC). Pro stops at these amounts until the 1st of next month.
        </p>
        <div className="mt-4 space-y-4">
          <Meter label="Saves" used={o.usage.saves} limit={o.usage.limits.saves} />
          <Meter label="Recalls" used={o.usage.recalls} limit={o.usage.limits.recalls} />
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="size-4" /> API keys
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          An Oort key lets the Oort engine on your computer use Pro instead of your own Voyage,
          TypeSafe and Anthropic keys. Run <code className="font-mono">oort login</code> to create
          one from the CLI, or create a key here.
        </p>

        {fresh ? (
          <div className="mt-4 rounded-xl border border-photon p-4" data-testid="new-key">
            <p className="text-sm font-medium">
              Your new key "{fresh.name}". This is the only time it is shown.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 font-mono text-xs">
                {fresh.key}
              </code>
              <button
                type="button"
                onClick={copy}
                className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setFresh(null)}
              className="mt-3 text-xs text-muted-foreground underline"
            >
              I saved it, hide the key
            </button>
          </div>
        ) : null}

        <form onSubmit={create} className="mt-4 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="key-name">
            Key name
          </label>
          <input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            required
            placeholder="Name, for example Work laptop"
            className="min-w-0 flex-1 rounded-xl border border-input bg-background px-4 py-2 text-sm outline-none focus:border-ring"
          />
          <button
            disabled={busy}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            Create key
          </button>
        </form>

        {o.keys.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border text-sm">
            {o.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <code className="font-mono text-xs">{k.prefix}…</code>
                <span className="flex-1">{k.name}</span>
                <span className="text-xs text-muted-foreground">
                  created {day(k.createdAt)} · last used {day(k.lastUsedAt)}
                </span>
                {k.revokedAt ? (
                  <span className="text-xs text-muted-foreground">revoked {day(k.revokedAt)}</span>
                ) : confirming === k.id ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setConfirming(null);
                        return actions.revoke(k.id);
                      })
                    }
                    className="rounded-full bg-ember px-3 py-1 text-xs text-background"
                  >
                    Confirm revoke
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(k.id)}
                    className="rounded-full border border-border px-3 py-1 text-xs"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
