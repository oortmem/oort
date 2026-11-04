import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Github } from 'lucide-react';

export const Route = createFileRoute('/signin')({
  head: () => ({
    meta: [
      { title: 'Sign in — Oort Cloud console' },
      {
        name: 'description',
        content: 'Sign in to the Oort Cloud console to manage agent memory, keys and usage.',
      },
      { property: 'og:title', content: 'Sign in to Oort Cloud' },
      { property: 'og:description', content: 'Access your Oort Cloud memory console.' },
    ],
  }),
  component: SignIn,
});

function SignIn() {
  const nav = useNavigate();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const go = (e?: React.FormEvent) => {
    e?.preventDefault();
    nav({ to: '/dashboard' });
  };
  return (
    <div className="starfield grid min-h-screen place-items-center px-4">
      <div className="iris-border w-full max-w-sm rounded-3xl bg-card p-8">
        <div className="mx-auto mb-6 size-16 animate-breathe rounded-full bg-[radial-gradient(circle_at_35%_35%,var(--photon-glow),var(--photon)_60%,transparent_75%)] glow-photon" />
        <h1 className="text-center text-2xl font-semibold">
          {mode === 'in' ? 'Welcome back' : 'Create your cloud'}
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">Oort Cloud console</p>
        <button
          onClick={() => go()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-full border border-border py-2.5 text-sm hover:bg-secondary"
        >
          <Github className="size-4" /> Continue with GitHub
        </button>
        <button
          onClick={() => go()}
          className="mt-2 w-full rounded-full border border-border py-2.5 text-sm hover:bg-secondary"
        >
          Continue with Google
        </button>
        <button
          onClick={() => go()}
          className="mt-2 w-full rounded-full border border-border py-2.5 text-sm hover:bg-secondary"
        >
          Enterprise SSO
        </button>
        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
        <form onSubmit={go} className="space-y-3">
          <input
            type="email"
            required
            placeholder="you@company.com"
            className="w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-ring"
          />
          <input
            type="password"
            required
            placeholder="Password"
            className="w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-ring"
          />
          <button className="w-full rounded-full bg-primary py-2.5 text-sm font-semibold text-primary-foreground">
            {mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="mt-5 text-center text-sm text-muted-foreground">
          {mode === 'in' ? 'New to Oort?' : 'Have an account?'}{' '}
          <button
            onClick={() => setMode(mode === 'in' ? 'up' : 'in')}
            className="text-foreground underline"
          >
            {mode === 'in' ? 'Create one' : 'Sign in'}
          </button>
        </p>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          <Link to="/">← back to site</Link>
        </p>
      </div>
    </div>
  );
}
