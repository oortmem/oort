import type { ReactNode } from 'react';
import { SiteFooter, SiteNav } from '@/components/site/SiteNav';
import { legal } from '@/lib/legal';

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <SiteNav />
      <article className="mx-auto max-w-3xl px-6 py-20">
        <p
          role="note"
          className="mb-8 rounded-xl border border-ember/40 bg-ember/10 px-4 py-3 text-sm text-ember"
        >
          Draft, under legal review. This text may change before it takes effect.
        </p>
        <h1 className="text-4xl font-semibold">{title}</h1>
        <p className="mt-2 font-mono text-xs text-muted-foreground">Draft of {legal.updated}</p>
        <div className="mt-8 space-y-4 text-sm leading-relaxed text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground">
          {children}
        </div>
      </article>
      <SiteFooter />
    </div>
  );
}

export function Contact() {
  return <strong>{legal.contactEmail}</strong>;
}

export function GeneralContact() {
  return <strong>{legal.generalEmail}</strong>;
}

/** Shown only once a VAT number is set. */
export function VatLine() {
  return legal.vatNumber ? <p>VAT number: {legal.vatNumber}</p> : null;
}
