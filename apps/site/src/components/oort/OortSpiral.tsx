import { useEffect, useRef, useState } from 'react';

export type Tier = 'photo' | 'kuiper' | 'oort';
export type SpiralApi = { add: (label: string) => void };
const MS = { photo: [6, 8], kuiper: [12, 20], oort: [48, 40] } as const;
type Node = { label: string; tier: Tier; a: number; speed: number; recalled: number };
type Comet = { node: Node; t: number; sx: number; sy: number };

const LABELS: [string, Tier][] = [
  ['Shoe size 10.5', 'kuiper'],
  ['Prefers trail runs', 'kuiper'],
  ['Cart from Tuesday', 'kuiper'],
  ['Gift for mum, 2024', 'oort'],
  ['First order ever', 'oort'],
  ['Moved to Lisbon', 'oort'],
  ['Allergic to wool', 'oort'],
];

/**
 * Full-bleed atmospheric hero: drifting dust, three tier rings (Photosphere/Kuiper/Oort),
 * clickable memory nodes that fly back to the hot core. Cursor tilts the scene.
 */
export function OortSpiral({
  className = '',
  apiRef,
  onRecall,
}: {
  className?: string;
  apiRef?: React.MutableRefObject<SpiralApi | null>;
  onRecall?: (tier: Tier, ms: number, source: 'click' | 'auto') => void;
}) {
  const recallCb = useRef(onRecall);
  recallCb.current = onRecall;
  const ref = useRef<HTMLCanvasElement>(null);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const star = css.getPropertyValue('--starlight').trim() || 'white';
    const photon = css.getPropertyValue('--photon').trim() || 'dodgerblue';
    const glow = css.getPropertyValue('--photon-glow').trim() || 'skyblue';
    const ember = css.getPropertyValue('--ember').trim() || 'orange';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0,
      h = 0,
      cx = 0,
      cy = 0,
      R = 0;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wide = w > 1024;
      cx = wide ? w * 0.7 : w / 2;
      R = wide ? Math.min(w * 0.3, h * 0.48) : Math.min(w, h) * 0.46;
      cy = wide ? h * 0.5 : h - R * 0.55 - 70;
    };
    resize();
    window.addEventListener('resize', resize);

    const dust = Array.from({ length: 420 }, () => ({
      r: Math.pow(Math.random(), 0.6) * 1.9,
      a: Math.random() * Math.PI * 2,
      s: 0.4 + Math.random() * 1.2,
      z: Math.random(),
    }));
    const nodes: Node[] = LABELS.map(([label, tier], i) => ({
      label,
      tier,
      a: (i / LABELS.length) * Math.PI * 2 + Math.random() * 0.4,
      speed: tier === 'kuiper' ? 0.05 : tier === 'photo' ? 0.12 : -0.02,
      recalled: 0,
    }));
    const ringR = { photo: 0.26, kuiper: 0.62, oort: 1.0 };
    let comets: Comet[] = [];
    let mx = 0,
      my = 0,
      tx = 0,
      ty = 0,
      hover: Node | null = null;
    let lastAuto = performance.now();

    const tilt = 0.42; // vertical squash for 3D disc
    const project = (rad: number, a: number) => {
      const yaw = tx * 0.25;
      const sq = tilt + ty * 0.12;
      return { x: cx + Math.cos(a + yaw) * rad, y: cy + Math.sin(a + yaw) * rad * sq };
    };
    const nodePos = (n: Node) => project(R * ringR[n.tier], n.a);

    const recall = (n: Node) => {
      const p = nodePos(n);
      comets.push({ node: n, t: 0, sx: p.x, sy: p.y });
      n.recalled = 1;
      const [b, j] = MS[n.tier];
      const ms = b + Math.round(Math.random() * j);
      setToast({ text: `“${n.label}” recalled in ${ms} ms`, key: Date.now() });
      recallCb.current?.(n.tier, ms, 'click');
      n.tier = 'photo';
      n.speed = 0.12;
    };
    const order: Tier[] = ['photo', 'kuiper', 'oort'];
    if (apiRef)
      apiRef.current = {
        add: (label) => {
          // New memories land hot; everything else cools one orbit outward.
          for (const n of nodes) {
            const i = order.indexOf(n.tier);
            n.tier = order[Math.min(2, i + 1)]!;
            n.speed = n.tier === 'kuiper' ? 0.05 : -0.02;
          }
          if (nodes.length >= 12) nodes.shift();
          const n: Node = {
            label,
            tier: 'photo',
            a: Math.random() * Math.PI * 2,
            speed: 0.12,
            recalled: 1,
          };
          nodes.push(n);
          const p = nodePos(n);
          comets.push({
            node: n,
            t: 0.35,
            sx: w > 1024 ? w * 0.25 : w / 2,
            sy: h * (w > 1024 ? 0.9 : 0.55),
          });
          void p;
          setToast({ text: `“${label}” stored in Photosphere`, key: Date.now() });
        },
      };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      hover = null;
      const hit = e.pointerType === 'touch' ? 26 : 16;
      for (const n of nodes) {
        const p = nodePos(n);
        if (Math.hypot(p.x - mx, p.y - my) < hit) hover = n;
      }
      canvas.style.cursor = hover ? 'pointer' : '';
    };
    const onClick = () => {
      if (hover) {
        recall(hover);
        navigator.vibrate?.(8);
      }
    };
    window.addEventListener('pointermove', onMove);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointerdown', onMove);

    const start = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      const t = reduce ? 0 : (now - start) / 1000;
      const nx = w ? (mx / w - 0.5) * 2 : 0,
        ny = h ? (my / h - 0.5) * 2 : 0;
      if (!reduce) {
        tx += (nx - tx) * 0.04;
        ty += (ny - ty) * 0.04;
      }
      ctx.clearRect(0, 0, w, h);

      // nebula
      const neb = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.8);
      neb.addColorStop(0, photon);
      neb.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = neb;
      ctx.fillRect(0, 0, w, h);

      // dust (back half first for depth)
      ctx.fillStyle = star;
      for (const d of dust) {
        const a = d.a + (t * 0.03) / (0.3 + d.r);
        const p = project(R * d.r, a);
        ctx.globalAlpha = (0.15 + d.z * 0.5) * (d.r < 0.3 ? 0.5 : 1);
        ctx.beginPath();
        ctx.arc(p.x + tx * d.z * 8, p.y + ty * d.z * 8, d.s * (0.5 + d.z), 0, Math.PI * 2);
        ctx.fill();
      }

      // tier rings
      const rings: [number, string, string, number[]][] = [
        [ringR.photo, glow, 'PHOTOSPHERE', []],
        [ringR.kuiper, glow, 'KUIPER BELT', [2, 6]],
        [ringR.oort, star, 'OORT CLOUD', [1, 9]],
      ];
      ctx.lineWidth = 1;
      for (const [k, col, label, dash] of rings) {
        ctx.setLineDash(dash);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.ellipse(cx, cy, R * k, R * k * (tilt + ty * 0.12), 0, 0, Math.PI * 2);
        ctx.stroke();
        // ticks
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.5;
        for (let i = 0; i < 24; i++) {
          const p1 = project(R * k, (i / 24) * Math.PI * 2 + t * 0.02);
          ctx.fillStyle = col;
          ctx.fillRect(p1.x - 0.5, p1.y - 0.5, 1, 1);
        }
        const lp = project(R * k, -Math.PI / 2 - tx * 0.25);
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = col;
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, lp.x, lp.y - 8);
      }
      ctx.setLineDash([]);

      // core
      const pulse = 1 + Math.sin(t * 1.6) * 0.06;
      const cr = R * 0.16 * pulse;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 2.2);
      g.addColorStop(0, star);
      g.addColorStop(0.1, glow);
      g.addColorStop(0.3, photon);
      g.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 2.2, 0, Math.PI * 2);
      ctx.fill();
      // accretion disc: thin bright streaks around the core
      ctx.globalAlpha = 1;
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = k === 1 ? ember : glow;
        ctx.globalAlpha = 0.5 - k * 0.12;
        ctx.lineWidth = 1.4 - k * 0.3;
        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy,
          cr * (1.05 + k * 0.22),
          cr * (1.05 + k * 0.22) * (tilt + ty * 0.12) * 0.8,
          0,
          t * (0.4 + k * 0.2),
          t * (0.4 + k * 0.2) + Math.PI * 1.3,
        );
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 0.55);
      core.addColorStop(0, star);
      core.addColorStop(0.6, glow);
      core.addColorStop(1, 'transparent');
      ctx.globalAlpha = 1;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 0.55, 0, Math.PI * 2);
      ctx.fill();

      // nodes
      for (const n of nodes) {
        if (!reduce) n.a += n.speed * 0.016;
        n.recalled = Math.max(0, n.recalled - 0.01);
        const p = nodePos(n);
        const isH = hover === n;
        const col = n.tier === 'oort' ? star : n.tier === 'photo' ? ember : glow;
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isH ? 12 : 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isH ? 4 : 2.6, 0, Math.PI * 2);
        ctx.fill();
        if (isH || w > 1024) {
          ctx.globalAlpha = isH ? 1 : 0.55;
          ctx.font = '11px ui-monospace, monospace';
          ctx.textAlign = 'left';
          const tw = ctx.measureText(n.label).width;
          ctx.fillStyle = 'rgba(8,12,24,0.7)';
          ctx.beginPath();
          ctx.roundRect(p.x + 8, p.y - 9, tw + 14, 18, 9);
          ctx.fill();
          ctx.strokeStyle = col;
          ctx.globalAlpha *= 0.5;
          ctx.stroke();
          ctx.globalAlpha = isH ? 1 : 0.7;
          ctx.fillStyle = col;
          ctx.fillText(n.label, p.x + 15, p.y + 4);
        }
      }

      // auto recall
      if (!reduce && now - lastAuto > 4200) {
        lastAuto = now;
        const n = nodes[Math.floor(Math.random() * nodes.length)];
        if (n && n.tier !== 'photo') {
          const p = nodePos(n);
          comets.push({ node: n, t: 0, sx: p.x, sy: p.y });
          const [b, j] = MS[n.tier];
          recallCb.current?.(n.tier, b + Math.round(Math.random() * j), 'auto');
        }
      }

      // comets
      comets = comets.filter((c) => c.t < 1);
      for (const c of comets) {
        c.t += 0.014;
        for (let s = 0; s < 18; s++) {
          const tt = Math.max(0, c.t - s * 0.015);
          const e = tt * tt * (3 - 2 * tt);
          const bend = Math.sin(e * Math.PI) * 40;
          const x = c.sx + (cx - c.sx) * e + bend;
          const y = c.sy + (cy - c.sy) * e - bend * 0.4;
          ctx.globalAlpha = (1 - s / 18) * 0.9;
          ctx.fillStyle = s === 0 ? star : c.node.tier === 'oort' ? ember : glow;
          ctx.beginPath();
          ctx.arc(x, y, (s === 0 ? 4 : 2.4) * (1 - s / 30), 0, Math.PI * 2);
          ctx.fill();
        }
        if (c.t > 0.92) {
          ctx.globalAlpha = (1 - c.t) * 8 * 0.5;
          ctx.strokeStyle = glow;
          ctx.beginPath();
          ctx.arc(cx, cy, cr * (1 + (c.t - 0.92) * 20), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointerdown', onMove);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <div className={`relative h-full w-full ${className}`}>
      <canvas
        ref={ref}
        className="h-full w-full"
        aria-label="Memories orbiting the Oort core. Click one to recall it."
      />
      {toast && (
        <div
          key={toast.key}
          className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap lg:left-auto lg:right-8 lg:translate-x-0 animate-rise rounded-full border border-border bg-card/80 px-4 py-2 font-mono text-xs text-foreground backdrop-blur"
        >
          <span className="text-photon-glow">●</span> {toast.text}
        </div>
      )}
    </div>
  );
}
