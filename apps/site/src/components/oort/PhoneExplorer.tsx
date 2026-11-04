import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Search, Star, ChevronLeft, ChevronRight, PictureInPicture2 } from 'lucide-react';

type View = 'discover' | 'space' | 'me';

type Prefs = {
  haptics: boolean;
  reduced: boolean;
  set: (p: Partial<{ haptics: boolean; reduced: boolean }>) => void;
};
const PrefsCtx = createContext<Prefs>({ haptics: true, reduced: false, set: () => {} });
/** Haptic-style tap: short vibration where supported. */
function useTap() {
  const { haptics } = useContext(PrefsCtx);
  return (ms = 8) => {
    if (haptics && typeof navigator !== 'undefined') navigator.vibrate?.(ms);
  };
}

/* deterministic star dust */
function rand(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const r = rand(7);
const STARS = Array.from({ length: 90 }, () => ({
  x: r() * 100,
  y: r() * 100,
  s: r() < 0.85 ? 1 : 2,
  o: 0.25 + r() * 0.6,
}));

const wishes = [
  {
    q: 'I want to change the world, I believe that AI has the potential to make the world a better place, and I want to be a part of that.',
    x: 34,
  },
  { q: 'I want to design houses', x: 22 },
  { q: 'I want to learn more about design', x: 10 },
  { q: 'I want to be an artist', x: 26 },
  { q: 'I want to be a fashion designer', x: 8 },
];

const clusters = [
  { name: 'Design', x: 50, y: 25, dots: 7, label: 'right' as const },
  { name: 'Health', x: 6, y: 41, dots: 5, label: 'right' as const },
  { name: 'Business', x: 46, y: 57, dots: 8, label: 'right' as const },
  { name: 'Travel', x: 6, y: 76, dots: 6, label: 'right' as const },
];

const glow = (c: string, size = 14) => ({
  boxShadow: `0 0 ${size}px ${size / 3}px color-mix(in oklab, ${c} 70%, transparent)`,
});

function Orb({ size = 22 }: { size?: number }) {
  return (
    <div
      className="relative grid place-items-center"
      style={{ width: size * 1.9, height: size * 1.9 }}
    >
      <div className="absolute inset-0 rounded-full border border-photon/30 bg-photon/5" />
      <div
        className="rounded-full"
        style={{
          width: size,
          height: size,
          background:
            'radial-gradient(circle at 35% 30%, var(--starlight) 0%, var(--photon-glow) 22%, var(--photon) 60%, color-mix(in oklab, var(--photon) 50%, var(--void)) 100%)',
          ...glow('var(--photon)', 12),
        }}
      />
    </div>
  );
}

function StatusBar({ title }: { title?: string | undefined }) {
  return (
    <div className="relative z-10 flex items-center justify-between px-7 pt-3 text-[11px] font-semibold text-foreground">
      <span>9:41</span>
      <div className="absolute left-1/2 top-2 h-[26px] w-[96px] -translate-x-1/2 rounded-full bg-void" />
      <div className="flex items-center gap-1.5">
        <span className="flex items-end gap-[2px]">
          {[4, 6, 8, 10].map((h) => (
            <span key={h} className="w-[3px] rounded-sm bg-foreground" style={{ height: h }} />
          ))}
        </span>
        <svg viewBox="0 0 16 12" className="h-2.5 w-3.5 fill-foreground">
          <path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0zM3.5 6.9a6.4 6.4 0 0 1 9 0l-1.4 1.4a4.4 4.4 0 0 0-6.2 0zM1.3 4.7a9.5 9.5 0 0 1 13.4 0l-1.4 1.4a7.5 7.5 0 0 0-10.6 0z" />
        </svg>
        <span className="relative h-[11px] w-[22px] rounded-[3px] border border-foreground/60 p-[1.5px]">
          <span className="block h-full w-[80%] rounded-[1.5px] bg-foreground" />
        </span>
      </div>
      {title && (
        <p className="absolute left-0 right-0 top-10 text-center text-[13px] font-medium tracking-tight">
          {title}
        </p>
      )}
    </div>
  );
}

function SpaceIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="7.5" cy="9" r="3" />
      <circle cx="16" cy="7" r="2.6" fill="currentColor" />
      <circle cx="13" cy="16.5" r="3" />
    </svg>
  );
}
function MeIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="7.5" r="3.6" />
      <ellipse cx="12" cy="17.5" rx="6.5" ry="3.4" />
    </svg>
  );
}

function BottomNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const tap = useTap();
  const items: [View, string, ReactNode][] = [
    ['discover', 'Discover', <Search key="s" className="size-[18px]" strokeWidth={2.4} />],
    ['space', 'My Space', <SpaceIcon key="m" className="size-[20px]" />],
    ['me', 'Me', <MeIcon key="e" className="size-[20px]" />],
  ];
  const at = items.findIndex(([k]) => k === view);
  return (
    <nav className="absolute inset-x-4 bottom-6 z-30">
      <div className="liquid-glass relative grid grid-cols-3 rounded-full p-1.5">
        <span
          className="absolute inset-y-1.5 rounded-full bg-foreground/15 transition-all duration-300 ease-out"
          style={{
            left: `calc(${at} * (100% - 12px) / 3 + 6px)`,
            width: 'calc((100% - 12px) / 3)',
            boxShadow:
              'inset 0 1px 0 color-mix(in oklab, var(--starlight) 30%, transparent), 0 0 18px -4px var(--photon)',
          }}
        />
        {items.map(([k, label, icon]) => {
          const on = view === k;
          return (
            <button
              key={k}
              onClick={() => {
                tap();
                setView(k);
              }}
              aria-current={on}
              className={`press relative flex flex-col items-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors ${on ? 'text-photon-glow' : 'text-muted-foreground'}`}
            >
              {icon}
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const orbits = [
  {
    q: 'I want to design houses',
    hue: 'var(--photon)',
    hue2: 'var(--photon-glow)',
    tag: 'Design',
    recalls: 7,
  },
  {
    q: 'I want to start my own studio',
    hue: 'var(--ember)',
    hue2: 'oklch(0.85 0.14 70)',
    tag: 'Business',
    recalls: 4,
  },
  {
    q: 'I want to run a marathon',
    hue: 'oklch(0.7 0.2 155)',
    hue2: 'oklch(0.85 0.15 160)',
    tag: 'Health',
    recalls: 3,
  },
  {
    q: 'I want to see Kyoto in spring',
    hue: 'oklch(0.68 0.22 320)',
    hue2: 'oklch(0.82 0.15 330)',
    tag: 'Travel',
    recalls: 2,
  },
];

function Discover({ onDive }: { onDive: (q: string) => void }) {
  const tap = useTap();
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1);
  const [q, setQ] = useState(orbits[0]!.q);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const o = orbits[idx]!;
  const go = (d: number) => {
    tap();
    const n = (idx + d + orbits.length) % orbits.length;
    setDir(d);
    setIdx(n);
    setQ(orbits[n]!.q);
  };
  const isSaved = saved.has(idx);
  return (
    <div className="relative flex h-full flex-col items-center px-4 pt-12">
      <div className="flex items-center gap-2 rounded-full border border-foreground/10 bg-foreground/[0.06] px-3 py-1 text-[10px] text-muted-foreground backdrop-blur-md">
        <span className="size-1.5 animate-twinkle rounded-full" style={{ background: o.hue }} />
        {o.tag} orbit · {o.recalls} memories nearby
      </div>

      <div className="relative mt-3 flex w-full flex-1 items-center justify-center">
        <button
          onClick={() => go(-1)}
          aria-label="Previous orbit"
          className="press absolute left-0 z-10 grid size-8 place-items-center rounded-full border border-foreground/10 bg-foreground/[0.06] backdrop-blur-md"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          onClick={() => go(1)}
          aria-label="Next orbit"
          className="press absolute right-0 z-10 grid size-8 place-items-center rounded-full border border-foreground/10 bg-foreground/[0.06] backdrop-blur-md"
        >
          <ChevronRight className="size-4" />
        </button>

        <div
          key={idx}
          className="relative grid size-[230px] place-items-center animate-rise"
          style={{ animationName: dir > 0 ? 'slide-l' : 'slide-r' }}
        >
          {/* gravity well rings */}
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute rounded-full border animate-ping-ring"
              style={{
                inset: 40,
                borderColor: `color-mix(in oklab, ${o.hue} 50%, transparent)`,
                animationDelay: `${i * 0.8}s`,
              }}
            />
          ))}
          <div className="absolute inset-0 animate-orbit">
            <svg viewBox="0 0 230 230" className="absolute inset-0">
              <ellipse
                cx="115"
                cy="115"
                rx="110"
                ry="110"
                fill="none"
                stroke="var(--starlight)"
                strokeOpacity="0.12"
                strokeDasharray="2 6"
              />
            </svg>
            {Array.from({ length: o.recalls }).map((_, i) => {
              const a = (i / o.recalls) * Math.PI * 2;
              const c = i % 3 === 0 ? 'var(--hot)' : i % 3 === 1 ? 'var(--warm)' : 'var(--cold)';
              return (
                <span
                  key={i}
                  className="absolute size-2 rounded-full"
                  style={{
                    left: 115 + Math.cos(a) * 108 - 4,
                    top: 115 + Math.sin(a) * 108 - 4,
                    background: c,
                    ...glow(c, 8),
                  }}
                />
              );
            })}
          </div>
          <div className="absolute inset-8 animate-orbit-slow">
            <span
              className="absolute -top-1 left-1/2 size-3 rounded-full"
              style={{ background: o.hue2, ...glow(o.hue2, 10) }}
            />
          </div>
          {/* planet with tilted ring */}
          <div className="relative animate-breathe">
            <div
              className="size-[112px] rounded-full"
              style={{
                background: `radial-gradient(circle at 32% 28%, var(--starlight) 0%, ${o.hue2} 14%, ${o.hue} 52%, color-mix(in oklab, ${o.hue} 35%, var(--void)) 100%)`,
                boxShadow: `0 0 50px 8px color-mix(in oklab, ${o.hue} 50%, transparent), inset -14px -18px 28px color-mix(in oklab, var(--void) 70%, transparent)`,
              }}
            />
            <div
              className="absolute left-1/2 top-1/2 h-[34px] w-[190px] -translate-x-1/2 -translate-y-1/2 -rotate-[18deg] rounded-[50%] border-[3px]"
              style={{
                borderColor: `color-mix(in oklab, ${o.hue2} 70%, transparent)`,
                borderTopColor: 'transparent',
                boxShadow: `0 0 14px color-mix(in oklab, ${o.hue2} 50%, transparent)`,
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex gap-1.5">
        {orbits.map((_, i) => (
          <button
            key={i}
            onClick={() => go(i - idx)}
            aria-label={`Orbit ${i + 1}`}
            className={`h-1.5 rounded-full transition-all ${i === idx ? 'w-5 bg-foreground' : 'w-1.5 bg-foreground/30'}`}
          />
        ))}
      </div>

      <textarea
        value={q}
        onChange={(e) => setQ(e.target.value)}
        rows={2}
        className="mt-4 w-full resize-none bg-transparent text-center text-[20px] font-medium leading-snug tracking-tight text-foreground outline-none"
      />

      <div className="mb-4 mt-2 flex items-center gap-3">
        <button
          onClick={() => {
            tap(12);
            setSaved((s) => {
              const n = new Set(s);
              n.has(idx) ? n.delete(idx) : n.add(idx);
              return n;
            });
          }}
          aria-pressed={isSaved}
          aria-label="Save as wishstar"
          className={`press grid size-12 place-items-center rounded-full border border-foreground/10 backdrop-blur-md ${isSaved ? 'bg-ember/25 text-ember' : 'bg-foreground/10'}`}
        >
          <Star className={`size-5 transition ${isSaved ? 'scale-110 fill-current' : ''}`} />
        </button>
        <button
          onClick={() => {
            tap(20);
            onDive(q);
          }}
          className="press group relative overflow-hidden rounded-full bg-primary px-10 py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg"
        >
          <span className="relative z-10">Dive</span>
          <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-photon-glow/40 to-transparent animate-shine" />
        </button>
      </div>
    </div>
  );
}

function Timeline({ first, onBack }: { first: string; onBack: () => void }) {
  const items = [{ q: first, x: 30 }, ...wishes.filter((w) => w.q !== first)];
  return (
    <div className="relative h-full overflow-y-auto px-5 pb-6 pt-12">
      <button onClick={onBack} className="mb-2 text-[11px] text-muted-foreground">
        ‹ New dive
      </button>
      <div className="relative space-y-7">
        {items.map((w, i) => (
          <button
            key={w.q}
            className="press animate-rise flex w-full flex-col items-start text-left"
            style={{ paddingLeft: `${w.x}%`, animationDelay: `${i * 90}ms` }}
          >
            <Orb size={i === 0 ? 24 : 20} />
            <p
              className={`mt-1 pr-2 ${i === 0 ? 'text-[16px]' : 'text-[15px]'} font-medium leading-snug tracking-tight`}
            >
              {w.q}
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground/60">Tap to see results</p>
          </button>
        ))}
      </div>
    </div>
  );
}

type Mem = { t: string; tier: 'hot' | 'warm' | 'cold'; when: string };
const constellationMems: Record<string, Mem[]> = {
  Design: [
    { t: 'I want to design houses', tier: 'hot', when: '2m' },
    { t: 'Learn more about design', tier: 'hot', when: '3h' },
    { t: 'Loves brutalist concrete', tier: 'warm', when: '5d' },
    { t: 'Be an artist', tier: 'warm', when: '4d' },
    { t: 'Be a fashion designer', tier: 'cold', when: '6w' },
  ],
  Health: [
    { t: 'Runs 5k on Sundays', tier: 'warm', when: '1d' },
    { t: 'Allergic to peanuts', tier: 'hot', when: 'pinned' },
    { t: 'Tried keto in 2024', tier: 'cold', when: '1y' },
  ],
  Business: [
    { t: 'Start a studio by 30', tier: 'hot', when: '1h' },
    { t: 'Reading on pricing', tier: 'warm', when: '2d' },
    { t: 'Pitch deck feedback', tier: 'warm', when: '1w' },
    { t: 'Old LLC idea', tier: 'cold', when: '8mo' },
  ],
  Travel: [
    { t: 'Wants to see Kyoto', tier: 'warm', when: '3w' },
    { t: 'Prefers window seats', tier: 'cold', when: '1y' },
    { t: 'Lisbon trip 2023', tier: 'cold', when: '2y' },
  ],
};
const tierColor = { hot: 'var(--hot)', warm: 'var(--warm)', cold: 'var(--cold)' } as const;
type Filter = 'all' | Mem['tier'];

function Cluster({
  c,
  filter,
  onOpen,
  i,
}: {
  c: (typeof clusters)[number];
  filter: Filter;
  onOpen: () => void;
  i: number;
}) {
  const mems = constellationMems[c.name] ?? [];
  const pr = rand(c.name.length * 97 + c.dots);
  const pts = mems.map((m) => ({ m, x: 22 + pr() * 56, y: 25 + pr() * 50 }));
  return (
    <button
      onClick={onOpen}
      className="press absolute animate-drift text-left"
      style={{ left: `${c.x}%`, top: `${c.y}%`, animationDelay: `${i * 1.3}s` }}
      aria-label={`Open ${c.name}`}
    >
      <svg className="absolute -top-9 h-10 w-20 overflow-visible" style={{ left: 40 }}>
        <polyline
          points="6,38 6,22 20,8"
          fill="none"
          stroke="var(--starlight)"
          strokeOpacity="0.55"
          strokeWidth="1"
        />
      </svg>
      <p
        className="absolute -top-12 whitespace-nowrap text-[14px] font-medium tracking-tight"
        style={{ left: 64 }}
      >
        {c.name} <span className="text-[10px] text-muted-foreground">{mems.length}</span>
      </p>
      <div
        className="relative size-[104px] rounded-full border border-foreground/15"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--starlight) 7%, transparent), transparent 70%)',
        }}
      >
        <span
          className="absolute inset-0 rounded-full border border-photon/30 animate-ping-ring"
          style={{ animationDelay: `${i * 0.6}s` }}
        />
        <svg className="absolute inset-0 size-full" viewBox="0 0 100 100">
          {pts.slice(1).map((p, j) => (
            <line
              key={j}
              x1={pts[j]!.x}
              y1={pts[j]!.y}
              x2={p.x}
              y2={p.y}
              stroke="var(--starlight)"
              strokeOpacity="0.18"
              strokeWidth="0.6"
            />
          ))}
        </svg>
        {pts.map((p, j) => {
          const dim = filter !== 'all' && p.m.tier !== filter;
          return (
            <span
              key={j}
              className="absolute rounded-[2px] transition-all duration-500 animate-twinkle"
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.m.tier === 'hot' ? 7 : 5,
                height: p.m.tier === 'hot' ? 7 : 5,
                background: tierColor[p.m.tier],
                opacity: dim ? 0.12 : 1,
                animationDelay: `${j * 0.5}s`,
                ...glow(tierColor[p.m.tier], dim ? 0 : 6),
              }}
            />
          );
        })}
      </div>
    </button>
  );
}

