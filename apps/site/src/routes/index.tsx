import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Lock, Zap, Snowflake, Flame } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { OortSpiral, type SpiralApi, type Tier } from '@/components/oort/OortSpiral';
import { HeroWish } from '@/components/site/HeroWish';
import { PhoneExplorer } from '@/components/oort/PhoneExplorer';
import { Reveal, DriftBand } from '@/components/site/Reveal';
import { tiers } from '@/lib/oort-data';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Oort Cloud — Infinite agent memory, zero RAM bloat' },
      {
        name: 'description',
        content:
          'Open-source memory for AI agents. What matters stays close, what grows old tucks away — and nothing ever gets lost.',
      },
      { property: 'og:title', content: 'Oort Cloud — Infinite agent memory, zero RAM bloat' },
      {
        property: 'og:description',
        content: 'Tiered, encrypted, open-source memory for AI agents.',
      },
    ],
  }),
  component: Home,
});

const icons = { hot: Flame, warm: Zap, cold: Snowflake };

function Home() {
  const [copied, setCopied] = useState(false);
  const cmd = 'npx @oortmem/cli init';
  const [y, setY] = useState(0);
  const api = useRef<SpiralApi | null>(null);
  const [stats, setStats] = useState({ recalls: 0, hot: 0, last: [] as number[] });
  const onRecall = (tier: Tier, ms: number, source: 'click' | 'auto') => {
    setStats((s) => ({
      recalls: s.recalls + 1,
      hot: s.hot + (tier === 'photo' ? 1 : 0),
      last: [...s.last, ms].slice(-20),
    }));
  };
  const sorted = [...stats.last].sort((a, b) => a - b);
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    : null;
  const [word, setWord] = useState(0);
  const words = ['shopping agents', 'support copilots', 'tutors', 'companions'];
  useEffect(() => {
    const on = () => setY(window.scrollY);
    window.addEventListener('scroll', on, { passive: true });
    const t = setInterval(() => setWord((w) => (w + 1) % 4), 2400);
    return () => {
      window.removeEventListener('scroll', on);
      clearInterval(t);
    };
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
          <OortSpiral apiRef={api} onRecall={onRecall} />
        </div>
        <div className="pointer-events-none relative mx-auto grid min-h-[760px] max-w-7xl items-start gap-10 px-6 pt-20 pb-[340px] lg:min-h-[820px] lg:pb-28 lg:grid-cols-2 lg:items-center lg:py-28">
          <div className="pointer-events-auto space-y-8 animate-rise">
            <span className="inline-block rounded-full border border-border px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Open-source agent memory
            </span>
            <h1 className="text-5xl font-semibold leading-[1.02] md:text-7xl">
              Infinite agent memory.
              <br />
              <span className="bg-gradient-to-r from-photon-glow via-starlight to-ember bg-clip-text text-transparent">
                Zero RAM bloat.
              </span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground">
              Memory for{' '}
              <span key={word} className="inline-block animate-rise text-foreground">
                {words[word]}
              </span>
            </p>
            <p className="max-w-lg text-lg text-muted-foreground">
              What you use stays close. What you forget drifts out to the cold cloud — and comes
              back in milliseconds. Try it: add a memory, or tap any star to recall it.
            </p>
            <HeroWish api={api} />
            <dl className="flex gap-6 font-mono text-xs text-muted-foreground" aria-live="polite">
              <div>
                <dt>recalls</dt>
                <dd className="text-base text-foreground">{stats.recalls}</dd>
              </div>
              <div>
                <dt>p95</dt>
                <dd className="text-base text-foreground">{p95 ? `${p95} ms` : '—'}</dd>
              </div>
              <div>
                <dt>RAM saved</dt>
                <dd className="text-base text-photon-glow">86%</dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/dashboard"
                className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground glow-photon"
              >
                Dive into the console
              </Link>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(cmd);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
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
            <Link
              to="/explorer"
              className="inline-block text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Try the Explorer companion app →
            </Link>
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-card/40">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-6 py-10 md:grid-cols-4">
          {[
            ['< 100 ms', 'recall that feels instant'],
            ['83–96%', 'lighter on memory'],
            ['> 92%', 'old memories still found'],
            ['6–8×', 'smaller long-term storage'],
          ].map(([v, l], i) => (
            <Reveal key={l} delay={i * 100}>
              <p className="font-mono text-3xl">{v}</p>
              <p className="text-sm text-muted-foreground">{l}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pt-24">
        <Reveal>
          <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
            Watch it forget, gracefully
          </p>
          <h2 className="mt-3 max-w-2xl text-4xl font-semibold">
            Every memory cools on its own schedule.
          </h2>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Untouched facts drift outward and freeze. Recall one and it snaps straight back to the
            hot core.
          </p>
          <div className="mt-10">
            <DriftBand />
          </div>
        </Reveal>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-24">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">Three orbits</p>
        <h2 className="mt-3 max-w-2xl text-4xl font-semibold">
          Memory that heats up when used and freezes when forgotten.
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

      <section className="border-t border-border">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-2">
          <Reveal className="space-y-5">
            <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
              Oort Explorer
            </p>
            <h2 className="text-4xl font-semibold">See your memory as a sky.</h2>
            <p className="text-muted-foreground">
              Ask in plain words and dive. Memories form constellations by topic, timelines trace
              how ideas evolved, and anything you no longer want can be erased cryptographically in
              one tap.
            </p>
            <Link
              to="/explorer"
              className="inline-block rounded-full border border-border px-5 py-2.5 text-sm hover:bg-secondary"
            >
              Open the interactive demo
            </Link>
          </Reveal>
          <Reveal delay={150}>
            <PhoneExplorer initial="space" />
          </Reveal>
        </div>
      </section>

      <section className="border-t border-border bg-card/40">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 py-24 md:grid-cols-2">
          <div>
            <Lock className="size-6 text-photon-glow" />
            <h2 className="mt-4 text-4xl font-semibold">Every customer gets their own key.</h2>
            <p className="mt-4 text-muted-foreground">
              Built for customer-facing agents. Every person's memories are encrypted on their own
              key, personal details stay hidden even from us, and one tap erases a person's hot,
              warm and frozen memories for good.
            </p>
          </div>
          <ul className="space-y-3 font-mono text-sm">
            {[
              "Each customer's memories encrypted separately",
              'Bring your own keys — AWS, Google Cloud or Azure',
              'Sensitive details filtered without being readable',
              'Nothing left behind after erasure',
              'Full erasure in one tap',
            ].map((x) => (
              <li
                key={x}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <Check className="size-4 text-photon-glow" /> {x}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl overflow-hidden px-6 py-24 text-center">
        <div className="pointer-events-none absolute left-1/2 top-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 animate-orbit-slow rounded-full border border-dashed border-border" />
        <h2 className="text-4xl font-semibold">Running millions of customers?</h2>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          See how a global retailer runs personal shopping agents for 50M members on Oort.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            to="/enterprise"
            className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground"
          >
            Enterprise architecture
          </Link>
          <Link to="/pricing" className="rounded-full border border-border px-6 py-3 text-sm">
            See pricing
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
