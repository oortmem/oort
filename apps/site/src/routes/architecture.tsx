import { createFileRoute } from '@tanstack/react-router';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { tiers } from '@/lib/oort-data';

export const Route = createFileRoute('/architecture')({
  head: () => ({
    meta: [
      { title: 'Architecture | How Oort Cloud remembers' },
      {
        name: 'description',
        content:
          'Three memory tiers, keyword and vector recall fused with reciprocal rank fusion, Voyage rerank, and facts that close when they change.',
      },
      { property: 'og:title', content: 'Oort Cloud architecture' },
      {
        property: 'og:description',
        content: 'Photosphere, Kuiper Belt and Oort Cloud tiers, and how outdated facts stay out.',
      },
    ],
  }),
  component: Arch,
});

const readSteps = [
  'Keyword recall (SQLite FTS5, BM25) and vector recall run side by side',
  'Both lists are fused with reciprocal rank fusion',
  'Voyage rerank scores the top 30',
  'Freshness (ACT-R activation) nudges the order by at most 5%. It never brings back an outdated fact',
  'The top 10 go into the prompt',
];
const writeSteps = [
  'The turn is queued, so the chat never waits',
  'A gate decides what is worth remembering',
  'Facts are extracted and embedded as 512-dim int8 vectors (Voyage voyage-3.5-lite)',
  'A fact that changes is closed with a validTo date and linked to the fact that replaced it',
  'Consolidation moves memories between tiers. Cold keeps text, a stub and entities, drops the vector and compresses the rest with zstd',
];

function Arch() {
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="mx-auto max-w-7xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">Architecture</p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold">A solar system for memory.</h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Most memory systems keep every vector hot forever and answer with whatever looks similar,
          even when the fact has changed. Oort closes facts that change and moves memories between
          three tiers, so answers stay correct and the cost stays flat as history grows.
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
                  <td className="p-4 font-mono text-xs">
                    <span className="block">{t.latency}</span>
                    <span className="mt-1 block text-muted-foreground">
                      <PlannedBadge kind="Target" className="mr-1" />
                      {t.latencyTarget.replace('Target: ', '')} in the cloud
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Measured on a laptop with the local SQLite engine and 10,000 memories. Vector recall used
          a stand-in embedder, so it leaves out the embedding API round trip. Cloud numbers are
          targets, not measurements.
        </p>

        <div className="mt-16 grid gap-6 md:grid-cols-3">
          {[
            [
              'Facts that change',
              'When a fact changes, the old one is closed with a validTo date and linked to the fact that replaced it. Outdated answers do not leak into recall.',
            ],
            [
              'Freshness nudges, never decides',
              'Recently used memories get a small boost from ACT-R activation, at most 5% of the ranking. A boost never re-admits a closed fact.',
            ],
            [
              'Recall explains itself',
              'oort explain <id> shows why a memory was returned, so you can check it and forget it if it is wrong.',
            ],
          ].map(([t, d]) => (
            <div key={t} className="rounded-2xl border border-border bg-card p-6">
              <h3 className="font-semibold">{t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>

        <p className="mt-6 text-sm text-muted-foreground">
          Tiers say how warm a memory is. Planned spaces (Star, Constellation, Galaxy, Planet) say
          whose it is. <PlannedBadge />
        </p>

        <div className="mt-16 grid gap-6 md:grid-cols-2">
          {[
            ['UserPromptSubmit · read hook', 'Runs before the prompt is sent', readSteps],
            ['Stop · write hook', 'Queued and async, never blocks the chat', writeSteps],
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
          {`# install the hooks for Claude Code
oort install claude-code

# search memory
oort recall "what shoes should I suggest?"

# see why a memory was returned
oort explain <id>

# forget one memory
oort forget <id>

# look around
oort inspect`}
        </pre>
        <p className="mt-3 text-xs text-muted-foreground">
          The CLI is not on npm yet. Publishing is coming. An SDK for code is <PlannedBadge />, and
          so is binary quantization of vectors.
        </p>
      </section>
      <SiteFooter />
    </div>
  );
}
