import { useEffect, useState } from 'react';
import { cliCode } from '@/server/keys';

export function CliApprove({
  session,
  entitled,
  today,
  approve,
}: {
  session: string;
  entitled: boolean;
  /** YYYY-MM-DD, for the key name preview. */
  today: string;
  approve: () => Promise<string | null>;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<'ask' | 'busy' | 'done'>('ask');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (session) void cliCode(session).then((c) => live && setCode(c));
    return () => {
      live = false;
    };
  }, [session]);

  if (!session) {
    return (
      <p role="alert" className="text-sm">
        This link has no sign-in request. Run <code className="font-mono">oort login</code> again in
        your terminal.
      </p>
    );
  }

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

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-2xl font-semibold">Sign in the Oort CLI?</h1>
      <p className="text-muted-foreground">Check that your terminal shows this code:</p>
      <p className="font-mono text-3xl tracking-widest" data-testid="cli-code">
        {code ?? '....-....'}
      </p>
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
      {error ? (
        <p role="alert" className="rounded-xl border border-ember/40 bg-ember/10 px-3 py-2">
          {error}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={state === 'busy'}
          onClick={async () => {
            setState('busy');
            setError(null);
            const err = await approve();
            if (err) {
              setError(err);
              setState('ask');
            } else setState('done');
          }}
          className="press rounded-full bg-primary px-5 py-2 font-medium text-primary-foreground disabled:opacity-60"
        >
          Approve
        </button>
        <a href="/account" className="rounded-full border border-border px-5 py-2 font-medium">
          Cancel
        </a>
      </div>
    </div>
  );
}
