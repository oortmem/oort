import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';
import type { Tier } from '@oortmem/core';
import type { Env, Io } from './io.js';

/**
 * The one place human-facing output gets its look: the brand palette, a header line, aligned
 * key/value rows, tables, status symbols, coloured tier names and the spiral mark. Data output
 * (`--json`, `export`, hook stdout) never goes through here.
 */
export interface Ui {
  readonly color: boolean;
  /** 0 off, 1 sixteen colours, 2 the 256-colour palette, 3 truecolor. */
  readonly level: ColorLevel;
  bold(s: string): string;
  /** Secondary text: the muted brand grey (dim on a 16-colour terminal). */
  dim(s: string): string;
  /** Photon blue, the primary accent. */
  accent(s: string): string;
  /** Photon glow, the light cyan. */
  glow(s: string): string;
  /** Ember, the warm orange of the comet. */
  comet(s: string): string;
  violet(s: string): string;
  muted(s: string): string;
  success(s: string): string;
  warning(s: string): string;
  error(s: string): string;
  /** Kept for callers that name the colour: success, warning, error, glow. */
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
  /** `s` across the iris gradient (ember, glow, photon, violet); one colour on 16 colours. */
  gradient(s: string): string;
  /** `◉ oort` with the gradient; plain `oort` without colour. */
  wordmark(): string;
  /** `oort <title> · <detail> · …`, one line (`◉ oort …` in colour). */
  header(title: string, ...details: string[]): string;
  /** Rows of `key  value` with the keys padded to one width (keys muted in colour). */
  kv(rows: readonly (readonly [string, string])[], opts?: { indent?: number }): string;
  /** Left-aligned columns padded by visible width (colour codes do not count). */
  table(headers: string[], rows: string[][]): string;
  /** The tier glyph and name, coloured: `● hot`, `◐ warm`, `○ cold`. */
  tier(t: Tier): string;
  /** The tier name only, coloured. */
  tierName(t: Tier): string;
  /** `✓ s`, `! s`, `✗ s`, `• s`: the status symbol coloured, the text as is. */
  ok(s: string): string;
  warn(s: string): string;
  fail(s: string): string;
  info(s: string): string;
  /** A progress bar `━━━━───` of `width` cells; '' without colour. */
  bar(done: number, total: number, width?: number): string;
  /**
   * The spiral mark with `side` lines beside it, for the few moments that deserve it (help,
   * setup, a finished login). '' without colour or when stdout is not a terminal: callers
   * print their plain header instead.
   */
  mark(side?: readonly string[]): string;
}

export type ColorLevel = 0 | 1 | 2 | 3;
/** The terminal background, as far as `COLORFGBG` tells; dark when unknown. */
export type Theme = 'dark' | 'light';

export const TIER_GLYPH: Record<Tier, string> = { hot: '●', warm: '◐', cold: '○' };

/** Length as a terminal shows it: without colour escape codes. */
export const visibleLength = (s: string): number => stripVTControlCharacters(s).length;

const padEnd = (s: string, width: number): string =>
  s + ' '.repeat(Math.max(0, width - visibleLength(s)));

/**
 * Colour is on for a terminal unless `NO_COLOR` is set and non-empty
 * (https://no-color.org, which wins over everything) or `TERM=dumb`;
 * `FORCE_COLOR` turns it on (or off with `0`/`false`) whatever stdout is.
 */
export function colorEnabled(env: Env, isTTY: boolean): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false';
  if (env['TERM'] === 'dumb') return false;
  return isTTY;
}

/**
 * How many colours: 0 when colour is off (`colorEnabled`), 3 (truecolor) for
 * `COLORTERM=truecolor|24bit` or `FORCE_COLOR=3`, 2 for a `*-256color` TERM or
 * `FORCE_COLOR=2`, else 1 (the terminal's own 16 colours).
 */
export function colorLevel(env: Env, isTTY: boolean): ColorLevel {
  if (!colorEnabled(env, isTTY)) return 0;
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  const force = env['FORCE_COLOR'];
  if (colorterm === 'truecolor' || colorterm === '24bit' || force === '3') return 3;
  if (/-256(color)?$/i.test(env['TERM'] ?? '') || force === '2') return 2;
  return 1;
}

/** `COLORFGBG` (`fg;bg`, set by iTerm2, Konsole, rxvt…) with a light background (7, 9-15). */
export function themeOf(env: Env): Theme {
  const bg = Number((env['COLORFGBG'] ?? '').split(';').at(-1));
  return bg === 7 || (bg >= 9 && bg <= 15) ? 'light' : 'dark';
}

type Basic = 'blue' | 'cyan' | 'yellow' | 'magenta' | 'green' | 'red' | 'dim';
interface Swatch {
  dark: string;
  light: string;
  /** xterm 256-colour indices for the dark and light backgrounds. */
  x256: readonly [number, number];
  basic: Basic;
}
type Rgb = readonly [number, number, number];

