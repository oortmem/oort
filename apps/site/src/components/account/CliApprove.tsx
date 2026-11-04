import { useState } from 'react';
import type { CliRequestView } from '@/server/account';
import type { Result } from '@/server/result';

/** The country Cloudflare saw when the request started, in words. */
export function countryName(code: string | null): string {
  if (code === null || code === 'XX') return 'Unknown';
  if (code === 'T1') return 'The Tor network';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function startedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * /account/cli: the user types the code their terminal shows after `oort login`, checks where the
 * request came from, and approves. The page URL carries nothing secret (review I3, I4).
 */
export function CliApprove({
  entitled,
  today,
  lookup,
  approve,
}: {
  entitled: boolean;
  /** YYYY-MM-DD, for the key name preview. */
  today: string;
  lookup: (code: string) => Promise<Result<CliRequestView>>;
  approve: (code: string) => Promise<string | null>;
}) {
  const [typed, setTyped] = useState('');
  const [found, setFound] = useState<CliRequestView | null>(null);
  const [state, setState] = useState<'enter' | 'busy' | 'confirm' | 'done'>('enter');
  const [error, setError] = useState<string | null>(null);

  const alert = error ? (
    <p role="alert" className="rounded-xl border border-ember/40 bg-ember/10 px-3 py-2">
      {error}
    </p>
  ) : null;

  if (state === 'done') {
    return (
      <div role="status" className="space-y-2 text-sm">
        <p className="text-lg font-semibold">Approved.</p>
        <p className="text-muted-foreground">
          Go back to your terminal. It receives its key in a few seconds. You can close this tab.
        </p>
      </div>
    );
  }

  if (found === null) {
    return (
      <form
        className="space-y-4 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setState('busy');
          setError(null);
          const r = await lookup(typed);
          if (r.ok) {
            setFound(r.value);
            setState('confirm');
          } else {
            setError(r.error);
            setState('enter');
          }
        }}
      >
        <h1 className="text-2xl font-semibold">Sign in the Oort CLI</h1>
        <p className="text-muted-foreground">
          Type the code your terminal shows after <code className="font-mono">oort login</code>.
        </p>
        <label className="block space-y-1">
          <span className="font-medium">Code</span>
          <input
            name="code"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="BCDF-GHJK"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            required
            className="block w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-2xl tracking-widest uppercase"
          />
        </label>
        {alert}
        <button
          type="submit"
          disabled={state === 'busy'}
          className="press rounded-full bg-primary px-5 py-2 font-medium text-primary-foreground disabled:opacity-60"
        >
          Continue
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-2xl font-semibold">Approve this sign-in?</h1>
      <p
        role="note"
        className="rounded-xl border border-ember/40 bg-ember/10 px-3 py-2 font-medium text-ember"
      >
        Only approve if you just ran oort login yourself. If someone sent you this code, do not
        approve: they would get a key to your account.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Code</dt>
        <dd className="font-mono" data-testid="cli-code">
          {found.code}
        </dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>
          <time dateTime={found.createdAt}>{startedAt(found.createdAt)}</time>
        </dd>
        <dt className="text-muted-foreground">From (approximate)</dt>
        <dd data-testid="cli-country">{countryName(found.country)}</dd>
        <dt className="text-muted-foreground">Computer</dt>
        <dd data-testid="cli-host">{found.host ?? 'Not reported'}</dd>
        <dt className="text-muted-foreground">System</dt>
        <dd data-testid="cli-os">{found.os ?? 'Not reported'}</dd>
      </dl>
      <p className="text-muted-foreground">
        Approving creates a new key named "CLI on {today}" for that computer. You can revoke it on
        your <a href="/account">account page</a> at any time. The request expires 10 minutes after{' '}
        <code className="font-mono">oort login</code> started.
      </p>
      {!entitled ? (
        <p className="rounded-xl border border-ember/40 bg-ember/10 px-3 py-2 text-ember">
          This account does not have Oort Pro yet, so the key will not work until you subscribe on
          your account page.
        </p>
      ) : null}
      {found.keyLimitReached ? (
        <p className="rounded-xl border border-ember/40 bg-ember/10 px-3 py-2 text-ember">
          This account already has the most live keys it can have. Revoke one on your{' '}
          <a href="/account">account page</a> first.
        </p>
      ) : null}
      {alert}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={state === 'busy' || found.keyLimitReached}
          onClick={async () => {
            setState('busy');
            setError(null);
            const err = await approve(found.code);
            if (err) {
              setError(err);
              setState('confirm');
            } else setState('done');
          }}
          className="press rounded-full bg-primary px-5 py-2 font-medium text-primary-foreground disabled:opacity-60"
        >
          Approve
        </button>
        <a href="/account" className="rounded-full border border-border px-5 py-2 font-medium">
          This was not me
        </a>
      </div>
    </div>
  );
}
