import type { TranscriptImportProgress } from '@oortmem/claude-code';
import type { Io } from './io.js';
import { colorLevel, createUi, themeOf, visibleLength, type Ui } from './ui.js';

/**
 * `oort import claude-code`'s progress line (CON-107 item 7): one line on stderr, redrawn in
 * place, with what has been read or observed, the facts kept so far, the time taken and, once it
 * can tell, the time left. Only on a terminal: with `--json`, a stderr that is not a terminal or
 * `TERM=dumb` nothing is drawn at all (the estimate before and the summary after say it all).
 * `NO_COLOR` keeps the line and drops the bar.
 */
export interface ProgressLine {
  update(p: TranscriptImportProgress): void;
  /** Erases the line, so whatever is printed next starts on a clean one. */
  clear(): void;
}

/** Draws nothing. */
export const NO_PROGRESS: ProgressLine = { update: () => {}, clear: () => {} };

/** At most this often (10 redraws a second). */
export const REDRAW_MS = 100;
/** No time left is shown before a phase has run this long: the first items say little. */
const ETA_AFTER_MS = 2000;
/** Back to the start of the line and erase it. */
const ERASE = '\r\u001b[2K';

/** `42s`, `3m 05s`, `1h 02m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The line's text for `p`, `elapsed` ms in, with `left` ms to go when known. */
export function progressText(
  p: TranscriptImportProgress,
  elapsed: number,
  left: number | undefined,
  ui: Ui,
): string {
  const parts =
    p.phase === 'scan'
      ? [`reading ${p.files}/${p.totalFiles} transcripts`, `${p.turns} new turns`]
      : [
          `${p.done}/${p.total} turns`,
          `${p.kept} ${p.kept === 1 ? 'fact' : 'facts'} kept`,
          ...(p.failed > 0 ? [`${p.failed} failed`] : []),
        ];
  parts.push(duration(elapsed));
  if (left !== undefined) parts.push(`~${duration(left)} left`);
  const [done, total] = p.phase === 'scan' ? [p.files, p.totalFiles] : [p.done, p.total];
  const bar = ui.bar(done, total, 16);
  return `  ${bar === '' ? '' : `${bar} `}${parts.join(ui.dim(' · '))}`;
}

/**
 * A progress line that writes through `write` (stderr). `now` is the clock (tests pass a fake
 * one); `columns` the terminal's width, so the line never wraps (a wrapped line cannot be
 * redrawn in place).
 */
export function progressLine(opts: {
  write: (text: string) => void;
  ui: Ui;
  now?: () => number;
  columns?: () => number | undefined;
}): ProgressLine {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  let phase: TranscriptImportProgress['phase'] | undefined;
  let phaseStart = start;
  let lastEvent = start;
  let lastDraw = -Infinity;
  let drawn = false;
  return {
    update(p) {
      const t = now();
      if (p.phase !== phase) {
        // A phase starts where the previous event left off (observing starts as reading ends).
        phase = p.phase;
        phaseStart = lastEvent;
        lastDraw = -Infinity;
      }
      lastEvent = t;
      if (t - lastDraw < REDRAW_MS) return;
      lastDraw = t;
      const [done, total] = p.phase === 'scan' ? [p.files, p.totalFiles] : [p.done, p.total];
      const ran = t - phaseStart;
      const left =
        done > 0 && done < total && ran >= ETA_AFTER_MS ? (ran / done) * (total - done) : undefined;
      let text = progressText(p, t - start, left, opts.ui);
      const width = (opts.columns?.() ?? 80) - 1;
      if (visibleLength(text) > width) {
        // Too wide: the plain words without the bar, cut to fit.
        const plain = progressText(p, t - start, left, createUi(false));
        text = plain.length > width ? plain.slice(0, Math.max(0, width)) : plain;
      }
      opts.write(`${ERASE}${text}`);
      drawn = true;
    },
    clear() {
      if (!drawn) return;
      opts.write(ERASE);
      drawn = false;
      lastDraw = -Infinity;
    },
  };
}

/**
 * The import's progress line for this run: drawn on stderr when stderr is a terminal (not
 * `TERM=dumb`) and the run is not printing JSON, else nothing.
 */
export function importProgressFor(io: Io, json: boolean, now?: () => number): ProgressLine {
  if (json || io.stderrIsTTY !== true || io.env['TERM'] === 'dumb') return NO_PROGRESS;
  const ui = createUi(colorLevel(io.env, true), { theme: themeOf(io.env) });
  return progressLine({
    write: (t) => io.err(t),
    ui,
    ...(now !== undefined && { now }),
    ...(io.stderrColumns !== undefined && { columns: io.stderrColumns }),
  });
}
