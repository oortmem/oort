import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Minus,
  Plus,
  Maximize2,
  Pin,
  ArrowUpRight,
  Trash2,
  X,
  Sparkles,
} from 'lucide-react';
import type { Tier } from '@/lib/oort-data';

type Mem = {
  id: string;
  text: string;
  cluster: string;
  tier: Tier;
  when: string;
  recalls: number;
  x: number;
  y: number;
};

const tierMeta: Record<Tier, { name: string; color: string; r: number; desc: string }> = {
  hot: { name: 'Photosphere', color: 'var(--hot)', r: 150, desc: 'Instant recall' },
  warm: { name: 'Kuiper Belt', color: 'var(--warm)', r: 270, desc: 'In a blink' },
  cold: { name: 'Oort Cloud', color: 'var(--cold)', r: 390, desc: 'In a moment' },
};

const seed = [
  {
    name: 'Design',
    tier: 'hot' as Tier,
    angle: -140,
    items: [
      'I want to design houses',
      'Learning more about design',
      'Loves brutalist architecture',
      'Sketches on an iPad',
      'Prefers dark interfaces',
      'Follows Dieter Rams',
      'Wants a design mentor',
    ],
  },
  {
    name: 'Code',
    tier: 'hot' as Tier,
    angle: 20,
    items: [
      'Building a TypeScript agent',
      'Uses Neovim',
      'Asked about vector search',
      'Ships on Fridays',
      'Learning Rust',
      'Prefers tabs over spaces',
    ],
  },
  {
    name: 'Business',
    tier: 'warm' as Tier,
    angle: -60,
    items: [
      'Starting a studio in 2027',
      'Pricing a first client',
      'Reads Stratechery',
      'Wants to hire a designer',
      'Quarterly goals: 3 clients',
    ],
  },
  {
    name: 'Health',
    tier: 'warm' as Tier,
    angle: 110,
    items: [
      'Runs 5k on Sundays',
      'Wants waterproof trail shoes',
      'Vegetarian since 2022',
      'Sleeps best at 22:30',
    ],
  },
  {
    name: 'Travel',
    tier: 'cold' as Tier,
    angle: 160,
    items: [
      'Lisbon trip 2023',
      'Wants to see Kyoto',
      'Window seat, always',
      'Hates red-eye flights',
    ],
  },
  {
    name: 'Art',
    tier: 'cold' as Tier,
    angle: -10,
    items: ['I want to be an artist', 'I want to be a fashion designer', 'Painted in oils at 19'],
  },
];
const whens = ['2m ago', '18m ago', '3h ago', '1d ago', '4d ago', '6w ago', '8mo ago', '2y ago'];

function buildMemories(): {
  mems: Mem[];
  centers: Record<string, { x: number; y: number; tier: Tier }>;
} {
  const mems: Mem[] = [];
  const centers: Record<string, { x: number; y: number; tier: Tier }> = {};
  seed.forEach((c, ci) => {
    const a = (c.angle * Math.PI) / 180;
    const R = tierMeta[c.tier].r;
    const cx = Math.cos(a) * R,
      cy = Math.sin(a) * R;
    centers[c.name] = { x: cx, y: cy, tier: c.tier };
    c.items.forEach((text, i) => {
      const ang = i * 2.399 + ci;
      const rad = 18 + Math.sqrt(i + 1) * 16;
      const tier: Tier =
        i === 0 && c.tier !== 'hot' ? (c.tier === 'cold' ? 'warm' : 'hot') : c.tier;
      mems.push({
        id: `${c.name}-${i}`,
        text,
        cluster: c.name,
        tier,
        when: whens[(i + ci * 2) % whens.length] + '',
        recalls: ((i * 37 + ci * 11) % 90) + 3,
        x: cx + Math.cos(ang) * rad,
        y: cy + Math.sin(ang) * rad,
      });
    });
  });
  return { mems, centers };
}

