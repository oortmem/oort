import { createFileRoute } from '@tanstack/react-router';
import { SiteNav, SiteFooter } from '@/components/site/SiteNav';
import { PhoneExplorer } from '@/components/oort/PhoneExplorer';

export const Route = createFileRoute('/explorer')({
  head: () => ({
    meta: [
      { title: 'Oort Explorer — Mobile & desktop memory companion' },
      {
        name: 'description',
        content:
          'Interactive demo of the Oort Explorer app: Discover dives, My Space star map and constellation timelines.',
      },
      { property: 'og:title', content: 'Oort Explorer — your memory as a sky' },
      {
        property: 'og:description',
        content: 'Try the Discover, My Space and Me views of the Oort companion app.',
      },
    ],
  }),
  component: ExplorerPage,
});

function ExplorerPage() {
  return (
    <div className="min-h-screen">
      <SiteNav />
      <section className="starfield mx-auto max-w-7xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
          Companion app · iOS · Android · macOS
        </p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold">
          Three ways to see what your agent remembers.
        </h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Every phone below is live — tap Dive, switch tabs, and explore.
        </p>
        <div className="mt-16 grid gap-12 lg:grid-cols-3">
          {(
            [
              [
                'discover',
                'Discover',
                'Type an intention and dive. The orbit pulls matching memories from every tier.',
              ],
              [
                'space',
                'My Space',
                'Memories cluster into constellations by topic. Dim stars are frozen in the Oort Cloud.',
              ],
              ['me', 'Me', 'Your footprint, tier breakdown, and one-tap cryptographic erasure.'],
            ] as const
          ).map(([v, t, d]) => (
            <div key={v} className="space-y-6">
              <PhoneExplorer initial={v} />
              <div className="text-center">
                <h2 className="text-xl font-semibold">{t}</h2>
                <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
