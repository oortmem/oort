import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { PlannedBadge } from '@/components/site/PlannedBadge';

type Source = 'home' | 'pricing';

/** Decorative orbit rings with a photon travelling round. CSS only; still under reduced motion. */
function Orbits() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -right-40 top-1/2 size-[560px] -translate-y-1/2 opacity-70 sm:-right-24"
    >
      <div className="absolute inset-0 rounded-full border border-dashed border-photon-glow/25" />
      <div className="absolute inset-[70px] rounded-full border border-photon-glow/15" />
      <div className="absolute inset-[150px] rounded-full border border-dashed border-ember/20" />
      <div className="absolute inset-0 animate-orbit-slow">
        <span className="absolute left-1/2 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-photon-glow shadow-[0_0_16px_var(--photon-glow)]" />
      </div>
      <div className="absolute inset-[150px] hidden animate-orbit sm:block">
        <span className="absolute bottom-0 left-1/2 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-ember" />
      </div>
      <div className="absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 animate-breathe rounded-full bg-photon/30 blur-xl" />
    </div>
  );
}

/**
 * Early access to hosted Oort Cloud. Posts { email, consent, website, source } to /api/waitlist,
 * which stores only the email, the date and the page.
 */
export function WaitlistForm({ source, id }: { source: Source; id?: string }) {
  const uid = useId();
  const headingId = `${uid}-heading`;
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

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="iris-border relative overflow-hidden rounded-3xl bg-card/70"
    >
      <div aria-hidden="true" className="starfield absolute inset-0 opacity-70" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-32 -top-40 size-96 rounded-full bg-photon/15 blur-3xl"
      />
      <Orbits />

      <div className="relative grid grid-cols-1 items-center gap-10 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-[1.05fr_1fr] lg:px-14">
        <div>
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-photon-glow">
            Hosted Oort Cloud <PlannedBadge />
          </p>
          <h2 id={headingId} className="mt-3 text-3xl font-semibold text-balance md:text-4xl">
            Memory hosted for you. Be first in.
          </h2>
          <p className="mt-3 max-w-md text-pretty text-muted-foreground">
            For products with many users. Leave your email and we will write when it opens.
          </p>
        </div>

        <div className="min-w-0 lg:max-w-md">
          {state === 'done' ? (
            <div role="status" className="glass flex items-start gap-3 rounded-2xl p-5 text-sm">
              <Check className="mt-0.5 size-4 shrink-0 text-photon-glow" aria-hidden="true" />
              <p>Thanks. If this address is new, we will email you when Oort Cloud opens.</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="glass flex items-center gap-1.5 rounded-full p-1.5 focus-within:border-ring">
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
                  className="w-0 min-w-0 flex-1 bg-transparent px-4 py-2 text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  disabled={state === 'sending'}
                  className="press flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground glow-photon disabled:opacity-60"
                >
                  {state === 'sending' ? 'Sending' : 'Join'}
                  <ArrowRight className="size-4" aria-hidden="true" />
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
              <label className="flex items-start gap-3 px-1 text-xs leading-relaxed text-muted-foreground">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--photon)]"
                />
                <span>
                  I agree to be emailed when Oort Cloud opens. We store only your email, the date
                  and this page, and nothing is sold. Details in the{' '}
                  <Link to="/legal/privacy" className="underline underline-offset-4">
                    privacy notice
                  </Link>
                  .
                </span>
              </label>
              {state === 'error' && (
                <p role="alert" className="px-1 text-xs text-destructive">
                  {message}
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