function Constellation({ name, onClose }: { name: string; onClose: () => void }) {
  const tap = useTap();
  const mems = constellationMems[name] ?? [];
  const [sel, setSel] = useState<number | null>(0);
  return (
    <div className="absolute inset-0 z-20 flex flex-col animate-rise bg-void/70 backdrop-blur-sm">
      <button
        onClick={() => {
          tap();
          onClose();
        }}
        className="press ml-5 mt-14 self-start text-[11px] text-muted-foreground"
      >
        ‹ All constellations
      </button>
      <div className="relative mx-auto mt-2 grid size-[230px] place-items-center">
        <div className="absolute inset-0 rounded-full border border-foreground/10" />
        <div className="absolute inset-6 rounded-full border border-dashed border-foreground/10" />
        <div className="absolute inset-0 animate-orbit">
          {mems.map((m, i) => {
            const a = (i / mems.length) * Math.PI * 2;
            const rr = m.tier === 'hot' ? 62 : m.tier === 'warm' ? 88 : 112;
            return (
              <button
                key={i}
                onClick={() => {
                  tap();
                  setSel(i);
                }}
                aria-label={m.t}
                className="press absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center"
                style={{ left: 115 + Math.cos(a) * rr, top: 115 + Math.sin(a) * rr }}
              >
                <span
                  className={`block rounded-full ${sel === i ? 'size-3.5' : 'size-2.5'}`}
                  style={{
                    background: tierColor[m.tier],
                    opacity: m.tier === 'cold' ? 0.55 : 1,
                    ...glow(tierColor[m.tier], sel === i ? 14 : 7),
                  }}
                />
              </button>
            );
          })}
        </div>
        <div
          className="animate-breathe size-16 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 40% 35%, var(--photon-glow), var(--photon) 60%, var(--void))',
            ...glow('var(--photon)', 18),
          }}
        />
        <p className="absolute text-[13px] font-semibold">{name}</p>
      </div>
      <div className="mx-4 mt-auto mb-2 rounded-3xl border border-foreground/10 bg-foreground/[0.05] p-4">
        {sel !== null && mems[sel] && (
          <div key={sel} className="animate-rise">
            <p
              className="font-mono text-[10px] uppercase tracking-widest"
              style={{ color: tierColor[mems[sel].tier] }}
            >
              {mems[sel].tier === 'hot'
                ? 'Photosphere'
                : mems[sel].tier === 'warm'
                  ? 'Kuiper Belt'
                  : 'Oort Cloud · frozen'}{' '}
              · {mems[sel].when}
            </p>
            <p className="mt-1 text-[15px] font-medium">{mems[sel].t}</p>
            <div className="mt-3 flex gap-2 text-[11px]">
              <button
                onClick={() => tap(12)}
                className="press rounded-full bg-foreground/10 px-3 py-1.5"
              >
                Pin hot
              </button>
              <button
                onClick={() => tap(12)}
                className="press rounded-full bg-foreground/10 px-3 py-1.5"
              >
                Freeze
              </button>
              <button
                onClick={() => tap(25)}
                className="press rounded-full px-3 py-1.5 text-destructive"
              >
                Forget
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MySpace() {
  const tap = useTap();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="relative h-full overflow-hidden">
      <div className="absolute left-0 right-0 top-14 z-10 flex justify-center gap-1.5">
        {(['all', 'hot', 'warm', 'cold'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => {
              tap();
              setFilter(f);
            }}
            className={`press rounded-full px-2.5 py-1 text-[10px] font-medium ${filter === f ? 'bg-foreground text-background' : 'liquid-glass text-muted-foreground'}`}
          >
            {f === 'all' ? 'All' : f === 'hot' ? 'Photosphere' : f === 'warm' ? 'Kuiper' : 'Oort'}
          </button>
        ))}
      </div>
      <div
        className="absolute left-[60%] top-[8%] size-[120px] animate-orbit-slow rounded-full"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--photon) 14%, transparent), transparent 70%)',
        }}
      >
        <span
          className="absolute left-[10%] top-[40%] size-3 rounded-full"
          style={{ background: 'var(--photon)', ...glow('var(--photon)', 8) }}
        />
        <span
          className="absolute left-[70%] top-[70%] size-2 rounded-full"
          style={{ background: 'var(--ember)', ...glow('var(--ember)', 6) }}
        />
      </div>
      <div className="absolute inset-0 top-6">
        {clusters.map((c, i) => (
          <Cluster
            key={c.name}
            c={c}
            i={i}
            filter={filter}
            onOpen={() => {
              tap(15);
              setOpen(c.name);
            }}
          />
        ))}
      </div>
      <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-muted-foreground/70">
        Tap a constellation to explore
      </p>
      {open && <Constellation name={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className="press flex w-full items-center justify-between border-b border-border px-4 py-3 text-sm last:border-0"
    >
      {label}
      <span
        className={`relative h-5 w-9 rounded-full transition ${on ? 'bg-photon' : 'bg-foreground/20'}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-starlight transition-all ${on ? 'left-[18px]' : 'left-0.5'}`}
        />
      </span>
    </button>
  );
}

