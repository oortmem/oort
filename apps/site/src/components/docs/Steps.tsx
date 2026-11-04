import { Children, type ReactNode } from 'react';
import { PlannedBadge } from '@/components/site/PlannedBadge';

/** Numbered steps. Each child is one <Step>: one action, shown first, then explained. */
export function Steps({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <ol className="not-prose my-6 space-y-6">
      {items.map((child, i) => (
        <li key={i} className="relative pl-11">
          <span
            aria-hidden
            className="absolute left-0 top-0 flex size-7 items-center justify-center rounded-full border border-photon-glow/50 bg-photon/10 font-mono text-xs text-photon-glow"
          >
            {i + 1}
          </span>
          {child}
        </li>
      ))}
    </ol>
  );
}

export function Step({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <p className="pt-0.5 font-medium text-foreground">{title}</p>
      {children && <div className="mt-2 space-y-3 text-muted-foreground">{children}</div>}
    </div>
  );
}

type NoteKind = 'note' | 'warning' | 'planned';

const noteStyle: Record<NoteKind, string> = {
  note: 'border-border bg-card/60',
  warning: 'border-ember/50 bg-ember/10',
  planned: 'border-ember/50 bg-ember/5',
};

/** A short aside. `warning` is for the one thing that can cost money or leak data. */
export function Note({
  kind = 'note',
  title,
  children,
}: {
  kind?: NoteKind;
  title: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={title}
      className={`not-prose my-6 rounded-xl border px-4 py-3 text-sm leading-relaxed ${noteStyle[kind]}`}
    >
      <p className="font-medium text-foreground">
        {kind === 'planned' && <PlannedBadge className="mr-2" />}
        {title}
      </p>
      <div className="mt-1 space-y-2 text-muted-foreground">{children}</div>
    </aside>
  );
}