/**
 * The oortcloud.dev tokens (oklch, converted to sRGB) for a dark background, a darker twin with
 * enough contrast (4:1 and up) on a light one, the nearest 256-colour indices, and the 16-colour
 * stand-in that follows the terminal's own theme.
 */
export const PALETTE = {
  photon: { dark: '#0095ff', light: '#0071e0', x256: [33, 26], basic: 'blue' }, // oklch(.66 .19 250)
  glow: { dark: '#49cffc', light: '#0086b3', x256: [81, 31], basic: 'cyan' }, // oklch(.80 .13 225), --hot
  ember: { dark: '#f8a13f', light: '#c26300', x256: [215, 166], basic: 'yellow' }, // oklch(.78 .15 65), --warm
  violet: { dark: '#a46bf5', light: '#7d40c8', x256: [141, 98], basic: 'magenta' }, // oklch(.65 .20 300)
  cold: { dark: '#93a6c5', light: '#4f6486', x256: [110, 60], basic: 'blue' }, // oklch(.72 .05 260), --cold
  muted: { dark: '#8e99ab', light: '#5f6a7b', x256: [246, 242], basic: 'dim' }, // oklch(.68 .03 260)
  success: { dark: '#61cb7c', light: '#1d7d3e', x256: [78, 28], basic: 'green' },
  warning: { dark: '#eebc4a', light: '#a66d00', x256: [221, 136], basic: 'yellow' },
  error: { dark: '#f75d59', light: '#cc272e', x256: [203, 160], basic: 'red' },
} as const satisfies Record<string, Swatch>;
type Token = keyof typeof PALETTE;

/** The site's iris gradient; the mark's dot cloud uses its cool end. */
const IRIS: readonly Token[] = ['ember', 'glow', 'photon', 'violet'];
const CLOUD: readonly Token[] = ['glow', 'photon', 'violet'];

const rgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** The nearest xterm 256-colour index: the 6×6×6 cube or the grey ramp. */
export function ansi256([r, g, b]: Rgb): number {
  const steps = [0, 95, 135, 175, 215, 255];
  const near = (v: number): number => {
    let best = 0;
    for (let i = 1; i < steps.length; i++) {
      if (Math.abs((steps[i] as number) - v) < Math.abs((steps[best] as number) - v)) best = i;
    }
    return best;
  };
  const [ci, cj, ck] = [near(r), near(g), near(b)];
  const cube: Rgb = [steps[ci] as number, steps[cj] as number, steps[ck] as number];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const dist = (c: Rgb): number => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  return dist(cube) <= dist([gv, gv, gv]) ? 16 + 36 * ci + 6 * cj + ck : 232 + grey;
}

const CLOSE = '\u001b[39m';

/** Wraps `s` in a foreground colour; an inner reset goes back to this colour, not the default. */
const fgWith =
  (open: string) =>
  (s: string): string =>
    s === '' ? '' : `${open}${s.split(CLOSE).join(CLOSE + open)}${CLOSE}`;

const openFor = (level: ColorLevel, c: Rgb): string =>
  level === 3 ? `\u001b[38;2;${c[0]};${c[1]};${c[2]}m` : `\u001b[38;5;${ansi256(c)}m`;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** The colour at `t` (0..1) along `stops`. */
const along = (stops: readonly Rgb[], t: number): Rgb => {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return mix(stops[i] as Rgb, stops[i + 1] as Rgb, x - i);
};

/**
 * The mark: a dotted spiral (Braille dots on four twisted rings), a photon core and the comet arc
 * with its head, after assets/brand/mark. `ZONES` colours each cell: 0-9 inner to outer along the
 * cool end of the iris gradient, `c` the core, `m` the comet's tail and `h` its head, in ember.
 */
const MARK = [
  '   ⠠⠐⢀⠁⡈⢀⠁⠐⢀',
  ' ⠠⠈⡀⠐ ⠄⠠ ⡀⠁⠄⠐',
  ' ⠂⠐ ⠌ ⠄⠂•⠳⡅⡀⠂⠈⡀',
  '⢈ ⡁⠐ ⠂ ● ⠐⡇⠄⢈ ⠄',
  ' ⠄⠠⠈⢀⠈⠠⣀⣄⡵⡓ ⠄⢀⠁',
  ' ⠐⢀⠐⢀⠈ ⠂⠐ ⠄⠈⠠',
  '   ⠐⠠ ⡁⢈ ⡁⠠⠈',
];
const ZONES = [
  '   996996999',
  ' 9966 33 3669',
  ' 96 3 00hmm3699',
  '9 63 0 c 0m36 9',
  ' 963300mmmm 699',
  ' 99663 33 669',
  '   99 99 999',
];
export const MARK_WIDTH = Math.max(...MARK.map((l) => [...l].length));

export interface UiOptions {
  theme?: Theme;
  /** stdout is a terminal: the mark is only drawn on one. */
  tty?: boolean;
}

