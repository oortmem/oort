import { createFileRoute } from '@tanstack/react-router';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { tiers } from '@/lib/oort-data';

export const Route = createFileRoute('/architecture')({
  head: () => ({
    meta: [
      { title: 'Architecture — How Oort Cloud remembers' },
      {
        name: 'description',
        content:
          'Three memory tiers, hybrid BM25 + dense retrieval, cross-encoder rerank and lifecycle hooks that never block a chat turn.',
      },
      { property: 'og:title', content: 'Oort Cloud architecture' },
      {
        property: 'og:description',
        content: 'Photosphere, Kuiper Belt and Oort Cloud tiers with comet hydration.',
      },
    ],
  }),
  component: Arch,
});

const readSteps = [
  'Routing gate: does this turn need memory?',
  'Parallel BM25 + quantized dense recall (top 50)',
  'Hydrate matched Oort stubs (zstd, < 3 ms)',
  'Cross-encoder rerank to top 8',
  'Inject into prompt · bump activation',
];
const writeSteps = [
  'Salience gate drops ~75% filler',
  'Extract fact + 35-token elision stub',
  'Embed (Matryoshka 512d) · encrypt with customer key',
  'Write to hot tier, consolidate to warm',
  'Nightly decay demotes cold memories to Oort',
];

function Arch() {
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="mx-auto max-w-7xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">Architecture</p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold">A solar system for memory.</h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Most memory systems keep every vector in hot RAM forever. Oort tracks how often and how
          recently each memory is used, then moves it between three orbits automatically.
        </p>

        <div className="mt-14 overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-card font-mono text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-4">Tier</th>
                <th className="p-4">Precision</th>
                <th className="p-4">Storage</th>
                <th className="p-4">Latency</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.key} className="border-t border-border">
                  <td className="p-4">
                    <span className="font-semibold">{t.name}</span>
                    <br />
                    <span className="text-xs text-muted-foreground">{t.label}</span>
                  </td>
                  <td className="p-4 font-mono text-xs">{t.precision}</td>
                  <td className="p-4 text-muted-foreground">{t.store}</td>
                  <td className="p-4 font-mono">{t.latency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-2">
          {[
            ['preMessageSend · read hook', '< 80 ms, synchronous', readSteps],
            ['postMessageSend · write hook', '0 ms UI block, async', writeSteps],
          ].map(([t, s, steps]) => (
            <div key={t as string} className="iris-border rounded-2xl bg-card p-7">
              <p className="font-mono text-sm text-photon-glow">{t as string}</p>
              <p className="text-xs text-muted-foreground">{s as string}</p>
              <ol className="mt-6 space-y-3">
                {(steps as string[]).map((x, i) => (
                  <li key={x} className="flex gap-3 text-sm">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border font-mono text-[11px]">
                      {i + 1}
                    </span>
                    {x}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <pre className="mt-16 overflow-x-auto rounded-2xl border border-border bg-void p-6 font-mono text-sm leading-relaxed text-muted-foreground">
          {`import { Oort } from "@oortmem/core";

const memory = new Oort({ tenant: "acme", customer: user.id, kms: "aws:kms/acme" });

await memory.remember("Prefers trail shoes, size 44, wide fit");
const ctx = await memory.recall("what shoes should I suggest?", { k: 8, rerank: true });
await memory.forget({ customer: user.id }); // crypto-erase every tier`}
        </pre>
      </section>
      <SiteFooter />
    </div>
  );
}
