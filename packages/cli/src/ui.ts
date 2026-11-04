import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';
import type { Tier } from '@oortmem/core';
import type { Env, Io } from './io.js';

/**
 * The one place human-facing output gets its look: a header line, aligned
 * key/value rows, tables and coloured tier names. Data output (`--json`,
 * `export`, hook stdout) never goes through here.
 */
export interface Ui {
  readonly color: boolean;
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
  /** `oort <title> · <detail> · …`, one line. */
  header(title: string, ...details: string[]): string;
  /** Rows of `key  value` with the keys padded to one width. */
  kv(rows: readonly (readonly [string, string])[], opts?: { indent?: number }): string;
  /** Left-aligned columns padded by visible width (colour codes do not count). */
  table(headers: string[], rows: string[][]): string;
  /** The tier glyph and name, coloured: `● hot`, `◐ warm`, `○ cold`. */
  tier(t: Tier): string;
  /** The tier name only, coloured. */
  tierName(t: Tier): string;
  ok(s: string): string;
  warn(s: string): string;
}

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

export function createUi(color: boolean): Ui {
  const c = pc.createColors(color);
  const tierColor: Record<Tier, (s: string) => string> = {
    hot: c.cyan,
    warm: c.yellow,
    cold: c.blue,
  };
  const ui: Ui = {
    color,
    bold: c.bold,
    dim: c.dim,
    green: c.green,
    yellow: c.yellow,
    red: c.red,
    cyan: c.cyan,
    header: (title, ...details) =>
      `${c.bold(`oort ${title}`)}${details.map((d) => c.dim(` · ${d}`)).join('')}\n`,
    kv(rows, opts = {}) {
      const pad = ' '.repeat(opts.indent ?? 0);
      const width = Math.max(0, ...rows.map(([k]) => visibleLength(k)));
      return rows.map(([k, v]) => `${pad}${padEnd(k, width)}  ${v}`.trimEnd()).join('\n') + '\n';
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
      return [c.dim(line(headers)), ...rows.map(line)].join('\n') + '\n';
    },
    tier: (t) => tierColor[t](`${TIER_GLYPH[t]} ${t}`),
    tierName: (t) => tierColor[t](t),
    ok: (s) => `${c.green('✓')} ${s}`,
    warn: (s) => `${c.yellow('!')} ${s}`,
  };
  return ui;
}

/** The look for this run: colour from the environment and whether stdout is a terminal. */
export function uiFor(io: Io): Ui {
  return createUi(colorEnabled(io.env, io.stdoutIsTTY === true));
}