/** `color`: a level, or true for the 16 colours and false for none. */
export function createUi(color: boolean | ColorLevel, opts: UiOptions = {}): Ui {
  const level: ColorLevel = color === true ? 1 : color === false ? 0 : color;
  const theme = opts.theme ?? 'dark';
  const c = pc.createColors(level > 0);
  const hex = (t: Token): Rgb => rgb(PALETTE[t][theme]);
  const paint = (t: Token): ((s: string) => string) =>
    level === 3
      ? fgWith(openFor(3, hex(t)))
      : level === 2
        ? fgWith(`\u001b[38;5;${PALETTE[t].x256[theme === 'dark' ? 0 : 1]}m`)
        : c[PALETTE[t].basic];
  const p = {
    photon: paint('photon'),
    glow: paint('glow'),
    ember: paint('ember'),
    violet: paint('violet'),
    cold: paint('cold'),
    muted: paint('muted'),
    success: paint('success'),
    warning: paint('warning'),
    error: paint('error'),
  };
  const iris = IRIS.map(hex);
  const cloud = CLOUD.map(hex);
  const gradient = (s: string): string => {
    if (level === 0) return s;
    if (level === 1) return p.photon(s);
    const chars = [...s];
    const n = Math.max(1, chars.length - 1);
    return chars
      .map((ch, i) => (ch === ' ' ? ch : fgWith(openFor(level, along(iris, i / n)))(ch)))
      .join('');
  };
  const tierColor: Record<Tier, (s: string) => string> = {
    hot: p.glow,
    warm: p.ember,
    cold: p.cold,
  };
  const wordmark = (): string =>
    level === 0 ? 'oort' : `${p.photon('◉')} ${c.bold(gradient('oort'))}`;
  const markCell = (ch: string, zone: string): string => {
    if (zone === 'c') return p.photon(ch);
    if (zone === 'm' || zone === 'h') return p.ember(ch);
    if (zone === ' ') return ch;
    if (level === 1) return p.photon(ch);
    return fgWith(openFor(level, along(cloud, Number(zone) / 9)))(ch);
  };
  const ui: Ui = {
    color: level > 0,
    level,
    bold: c.bold,
    dim: level >= 2 ? p.muted : c.dim,
    accent: p.photon,
    glow: p.glow,
    comet: p.ember,
    violet: p.violet,
    muted: level >= 2 ? p.muted : c.dim,
    success: p.success,
    warning: p.warning,
    error: p.error,
    green: p.success,
    yellow: p.warning,
    red: p.error,
    cyan: p.glow,
    gradient,
    wordmark,
    header: (title, ...details) =>
      level === 0
        ? `oort ${title}${details.map((d) => ` · ${d}`).join('')}\n`
        : `${wordmark()} ${c.bold(title)}${details.map((d) => ui.dim(` · ${d}`)).join('')}\n`,
    kv(rows, opts = {}) {
      const pad = ' '.repeat(opts.indent ?? 0);
      const width = Math.max(0, ...rows.map(([k]) => visibleLength(k)));
      return (
        rows
          .map(([k, v]) => `${pad}${padEnd(k === '' ? k : ui.dim(k), width)}  ${v}`.trimEnd())
          .join('\n') + '\n'
      );
    },
    table(headers, rows) {
      const widths = headers.map((h, i) =>
        Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))),
      );
      const line = (cells: string[]): string =>
        cells
          .map((cell, i) => (i === cells.length - 1 ? cell : padEnd(cell, widths[i] ?? 0)))
          .join('  ')
          .trimEnd();
      return [ui.dim(line(headers)), ...rows.map(line)].join('\n') + '\n';
    },
    tier: (t) => tierColor[t](`${TIER_GLYPH[t]} ${t}`),
    tierName: (t) => tierColor[t](t),
    ok: (s) => `${p.success('✓')} ${s}`,
    warn: (s) => `${p.warning('!')} ${s}`,
    fail: (s) => `${p.error('✗')} ${s}`,
    info: (s) => `${ui.dim('•')} ${s}`,
    bar(done, total, width = 24) {
      if (level === 0) return '';
      const filled = total <= 0 ? width : Math.round((Math.min(done, total) / total) * width);
      return `${p.photon('━'.repeat(filled))}${ui.dim('─'.repeat(width - filled))}`;
    },
    mark(side = []) {
      if (level === 0 || opts.tty !== true) return '';
      const top = Math.max(0, Math.floor((MARK.length - side.length) / 2));
      return (
        MARK.map((row, i) => {
          const glyphs = [...row];
          const zones = [...(ZONES[i] ?? '')];
          const art = glyphs.map((ch, j) => markCell(ch, zones[j] ?? ' ')).join('');
          const text = side[i - top];
          return text === undefined || text === ''
            ? art
            : `${art}${' '.repeat(MARK_WIDTH - glyphs.length + 4)}${text}`;
        }).join('\n') + '\n'
      );
    },
  };
  return ui;
}

/** The look for this run: colour from the environment and whether stdout is a terminal. */
export function uiFor(io: Io): Ui {
  const tty = io.stdoutIsTTY === true;
  return createUi(colorLevel(io.env, tty), { theme: themeOf(io.env), tty });
}
