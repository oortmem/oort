type Kind = 'Planned' | 'Concept' | 'Demo' | 'Target';

const hints: Record<Kind, string> = {
  Planned: 'Not built yet',
  Concept: 'A design concept, not a product yet',
  Demo: 'Illustration with sample data',
  Target: 'A goal, not a measurement',
};

/** Small honesty label for anything that is not built, measured or real today. */
export function PlannedBadge({
  kind = 'Planned',
  className = '',
}: {
  kind?: Kind;
  className?: string;
}) {
  return (
    <span
      title={hints[kind]}
      className={`inline-block rounded-full border border-ember/50 bg-ember/10 px-2 py-0.5 align-middle font-mono text-[10px] uppercase tracking-wider text-ember ${className}`}
    >
      {kind}
    </span>
  );
}
