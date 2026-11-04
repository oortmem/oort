import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { SiteFooter, SiteNav } from '@/components/site/SiteNav';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { docsGroups, docsMeta, docsPages } from '@/lib/docs';

/** One guide: the docs sidebar (a menu on phones), the title, a lede and the body. */
export function DocsPage({
  to,
  lede,
  children,
}: {
  to: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  const meta = docsMeta(to);
  const [open, setOpen] = useState(false);
  const index = docsPages.findIndex((p) => p.to === to);
  const prev = docsPages[index - 1];
  const next = docsPages[index + 1];
  return (
    <div className="min-h-screen">
      <SiteNav />
      <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10 md:pt-14 lg:gap-16">
        <div className="md:sticky md:top-24 md:max-h-[calc(100vh-7rem)] md:self-start md:overflow-y-auto">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="docs-nav"
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left text-sm md:hidden"
          >
            <span>
              <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Guides
              </span>
              <span className="ml-3 text-foreground">{meta.nav}</span>
            </span>
            <ChevronDown
              aria-hidden
              className={`size-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
          <nav
            id="docs-nav"
            aria-label="Guides"
            className={`${open ? 'block' : 'hidden'} mt-2 rounded-xl border border-border bg-card p-3 md:mt-0 md:block md:border-0 md:bg-transparent md:p-0`}
          >
            {docsGroups.map((group) => (
              <div key={group} className="mb-5 last:mb-0">
                <p className="mb-1.5 px-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {group}
                </p>
                <ul className="space-y-0.5">
                  {docsPages
                    .filter((p) => p.group === group)
                    .map((p) => {
                      const current = p.to === to;
                      return (
                        <li key={p.to}>
                          <Link
                            to={p.to as '/'}
                            aria-current={current ? 'page' : undefined}
                            onClick={() => setOpen(false)}
                            className={`flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                              current
                                ? 'bg-foreground/10 text-foreground'
                                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                            }`}
                          >
                            {p.nav}
                            {p.planned && <PlannedBadge />}
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <main id="content" className="min-w-0 pb-24 pt-10 md:pt-0">
          <article className="max-w-3xl">
            <p className="font-mono text-xs uppercase tracking-widest text-photon-glow">
              {meta.group}
              {meta.planned && <PlannedBadge className="ml-3" />}
            </p>
            <h1 className="mt-3 text-balance text-4xl font-semibold leading-tight md:text-5xl">
              {meta.title}
            </h1>
            <div className="mt-4 max-w-2xl text-pretty text-lg text-muted-foreground">{lede}</div>
            <div className="mt-6 leading-relaxed text-muted-foreground [&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-foreground/10 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:text-foreground [&_a:not(.plain)]:text-foreground [&_a:not(.plain)]:underline [&_a:not(.plain)]:decoration-photon-glow/60 [&_a:not(.plain)]:underline-offset-4 hover:[&_a:not(.plain)]:decoration-photon-glow [&_strong]:font-medium [&_strong]:text-foreground [&>h2]:mt-14 [&>h2]:scroll-mt-24 [&>h2]:text-2xl [&>h2]:font-semibold [&>h2]:text-foreground [&>h3]:mt-8 [&>h3]:text-lg [&>h3]:font-semibold [&>h3]:text-foreground [&>p]:mt-4 [&>ul]:mt-4 [&>ul]:list-disc [&>ul]:space-y-2 [&>ul]:pl-5">
              {children}
            </div>
          </article>

          <nav
            aria-label="More guides"
            className="mt-16 grid max-w-3xl gap-3 border-t border-border pt-8 sm:grid-cols-2"
          >
            {prev && (
              <Link
                to={prev.to as '/'}
                className="rounded-xl border border-border px-4 py-3 text-sm hover:bg-card"
              >
                <span className="block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Previous
                </span>
                {prev.nav}
              </Link>
            )}
            {next && (
              <Link
                to={next.to as '/'}
                className="rounded-xl border border-border px-4 py-3 text-sm hover:bg-card sm:col-start-2 sm:text-right"
              >
                <span className="block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Next
                </span>
                {next.nav}
              </Link>
            )}
          </nav>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}

/** A plain table for paths and settings, scrolling sideways on a phone rather than squashing. */
export function DocsTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div tabIndex={0} className="my-6 overflow-x-auto rounded-xl border border-border" role="region" aria-label={head.join(', ')}>
      <table className="w-full text-left text-sm">
        <thead className="bg-card/60">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-4 py-2.5 font-medium text-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border align-top">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2.5 text-muted-foreground">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