function Me() {
  const p = useContext(PrefsCtx);
  const tap = useTap();
  return (
    <div className="h-full space-y-3 overflow-y-auto px-7 pb-4 pt-12">
      <div className="flex flex-col items-center">
        <Orb size={46} />
        <p className="mt-2 text-lg font-semibold">Alex Rivera</p>
        <p className="text-xs text-muted-foreground">142 wishstars · 5 constellations</p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['62', 'Photosphere'],
          ['418', 'Kuiper'],
          ['804', 'Oort'],
        ].map(([v, l]) => (
          <div key={l} className="rounded-2xl bg-foreground/[0.06] py-3">
            <p className="font-mono text-base">{v}</p>
            <p className="text-[10px] text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-foreground/[0.04]">
        <Toggle
          label="Haptic feedback"
          on={p.haptics}
          onChange={() => {
            navigator.vibrate?.(10);
            p.set({ haptics: !p.haptics });
          }}
        />
        <Toggle
          label="Reduce motion"
          on={p.reduced}
          onChange={() => {
            tap();
            p.set({ reduced: !p.reduced });
          }}
        />
      </div>
      <div className="space-y-0 rounded-2xl bg-foreground/[0.04]">
        {['Memory & privacy', 'Connected agents', 'Encryption key', 'Export my sky'].map((x) => (
          <button
            key={x}
            onClick={() => tap()}
            className="press flex w-full justify-between border-b border-border px-4 py-3 text-sm last:border-0"
          >
            {x}
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        ))}
      </div>
      <button
        onClick={() => tap(30)}
        className="press w-full rounded-full border border-destructive/40 py-2.5 text-sm text-destructive"
      >
        Forget everything
      </button>
    </div>
  );
}

export function PhoneExplorer({ initial = 'discover' as View }: { initial?: View }) {
  const [view, setView] = useState<View>(initial);
  const [dive, setDive] = useState<string | null>(null);
  const [prefs, setPrefs] = useState({ haptics: true, reduced: false });
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      setPrefs((p) => ({ ...p, reduced: true }));
  }, []);
  const ctx: Prefs = { ...prefs, set: (n) => setPrefs((p) => ({ ...p, ...n })) };

  return (
    <PrefsCtx.Provider value={ctx}>
      <div
        className={`relative mx-auto h-[720px] w-[350px] rounded-[58px] p-[3px] ${prefs.reduced ? 'motion-off' : ''}`}
        style={{
          background:
            'linear-gradient(150deg, var(--ember), color-mix(in oklab, var(--void) 80%, var(--starlight)) 18%, var(--void) 45%, var(--photon) 72%, var(--photon-glow) 85%, var(--ember))',
          boxShadow:
            '0 40px 80px -20px oklch(0 0 0 / 0.8), 0 0 50px -10px color-mix(in oklab, var(--photon) 50%, transparent)',
        }}
      >
        <div className="h-full rounded-[55px] bg-void p-[9px]">
          <div
            className="relative flex h-full flex-col overflow-hidden rounded-[47px]"
            style={{
              background:
                'radial-gradient(120% 70% at 50% 110%, color-mix(in oklab, var(--photon) 30%, var(--void)), transparent 60%), linear-gradient(180deg, var(--void), color-mix(in oklab, var(--void) 70%, oklch(0.3 0.12 270)))',
            }}
          >
            {STARS.map((s, i) => (
              <span
                key={i}
                className={`absolute rounded-full bg-starlight ${i % 4 === 0 ? 'animate-twinkle' : ''}`}
                style={{
                  left: `${s.x}%`,
                  top: `${s.y}%`,
                  width: s.s,
                  height: s.s,
                  opacity: s.o,
                  animationDelay: `${(i % 7) * 0.4}s`,
                }}
              />
            ))}
            <StatusBar
              title={
                view === 'discover' && dive
                  ? 'Discover wishstars'
                  : view === 'space'
                    ? 'My Space'
                    : undefined
              }
            />
            <div className="relative min-h-0 flex-1 pb-24">
              {view === 'discover' &&
                (dive ? (
                  <Timeline first={dive} onBack={() => setDive(null)} />
                ) : (
                  <Discover onDive={setDive} />
                ))}
              {view === 'space' && <MySpace />}
              {view === 'me' && <Me />}
            </div>
            <BottomNav view={view} setView={setView} />
            <div className="absolute bottom-2 left-1/2 h-[4px] w-28 -translate-x-1/2 rounded-full bg-foreground/80" />
          </div>
        </div>
      </div>
    </PrefsCtx.Provider>
  );
}
