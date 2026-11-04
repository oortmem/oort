import { useId } from 'react';

export type FlowTone = 'agent' | 'oort' | 'remote' | 'store' | 'planned';

export interface FlowNode {
  label: string;
  /** A short second line under the label. A `\n` splits it into two lines. */
  sub?: string;
  tone?: FlowTone;
}

export interface FlowProps {
  /** Short name of the picture, read first by screen readers. */
  title: string;
  /** The whole picture in one or two sentences, so nothing is only visual. */
  desc: string;
  nodes: FlowNode[];
  /** Draw a dashed "Your machine" box around nodes `[first, last]`. */
  machine?: [number, number];
  /** One optional label per arrow: `edges[i]` sits between node i and node i + 1. */
  edges?: (string | undefined)[];
  /** Arrows that cannot connect, drawn dashed and crossed out. */
  blocked?: number[];
}

const stroke: Record<FlowTone, string> = {
  agent: 'var(--muted-foreground)',
  oort: 'var(--photon-glow)',
  remote: 'var(--ember)',
  store: 'var(--cold)',
  planned: 'var(--muted-foreground)',
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A left-to-right flow of labelled boxes, drawn twice: wide for desktop and stacked for
 * phones, so the text never shrinks below a readable size. CSS shows one of the two. Colours
 * come from the site's tokens, so the picture follows the theme.
 */
export function FlowDiagram(props: FlowProps) {
  return (
    <div className="my-8 rounded-2xl border border-border bg-card/40 p-4 sm:p-6">
      <Wide {...props} />
      <Tall {...props} />
    </div>
  );
}

function Wide(p: FlowProps) {
  const W = 760;
  const pad = 16;
  const n = p.nodes.length;
  const gap = p.edges?.some(Boolean) ? (n <= 2 ? 124 : 84) : 40;
  const w = Math.min(210, (W - 2 * pad - (n - 1) * gap) / n);
  const total = n * w + (n - 1) * gap;
  const x0 = (W - total) / 2;
  const h = 68;
  const y = 44;
  const boxes = p.nodes.map((_, i) => ({ x: x0 + i * (w + gap), y, w, h }));
  const H = y + h + 20;
  const machine = p.machine && {
    x: boxes[p.machine[0]]!.x - 12,
    y: 12,
    w: boxes[p.machine[1]]!.x + w - boxes[p.machine[0]]!.x + 24,
    h: h + 52,
  };
  return (
    <Svg {...p} viewBox={`0 0 ${W} ${H + (machine ? 4 : 0)}`} className="hidden w-full sm:block">
      {machine && <Machine box={machine} />}
      {boxes.slice(1).map((b, i) => {
        const a = boxes[i]!;
        const my = y + h / 2;
        return (
          <Arrow
            key={i}
            from={[a.x + a.w + 4, my]}
            to={[b.x - 4, my]}
            label={p.edges?.[i]}
            blocked={p.blocked?.includes(i) ?? false}
          />
        );
      })}
      {p.nodes.map((node, i) => (
        <Node key={i} node={node} box={boxes[i]!} />
      ))}
    </Svg>
  );
}

function Tall(p: FlowProps) {
  const W = 340;
  const w = 280;
  const x = (W - w) / 2;
  const h = 60;
  const gap = 44;
  const boxes: Box[] = [];
  let y = 12;
  let machine: Box | undefined;
  p.nodes.forEach((_, i) => {
    if (p.machine?.[0] === i) {
      machine = { x: x - 16, y, w: w + 32, h: 0 };
      y += 30;
    }
    boxes.push({ x, y, w, h });
    y += h;
    if (p.machine?.[1] === i && machine) {
      y += 14;
      machine.h = y - machine.y;
    }
    if (i < p.nodes.length - 1) y += gap;
  });
  const H = y + 12;
  return (
    <Svg {...p} viewBox={`0 0 ${W} ${H}`} className="mx-auto block w-full max-w-sm sm:hidden">
      {machine && <Machine box={machine} />}
      {boxes.slice(1).map((b, i) => {
        const a = boxes[i]!;
        return (
          <Arrow
            key={i}
            from={[W / 2, a.y + a.h + 4]}
            to={[W / 2, b.y - 4]}
            label={p.edges?.[i]}
            blocked={p.blocked?.includes(i) ?? false}
            vertical
          />
        );
      })}
      {p.nodes.map((node, i) => (
        <Node key={i} node={node} box={boxes[i]!} />
      ))}
    </Svg>
  );
}

function Svg({
  title,
  desc,
  viewBox,
  className,
  children,
}: FlowProps & { viewBox: string; className: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <svg
      role="img"
      aria-labelledby={`${id}-t ${id}-d`}
      viewBox={viewBox}
      className={`font-sans ${className}`}
    >
      <title id={`${id}-t`}>{title}</title>
      <desc id={`${id}-d`}>{desc}</desc>
      {children}
    </svg>
  );
}

function Machine({ box }: { box: Box }) {
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={18}
        style={{
          fill: 'color-mix(in oklab, var(--photon) 6%, transparent)',
          stroke: 'var(--photon-glow)',
          strokeDasharray: '6 5',
          strokeOpacity: 0.7,
        }}
      />
      <text
        x={box.x + 16}
        y={box.y + 20}
        style={{ fill: 'var(--photon-glow)', fontSize: 11, letterSpacing: '0.12em' }}
        className="font-mono"
      >
        YOUR MACHINE
      </text>
    </g>
  );
}

function Node({ node, box }: { node: FlowNode; box: Box }) {
  const tone = node.tone ?? 'agent';
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const lines = node.sub ? node.sub.split('\n') : [];
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={12}
        style={{
          fill: 'var(--card)',
          stroke: stroke[tone],
          strokeWidth: tone === 'oort' ? 1.75 : 1.25,
          strokeDasharray: tone === 'planned' ? '4 4' : undefined,
        }}
      />
      <text
        x={cx}
        y={cy + 5 - lines.length * 8}
        textAnchor="middle"
        style={{ fill: 'var(--foreground)', fontSize: 14, fontWeight: 600 }}
      >
        {node.label}
      </text>
      {lines.map((line, i) => (
        <text
          key={i}
          x={cx}
          y={cy + 13 - (lines.length - 1) * 7 + i * 15}
          textAnchor="middle"
          style={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function Arrow({
  from,
  to,
  label,
  blocked,
  vertical = false,
}: {
  from: [number, number];
  to: [number, number];
  label: string | undefined;
  blocked: boolean;
  vertical?: boolean;
}) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const color = blocked ? 'var(--destructive)' : 'var(--muted-foreground)';
  const head = vertical
    ? `M${x2 - 5} ${y2 - 7} L${x2} ${y2} L${x2 + 5} ${y2 - 7}`
    : `M${x2 - 7} ${y2 - 5} L${x2} ${y2} L${x2 - 7} ${y2 + 5}`;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g style={{ stroke: color, fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round' }}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={blocked ? '4 4' : undefined} />
      {!blocked && <path d={head} strokeLinejoin="round" />}
      {blocked && (
        <path d={`M${mx - 6} ${my - 6} L${mx + 6} ${my + 6} M${mx + 6} ${my - 6} L${mx - 6} ${my + 6}`} />
      )}
      {label && (
        <text
          x={vertical ? mx + 14 : x1 + 8}
          y={vertical ? my + 4 : my - 10}
          textAnchor="start"
          style={{ fill: blocked ? 'var(--destructive)' : 'var(--muted-foreground)', stroke: 'none', fontSize: 11 }}
          className="font-mono"
        >
          {label}
        </text>
      )}
    </g>
  );
}
