import { useState } from 'react';

type Wish = { id: number; text: string; ring: number; angle: number };
const RINGS = [70, 115, 160];
const COLORS = ['var(--hot)', 'var(--warm)', 'var(--cold)'];
const SEED: Wish[] = [
  { id: 1, text: 'Prefers window seats', ring: 0, angle: 30 },
  { id: 2, text: 'Vegetarian since 2021', ring: 1, angle: 160 },
  { id: 3, text: 'Asked about Lisbon once', ring: 2, angle: 260 },
];

export function WishOrbit() {
  const [wishes, setWishes] = useState<Wish[]>(SEED);
  const [text, setText] = useState('');
  const [landed, setLanded] = useState<number | null>(null);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const id = Date.now();
    // New memories land in the hot core; older ones cool outward.
    setWishes((w) =>
      [
        { id, text: t, ring: 0, angle: Math.random() * 360 },
        ...w.map((x) => ({ ...x, ring: Math.min(2, x.ring + 1) })),
      ].slice(0, 9),
    );
    setLanded(id);
    setText('');
    navigator.vibrate?.(8);
  };

  return (
    <div className="grid items-center gap-10 lg:grid-cols-2">
      <div>
        <form
          onSubmit={send}
          className="flex gap-2 rounded-full border border-border bg-card/60 p-1.5 backdrop-blur"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={60}
            placeholder="Type something to remember…"
            aria-label="Your wish"
            className="flex-1 bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button className="press rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background">
            Dive
          </button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          Fresh thoughts land in Photosphere. Each new one nudges the rest outward into Kuiper, then
          Oort.
        </p>
        <ul className="mt-6 space-y-2 text-sm">
          {wishes.slice(0, 4).map((w) => (
            <li key={w.id} className="flex items-center gap-2 text-muted-foreground">
              <span className="size-1.5 rounded-full" style={{ background: COLORS[w.ring] }} />
              <span className={w.id === landed ? 'text-foreground' : ''}>{w.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="relative mx-auto aspect-square w-full max-w-sm">
        <svg viewBox="-180 -180 360 360" className="absolute inset-0 size-full">
          {RINGS.map((r, i) => (
            <circle
              key={r}
              r={r}
              fill="none"
              stroke={COLORS[i]}
              strokeOpacity={0.25}
              strokeDasharray="2 6"
            />
          ))}
          <circle
            r={18}
            fill="var(--photon)"
            style={{ filter: 'drop-shadow(0 0 16px var(--photon))' }}
          />
        </svg>
        {wishes.map((w) => {
          const rad = (w.angle * Math.PI) / 180;
          const pct = ((RINGS[w.ring] ?? 70) / 360) * 100;
          return (
            <div
              key={w.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-1000 ease-out"
              style={{ left: `${50 + Math.cos(rad) * pct}%`, top: `${50 + Math.sin(rad) * pct}%` }}
            >
              <span
                className={`block size-2.5 rounded-full ${w.id === landed ? 'animate-rise' : ''}`}
                style={{ background: COLORS[w.ring], boxShadow: `0 0 10px ${COLORS[w.ring]}` }}
                title={w.text}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
