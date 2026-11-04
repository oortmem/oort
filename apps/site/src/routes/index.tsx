import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Check, Copy, Lock, Zap, Snowflake, Flame } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { OortSpiral } from '@/components/oort/OortSpiral';
import { Reveal, DriftBand } from '@/components/site/Reveal';
import { WaitlistForm } from '@/components/site/WaitlistForm';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { measured, tiers } from '@/lib/oort-data';
import { homeJsonLd, jsonLdScript } from '@/lib/seo';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Oort Cloud: agent memory that stays correct as facts change' },
      {
        name: 'description',
        content:
          'Open-source memory for AI agents. It stays correct as facts change, costs stay flat as history grows, and every recall can explain itself.',
      },
      {
        property: 'og:title',
        content: 'Oort Cloud: agent memory that stays correct as facts change',
      },
      {
        property: 'og:description',
        content: 'Tiered, open-source memory for AI agents with explainable recall.',
      },
    ],
    scripts: [{ type: 'application/ld+json', children: jsonLdScript(homeJsonLd) }],
  }),
  component: Home,
});

const icons = { hot: Flame, warm: Zap, cold: Snowflake };

function Home() {
  const [copied, setCopied] = useState(false);
  const cmd = 'oort install claude-code';
  const [y, setY] = useState(0);
  useEffect(() => {
    const on = () => setY(window.scrollY);
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <div className="min-h-screen">
      <SiteNav />

      <section className="starfield relative -mt-[72px] overflow-hidden pt-[72px]">
        <div
          className="pointer-events-none absolute -left-40 top-20 size-[500px] rounded-full bg-photon/10 blur-3xl"
          style={{ transform: `translateY(${y * -0.2}px)` }}
        />
        <div
          className="absolute inset-0"
          style={{ transform: `translateY(${y * 0.2}px)`, opacity: Math.max(0, 1 - y / 900) }}
        >
          <OortSpiral />
        </div>
        <div className="pointer-events-none relative mx-auto grid min-h-[680px] max-w-7xl items-start gap-10 px-6 pt-20 pb-[320px] lg:min-h-[760px] lg:grid-cols-2 lg:items-center lg:py-28">
          <div className="pointer-events-auto space-y-8 animate-rise">
            <h1 className="text-5xl font-semibold leading-[1.02] text-balance md:text-6xl">
              Memory that stays correct as facts change.
              <br />
              <span className="bg-gradient-to-r from-photon-glow via-starlight to-ember bg-clip-text text-transparent">
                At a cost that stays flat as history grows.
              </span>
            </h1>
            <p className="max-w-md text-lg text-pretty text-muted-foreground">
              Open-source memory for AI agents. Every recall can explain why it was picked.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/docs/quickstart"
                className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground glow-photon"
              >
                Get started
              </Link>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(cmd);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                aria-label={`Copy ${cmd}`}
                className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 font-mono text-sm"
              >
                <span className="text-photon-glow">$</span> {cmd}
                {copied ? (
                  <Check className="size-4 text-photon-glow" />
                ) : (
                  <Copy className="size-4 text-muted-foreground" />
                )}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-8 text-sm text-muted-foreground">
          <p>
            Works with Claude Code, Claude Desktop, Codex, Cursor, VS Code and Gemini CLI today.
            ChatGPT and claude.ai on the web are <PlannedBadge />. The CLI is not on npm yet, so{' '}
            <Link to="/docs/quickstart" className="underline underline-offset-4">
              build it from the repo
            </Link>{' '}
            for now.
          </p>
        </div>
      </section>

      <section className="border-y border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-10">
          <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
            Measured, not promised
          </p>
          <div className="mt-6 grid grid-cols-2 gap-6 md:grid-cols-4">
            {measured.map((m, i) => (
              <Reveal key={m.label} delay={i * 100}>
                <p className="font-mono text-3xl">{m.value}</p>
                <p className="text-sm text-muted-foreground">{m.label}</p>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{m.setup}</p>
              </Reveal>
            ))}
          </div>
          <p className="mt-6 text-[11px] text-muted-foreground/80">
            Measured on a laptop with the local SQLite engine and 10,000 memories. Hosted numbers
            are not measured yet.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pt-24">
        <Reveal>
          <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
            Watch memory move between tiers <PlannedBadge kind="Demo" className="ml-2" />
          </p>
          <h2 className="mt-3 max-w-2xl text-4xl font-semibold">
            Consolidation moves memories between tiers.
          </h2>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Untouched facts drift outward and go cold. Recall one and it comes back to the hot core.
            This is an illustration, not live data.
          </p>
          <div className="mt-10">
            <DriftBand />
          </div>
        </Reveal>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-24">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">Three orbits</p>
        <h2 className="mt-3 max-w-2xl text-4xl font-semibold">
          Hot is ready, warm is searchable, cold is cheap.
        </h2>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {tiers.map((t, i) => {
            const I = icons[t.key];
            return (
              <Reveal key={t.key} delay={i * 120}>
                <div className="iris-border h-full rounded-2xl bg-card p-7 transition duration-300 hover:-translate-y-1">
                  <I className="size-5 text-photon-glow" />
                  <p className="mt-5 font-mono text-xs uppercase text-muted-foreground">
                    {t.label}
                  </p>
                  <h3 className="mt-1 text-2xl font-semibold">{t.name}</h3>
                  <p className="mt-3 text-sm text-muted-foreground">{t.pitch}</p>
                  <dl className="mt-6 space-y-1.5 font-mono text-xs">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">recall</dt>
                      <dd>{t.recall}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">space</dt>
                      <dd className="text-right">{t.space}</dd>
                    </div>
                  </dl>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="border-t border-border bg-card/40">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 py-24 md:grid-cols-2">
          <div>
            <Lock className="size-6 text-photon-glow" />
            <h2 className="mt-4 text-4xl font-semibold">
              Privacy you can check today, more on the way.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Built for personal and customer-facing agents. Today, secrets are scrubbed before they
              are saved and any single memory can be forgotten. Stronger controls are planned and
              labelled below.
            </p>
          </div>
          <ul className="space-y-3 font-mono text-sm">
            {(
              [
                ['Secrets scrubbed before they are saved', false],
                ['Forget any memory with oort forget', false],
                ["Each customer's memories encrypted separately", true],
                ['Bring your own keys: AWS, Google Cloud or Azure', true],
                ['Erase everything a person left, cryptographically', true],
                ['SOC 2 audit', true],
              ] as const
            ).map(([x, planned]) => (
              <li
                key={x}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <Check className="size-4 shrink-0 text-photon-glow" />
                <span className="flex-1">{x}</span>
                {planned && <PlannedBadge />}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
            Shared memory <PlannedBadge className="ml-2" />
          </p>
          <h2 className="mt-3 max-w-2xl text-4xl font-semibold">
            From one Star to a whole Galaxy.
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Tiers say how warm a memory is. These names say whose it is. Memory sharing between
            agents is planned and not built yet.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-5">
            {(
              [
                ['Star', "One agent's own memory."],
                ['Constellation', 'A team of agents sharing memory.'],
                ['Galaxy', "The organisation's shared memory."],
                ['Planet', "An end user's own memory. It belongs to that person."],
                [
                  'Uplink',
                  "A Star's finding joins its Constellation, with a record of where it came from. A person's private facts never uplink without permission.",
                ],
              ] as const
            ).map(([t, d]) => (
              <div key={t} className="rounded-2xl border border-border bg-card p-6">
                <h3 className="font-semibold">{t}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">Roadmap</p>
          <h2 className="mt-3 max-w-2xl text-4xl font-semibold">What is not built yet.</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {(
              [
                ['Python SDK', 'Planned', 'The engine and CLI are TypeScript today.'],
                ['Desktop app', 'Planned', 'An app to explore and edit what your agent remembers.'],
                [
                  'Hosted Oort Cloud',
                  'Planned',
                  'Memory hosted for you, for products with many users.',
                ],
              ] as const
            ).map(([t, k, d]) => (
              <div key={t} className="rounded-2xl border border-border bg-card p-6">
                <PlannedBadge kind={k} />
                <h3 className="mt-3 font-semibold">{t}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl overflow-hidden px-6 py-24 text-center">
        <div className="pointer-events-none absolute left-1/2 top-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 animate-orbit-slow rounded-full border border-dashed border-border" />
        <h2 className="text-4xl font-semibold">Running millions of customers?</h2>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Picture a retailer with 50M members and a personal shopping agent for each. Here is how
          that could run on Oort. It is a hypothetical scenario, not a customer.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            to="/enterprise"
            className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground"
          >
            See the scenario
          </Link>
          <Link to="/pricing" className="rounded-full border border-border px-6 py-3 text-sm">
            See pricing
          </Link>
          <Link to="/dashboard" className="rounded-full border border-border px-6 py-3 text-sm">
            See the console demo
          </Link>
        </div>
      </section>

      <section id="early-access" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <WaitlistForm source="home" />
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
