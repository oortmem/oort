import { useEffect, useRef, type ReactNode } from 'react';

/** Fades content up when it scrolls into view. */
export function Reveal({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          el.classList.add('is-visible');
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

const drifting = [
  'Prefers dark mode',
  'Size 10 running shoes',
  'Asked about returns',
  'Loves trail running',
  'Birthday in May',
  'Bought Pegasus 41',
  'Vegan',
  'Lives in Berlin',
  'Wants waterproof gear',
];

/** Signature visual: memories cooling from hot to frozen as time passes. */
export function DriftBand() {
  return (
    <div className="relative h-56 overflow-hidden rounded-3xl border border-border bg-void">
      <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-hot/20 to-transparent" />
      <div className="absolute inset-y-0 right-0 w-1/3 bg-gradient-to-l from-cold/20 to-transparent" />
      <div className="absolute inset-x-6 top-4 flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span>Photosphere · hot</span>
        <span>Kuiper · warm</span>
        <span>Oort · frozen</span>
      </div>
      {drifting.map((t, i) => (
        <div
          key={t}
          className="animate-travel absolute -translate-x-1/2"
          style={{
            top: `${22 + (i % 5) * 15}%`,
            animationDelay: `${-i * 1.1}s`,
            animationDuration: `${8 + (i % 3) * 2}s`,
          }}
        >
          <span className="flex items-center gap-2 whitespace-nowrap rounded-full border border-border bg-card/80 px-3 py-1 text-xs backdrop-blur">
            <span className="size-1.5 rounded-full bg-photon-glow animate-twinkle" />
            {t}
          </span>
        </div>
      ))}
    </div>
  );
}