export function StarMapSection({
  height = 640,
  panel = true,
}: { height?: number; panel?: boolean } = {}) {
  const { mems: initial, centers } = useMemo(buildMemories, []);
  const [mems, setMems] = useState(initial);
  const [q, setQ] = useState('');
  const [tiers, setTiers] = useState<Record<Tier, boolean>>({ hot: true, warm: true, cold: true });
  const [cluster, setCluster] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(
    null,
  );
  const svgRef = useRef<SVGSVGElement>(null);

  const match = (m: Mem) =>
    tiers[m.tier] &&
    (!cluster || m.cluster === cluster) &&
    (!q ||
      m.text.toLowerCase().includes(q.toLowerCase()) ||
      m.cluster.toLowerCase().includes(q.toLowerCase()));
  const visible = mems.filter(match);
  const selected = mems.find((m) => m.id === sel) ?? null;
  const hovered = mems.find((m) => m.id === hover) ?? null;

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 1800);
  };
  const focusOn = (x: number, y: number, k = 1.8) => setView({ x: -x * k, y: -y * k, k });
  const reset = () => {
    setView({ x: 0, y: 0, k: 1 });
    setCluster(null);
    setSel(null);
  };
  const zoom = (f: number) =>
    setView((v) => ({ x: v.x * f, y: v.y * f, k: Math.min(4, Math.max(0.5, v.k * f)) }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') {
        if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        return;
      }
      if (e.key === 'Escape') {
        setSel(null);
        setCluster(null);
      }
      if (e.key === '+' || e.key === '=') zoom(1.25);
      if (e.key === '-') zoom(0.8);
      if (e.key === '0') reset();
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('probe')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.1 : 0.9);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pickCluster = (name: string) => {
    if (cluster === name) {
      reset();
      return;
    }
    setCluster(name);
    setSel(null);
    const c = centers[name];
    if (c) focusOn(c.x, c.y, 1.5);
  };
  const pickMem = (m: Mem) => {
    setSel(m.id);
    setCluster(m.cluster);
    focusOn(m.x, m.y, 1.6);
  };

  const act = (kind: 'promote' | 'pin' | 'forget') => {
    if (!selected) return;
    if (kind === 'pin') {
      setPinned((p) => {
        const n = new Set(p);
        n.has(selected.id) ? n.delete(selected.id) : n.add(selected.id);
        return n;
      });
      flash(pinned.has(selected.id) ? 'Unpinned' : 'Pinned to Photosphere');
    }
    if (kind === 'promote') {
      const next: Tier = selected.tier === 'cold' ? 'warm' : 'hot';
      setMems((ms) => ms.map((m) => (m.id === selected.id ? { ...m, tier: next } : m)));
      flash(`Moved to ${tierMeta[next].name}`);
    }
    if (kind === 'forget') {
      setMems((ms) => ms.filter((m) => m.id !== selected.id));
      setSel(null);
      flash('Memory forgotten');
    }
  };

  const counts = (['hot', 'warm', 'cold'] as Tier[]).map(
    (t) => [t, mems.filter((m) => m.tier === t).length] as const,
  );

  return (
    <div className={panel ? 'grid gap-6 xl:grid-cols-[1fr_360px]' : undefined}>
      <div
        className="relative overflow-hidden rounded-3xl border border-border bg-void"
        style={{ height }}
      >
        <div className="starfield absolute inset-0 opacity-70" />
        {/* Toolbar */}
        <div className="liquid-glass absolute left-4 right-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-full p-1.5">
          <div className="flex min-w-48 flex-1 items-center gap-2 rounded-full bg-background/40 px-3 py-1.5">
            <Search className="size-4 text-muted-foreground" />
            <input
              id="probe"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Probe memory…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {q ? (
              <button onClick={() => setQ('')} aria-label="Clear search">
                <X className="size-3.5 text-muted-foreground" />
              </button>
            ) : (
              <kbd className="rounded border border-border px-1.5 font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
            )}
          </div>
          {counts.map(([t, n]) => (
            <button
              key={t}
              onClick={() => setTiers((s) => ({ ...s, [t]: !s[t] }))}
              aria-pressed={tiers[t]}
              className={`press flex items-center gap-2 rounded-full px-3 py-1.5 text-xs transition ${tiers[t] ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground line-through opacity-60'}`}
            >
              <span
                className="size-2 rounded-full"
                style={{
                  background: tierMeta[t].color,
                  boxShadow: tiers[t] ? `0 0 8px ${tierMeta[t].color}` : 'none',
                }}
              />
              {tierMeta[t].name}
              <span className="font-mono text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>

        <svg
          ref={svgRef}
          viewBox="-460 -460 920 920"
          className="absolute inset-0 size-full cursor-grab touch-none select-none active:cursor-grabbing"
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x,
              dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            const s = 920 / (svgRef.current?.clientHeight || 640);
            setView((v) => ({ ...v, x: d.vx + dx * s, y: d.vy + dy * s }));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && !d.moved && e.target === svgRef.current) {
              setSel(null);
            }
          }}
        >
          <defs>
            <radialGradient id="core">
              <stop offset="0%" stopColor="var(--starlight)" />
              <stop offset="35%" stopColor="var(--photon-glow)" />
              <stop offset="100%" stopColor="var(--photon)" stopOpacity="0" />
            </radialGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              transition: drag.current ? 'none' : 'transform 600ms cubic-bezier(.2,.7,.2,1)',
            }}
          >
            {(['cold', 'warm', 'hot'] as Tier[]).map((t) => (
              <g key={t} opacity={tiers[t] ? 1 : 0.25} style={{ transition: 'opacity 300ms' }}>
                <circle
                  r={tierMeta[t].r}
                  fill="none"
                  stroke={tierMeta[t].color}
                  strokeOpacity={0.22}
                  strokeDasharray={t === 'cold' ? '2 6' : t === 'warm' ? '6 6' : undefined}
                />
                <text
                  y={-tierMeta[t].r - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono"
                  fontSize={10}
                  letterSpacing={2}
                >
                  {tierMeta[t].name.toUpperCase()}
                </text>
              </g>
            ))}
            <circle
              r={60}
              fill="url(#core)"
              opacity={0.5}
              className="animate-breathe"
              style={{ transformOrigin: 'center' }}
            />
            <circle r={7} fill="var(--starlight)" filter="url(#glow)" />

            {/* constellation lines */}
            {seed.map((c) => {
              const pts = mems.filter((m) => m.cluster === c.name && match(m));
              const on = !cluster || cluster === c.name;
              return (
                <g key={c.name} opacity={on ? 1 : 0.15} style={{ transition: 'opacity 400ms' }}>
                  {pts.slice(1).map((m, i) => (
                    <line
                      key={m.id}
                      x1={pts[i]!.x}
                      y1={pts[i]!.y}
                      x2={m.x}
                      y2={m.y}
                      stroke="var(--starlight)"
                      strokeOpacity={0.18}
                      strokeWidth={0.8 / view.k}
                    />
                  ))}
                  <g
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      pickCluster(c.name);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <circle
                      cx={centers[c.name]?.x ?? 0}
                      cy={centers[c.name]?.y ?? 0}
                      r={62}
                      fill="var(--starlight)"
                      fillOpacity={cluster === c.name ? 0.05 : 0.0001}
                      stroke={cluster === c.name ? 'var(--photon-glow)' : 'transparent'}
                      strokeOpacity={0.5}
                    />
                    <text
                      x={centers[c.name]?.x ?? 0}
                      y={(centers[c.name]?.y ?? 0) - 82}
                      textAnchor="middle"
                      fontSize={13 / Math.sqrt(view.k)}
                      className="fill-foreground font-medium"
                    >
                      {c.name}
                    </text>
                    <text
                      x={centers[c.name]?.x ?? 0}
                      y={(centers[c.name]?.y ?? 0) - 68}
                      textAnchor="middle"
                      fontSize={9 / Math.sqrt(view.k)}
                      className="fill-muted-foreground font-mono"
                    >
                      {pts.length} memories
                    </text>
                  </g>
                </g>
              );
            })}

            {/* stars */}
            {mems.map((m, i) => {
              const ok = match(m);
              const isSel = sel === m.id,
                isHover = hover === m.id;
              const r = (2.2 + Math.min(m.recalls, 80) / 30) * (isSel || isHover ? 1.8 : 1);
              return (
                <g
                  key={m.id}
                  className="cursor-pointer"
                  opacity={ok ? (m.tier === 'cold' ? 0.6 : 1) : 0.08}
                  style={{ transition: 'opacity 300ms' }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    pickMem(m);
                  }}
                  onMouseEnter={() => setHover(m.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <circle cx={m.x} cy={m.y} r={12} fill="transparent" />
                  {(isSel || pinned.has(m.id)) && (
                    <circle
                      cx={m.x}
                      cy={m.y}
                      r={r + 6}
                      fill="none"
                      stroke={tierMeta[m.tier].color}
                      strokeOpacity={0.7}
                      strokeWidth={1 / view.k}
                      className={isSel ? 'animate-breathe' : ''}
                      style={{ transformOrigin: `${m.x}px ${m.y}px` }}
                    />
                  )}
                  <circle
                    cx={m.x}
                    cy={m.y}
                    r={r}
                    fill={tierMeta[m.tier].color}
                    filter="url(#glow)"
                    className="animate-twinkle"
                    style={{ animationDelay: `${(i % 9) * 0.35}s`, transition: 'r 200ms' }}
                  />
                  {q && ok && (
                    <text x={m.x + 8} y={m.y + 3} fontSize={8} className="fill-foreground">
                      {m.text}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {hovered && !selected && (
          <div className="liquid-glass pointer-events-none absolute bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-2xl px-4 py-2 text-sm animate-rise">
            <span
              className="mr-2 inline-block size-2 rounded-full"
              style={{ background: tierMeta[hovered.tier].color }}
            />
            {hovered.text}
            <span className="ml-3 font-mono text-[10px] text-muted-foreground">{hovered.when}</span>
          </div>
        )}

        {selected && !panel && (
          <div className="liquid-glass absolute bottom-16 left-4 z-10 w-64 animate-rise rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-muted-foreground">
                {selected.cluster}
              </span>
              <span
                className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px]"
                style={{ color: tierMeta[selected.tier].color }}
              >
                {tierMeta[selected.tier].name}
              </span>
            </div>
            <p className="mt-2 text-sm leading-snug">“{selected.text}”</p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {selected.when} · {selected.recalls} recalls · {tierMeta[selected.tier].desc}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              <button
                onClick={() => act('promote')}
                disabled={selected.tier === 'hot'}
                className="press rounded-lg border border-border py-1.5 text-[11px] hover:bg-foreground/5 disabled:opacity-40"
              >
                Closer
              </button>
              <button
                onClick={() => act('pin')}
                className="press rounded-lg border border-border py-1.5 text-[11px] hover:bg-foreground/5"
              >
                {pinned.has(selected.id) ? 'Unpin' : 'Pin'}
              </button>
              <button
                onClick={() => act('forget')}
                className="press rounded-lg border border-border py-1.5 text-[11px] text-destructive hover:bg-destructive/10"
              >
                Forget
              </button>
            </div>
          </div>
        )}

        {/* zoom controls */}
        <div className="liquid-glass absolute bottom-4 right-4 z-10 flex flex-col rounded-full p-1">
          <button
            onClick={() => zoom(1.25)}
            aria-label="Zoom in"
            className="press grid size-8 place-items-center rounded-full hover:bg-foreground/10"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={() => zoom(0.8)}
            aria-label="Zoom out"
            className="press grid size-8 place-items-center rounded-full hover:bg-foreground/10"
          >
            <Minus className="size-4" />
          </button>
          <button
            onClick={reset}
            aria-label="Reset view"
            className="press grid size-8 place-items-center rounded-full hover:bg-foreground/10"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
        <p className="absolute bottom-5 left-5 z-10 font-mono text-[10px] text-muted-foreground">
          Drag to pan · scroll to zoom · / search · esc clear · {Math.round(view.k * 100)}%
        </p>
        {toast && (
          <div className="absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-full bg-primary px-4 py-1.5 text-xs text-primary-foreground animate-rise">
            {toast}
          </div>
        )}
      </div>

      {/* Side panel */}
      {panel && (
        <div
          className="flex flex-col overflow-hidden rounded-3xl border border-border bg-card/60"
          style={{ height }}
        >
          {selected ? (
            <div key={selected.id} className="flex flex-1 flex-col p-5 animate-rise">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setSel(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  ← {selected.cluster}
                </button>
                <span
                  className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px]"
                  style={{ color: tierMeta[selected.tier].color }}
                >
                  {tierMeta[selected.tier].name}
                </span>
              </div>
              <p className="mt-6 text-xl leading-snug">“{selected.text}”</p>
              <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
                {[
                  ['Last recalled', selected.when],
                  ['Recalls', String(selected.recalls)],
                  ['Speed', tierMeta[selected.tier].desc],
                  ['Pinned', pinned.has(selected.id) ? 'Yes' : 'No'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-border p-3">
                    <dt className="text-[10px] text-muted-foreground">{k}</dt>
                    <dd className="mt-1">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-6 font-mono text-[10px] text-muted-foreground">NEARBY</p>
              <ul className="mt-2 space-y-1">
                {mems
                  .filter((m) => m.cluster === selected.cluster && m.id !== selected.id)
                  .slice(0, 4)
                  .map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => pickMem(m)}
                        className="w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                      >
                        {m.text}
                      </button>
                    </li>
                  ))}
              </ul>
              <div className="mt-auto grid grid-cols-3 gap-2">
                <button
                  onClick={() => act('promote')}
                  disabled={selected.tier === 'hot'}
                  className="press flex flex-col items-center gap-1 rounded-xl border border-border py-3 text-xs hover:bg-foreground/5 disabled:opacity-40"
                >
                  <ArrowUpRight className="size-4" />
                  Bring closer
                </button>
                <button
                  onClick={() => act('pin')}
                  className="press flex flex-col items-center gap-1 rounded-xl border border-border py-3 text-xs hover:bg-foreground/5"
                >
                  <Pin className="size-4" />
                  {pinned.has(selected.id) ? 'Unpin' : 'Pin'}
                </button>
                <button
                  onClick={() => act('forget')}
                  className="press flex flex-col items-center gap-1 rounded-xl border border-border py-3 text-xs text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-4" />
                  Forget
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="border-b border-border p-5">
                <p className="font-mono text-xs text-muted-foreground">
                  {cluster ? `Constellation · ${cluster}` : 'All constellations'}
                </p>
                <p className="mt-1 text-2xl font-semibold">
                  {visible.length}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    memories in view
                  </span>
                </p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {seed.map((c) => (
                    <button
                      key={c.name}
                      onClick={() => pickCluster(c.name)}
                      className={`press rounded-full border px-2.5 py-1 text-xs transition ${cluster === c.name ? 'border-photon bg-photon/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
              <ul className="flex-1 space-y-1 overflow-y-auto p-3">
                {visible.length === 0 && (
                  <li className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
                    <span>
                      <Sparkles className="mx-auto mb-2 size-5" />
                      Nothing in this part of the sky.
                      <br />
                      Try another word or tier.
                    </span>
                  </li>
                )}
                {visible.map((m) => (
                  <li key={m.id}>
                    <button
                      onMouseEnter={() => setHover(m.id)}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => pickMem(m)}
                      className={`press flex w-full items-start gap-3 rounded-xl p-3 text-left text-sm transition hover:bg-foreground/5 ${hover === m.id ? 'bg-foreground/5' : ''}`}
                    >
                      <span
                        className="mt-1.5 size-2 shrink-0 rounded-full"
                        style={{
                          background: tierMeta[m.tier].color,
                          boxShadow: `0 0 6px ${tierMeta[m.tier].color}`,
                        }}
                      />
                      <span className="flex-1">
                        {m.text}
                        <span className="block text-[11px] text-muted-foreground">
                          {m.cluster} · {m.recalls} recalls
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{m.when}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
