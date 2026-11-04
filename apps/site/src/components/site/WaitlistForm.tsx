import { Link } from '@tanstack/react-router';
import { useState } from 'react';

type Source = 'home' | 'pricing';

/** Early-access signup. Posts to /api/waitlist. Stores email, time and page only. */
export function WaitlistForm({ source, id }: { source: Source; id?: string }) {
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, consent, website, source }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setState('done');
      } else {
        setState('error');
        setMessage(data.error ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setState('error');
      setMessage('Could not reach the server. Please try again.');
    }
  };

  if (state === 'done') {
    return (
      <p id={id} role="status" className="rounded-2xl border border-border bg-card p-5 text-sm">
        Thanks. If this address is new, we will email you when Oort Cloud opens.
      </p>
    );
  }

  return (
    <form
      id={id}
      onSubmit={submit}
      className="max-w-md space-y-3 rounded-2xl border border-border bg-card p-5"
    >
      <p className="font-medium">Get early access to hosted Oort Cloud</p>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`wl-email-${source}`}>
          Email
        </label>
        <input
          id={`wl-email-${source}`}
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-0 flex-1 rounded-full border border-input bg-background px-4 py-2 text-sm outline-none focus:border-ring"
        />
        <button
          disabled={state === 'sending'}
          className="press rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {state === 'sending' ? 'Sending' : 'Join'}
        </button>
      </div>
      {/* Honeypot: hidden from people and assistive tech. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          required
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I agree to be emailed when Oort Cloud opens. We store only your email, the date and this
          page, and nothing is sold. Details in the{' '}
          <Link to="/legal/privacy" className="underline underline-offset-4">
            privacy notice
          </Link>
          .
        </span>
      </label>
      {state === 'error' && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
    </form>
  );
}
