import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { MemoryWriter } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { fakeIo, harness, writeTranscript, type Harness } from '../test/helpers.js';
import { INTERRUPTED_EXIT, importCommand } from './commands/import.js';
import {
  NO_PROGRESS,
  duration,
  importProgressFor,
  progressLine,
  progressText,
} from './import-progress.js';
import { createKeychain } from './keychain.js';
import { flush, startOutput } from './output.js';
import { createUi } from './ui.js';
import type { Ctx } from './util.js';

/**
 * CON-107 item 7: `oort import claude-code` shows a progress line on stderr while it reads and
 * observes, on a terminal only. Every timing here runs on a fake clock.
 */

const ERASE = '\r\u001b[2K';
const plain = createUi(false);

/** A progress line on a fake clock, recording what it writes. */
function line(columns = 120) {
  let t = 0;
  const writes: string[] = [];
  const p = progressLine({
    write: (s) => void writes.push(s),
    ui: plain,
    now: () => t,
    columns: () => columns,
  });
  return {
    p,
    writes,
    at(ms: number) {
      t = ms;
    },
  };
}

const observe = (done: number, total = 100, kept = 0, failed = 0) =>
  ({ phase: 'observe', done, total, kept, failed }) as const;

describe('the import progress line', () => {
  it('progress.durations-read-as-people-say-them', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(42_400)).toBe('42s');
    expect(duration(185_000)).toBe('3m 05s');
    expect(duration(3_720_000)).toBe('1h 02m');
  });

  it('progress.counts-turns-facts-kept-failures-and-elapsed', () => {
    expect(
      progressText({ phase: 'scan', files: 3, totalFiles: 40, turns: 120 }, 1500, undefined, plain),
    ).toBe('  reading 3/40 transcripts · 120 new turns · 2s');
    expect(progressText(observe(340, 1200, 52, 2), 72_000, 250_000, plain)).toBe(
      '  340/1200 turns · 52 facts kept · 2 failed · 1m 12s · ~4m 10s left',
    );
    expect(progressText(observe(1, 9, 1), 0, undefined, plain)).toContain('1 fact kept');
  });

  it('progress.redraws-at-most-ten-times-a-second', () => {
    const l = line();
    for (let ms = 0; ms <= 1000; ms += 10) {
      l.at(ms);
      l.p.update(observe(ms / 10 + 1, 1000));
    }
    // 0, 100, …, 1000 ms: eleven draws for a hundred and one events.
    expect(l.writes).toHaveLength(11);
    expect(l.writes.every((w) => w.startsWith(ERASE))).toBe(true);
  });

  it('progress.shows-time-left-only-once-it-can-estimate', () => {
    const l = line();
    l.at(0);
    l.p.update({ phase: 'scan', files: 1, totalFiles: 1, turns: 10 });
    l.at(1000);
    l.p.update(observe(1, 10));
    expect(l.writes.at(-1)).not.toContain('left');
    // 4 of 10 after 2 s of observing: 500 ms each, 6 to go.
    l.at(2000);
    l.p.update(observe(4, 10));
    expect(l.writes.at(-1)).toContain('~3s left');
    // Nothing is left to estimate at the end.
    l.at(3000);
    l.p.update(observe(10, 10));
    expect(l.writes.at(-1)).not.toContain('left');
  });

  it('progress.never-wraps-and-clear-erases-only-what-it-drew', () => {
    const l = line(30);
    l.p.clear();
    expect(l.writes).toEqual([]);
    l.p.update(observe(340, 1200, 52));
    const text = l.writes[0]!.slice(ERASE.length);
    expect(text.length).toBeLessThanOrEqual(29);
    l.p.clear();
    expect(l.writes.at(-1)).toBe(ERASE);
  });

  it('progress.bar-in-colour-none-with-NO_COLOR', () => {
    const tty = { cwd: '/', stderrTTY: true };
    const draw = (env: Record<string, string>): string => {
      const io = fakeIo({ ...tty, env });
      importProgressFor(io, false, () => 0).update(observe(5, 10));
      return io.stderr;
    };
    expect(draw({ FORCE_COLOR: '1' })).toContain('━');
    const noColor = draw({ NO_COLOR: '1' });
    expect(noColor).toContain('5/10 turns');
    expect(noColor.replace(ERASE, '')).not.toContain('\u001b');
  });

  it('progress.nothing-with-json-a-pipe-or-a-dumb-terminal', () => {
    expect(importProgressFor(fakeIo({ cwd: '/', stderrTTY: true }), true)).toBe(NO_PROGRESS);
    expect(importProgressFor(fakeIo({ cwd: '/', stderrTTY: false }), false)).toBe(NO_PROGRESS);
    const dumb = fakeIo({ cwd: '/', stderrTTY: true, env: { TERM: 'dumb' } });
    expect(importProgressFor(dumb, false)).toBe(NO_PROGRESS);
  });
});

/** The harness with the synthetic transcript, and the import arguments for it. */
function withTranscript(h: Harness): string[] {
  const projects = `${h.root}/claude-projects`;
  writeTranscript(projects, h.cwd);
  return ['import', 'claude-code', '--projects-dir', projects, '--include-unresolved'];
}

describe('oort import claude-code: progress and Ctrl-C', () => {
  it('import.progress-on-a-terminal-cleared-before-the-summary', async () => {
    const h = harness();
    const args = withTranscript(h);
    const r = await h.run([...args, '--yes'], { tty: true, stderrTTY: true });
    expect(r.code, r.io.stderr).toBe(0);
    const seen = stripVTControlCharacters(r.io.stderr);
    expect(seen).toContain('reading 1/1 transcripts · 5 new turns');
    expect(seen).toMatch(/\d\/5 turns · \d facts? kept/);
    // The line is erased last, so the summary on stdout reads as it always has.
    expect(r.io.stderr.endsWith(ERASE)).toBe(true);
    expect(r.io.stdout).toMatch(/^Imported 5 observations: added 5\.$/m);
    expect(r.io.stdout).not.toContain('\r');
  });

  it('import.no-progress-without-a-terminal-or-with-json', async () => {
    const h = harness();
    const args = withTranscript(h);
    const piped = await h.run([...args, '--yes'], { tty: true, stderrTTY: false });
    expect(piped.code).toBe(0);
    expect(piped.io.stderr).not.toContain('\r');
    expect(piped.io.stderr).not.toContain('turns ·');

    const h2 = harness();
    const json = await h2.run([...withTranscript(h2), '--yes', '--json'], {
      tty: true,
      stderrTTY: true,
    });
    expect(json.code, json.io.stderr).toBe(0);
    expect(json.io.stderr).not.toContain('\r');
    const env = JSON.parse(json.io.stdout) as { data: { outcome: string } };
    expect(env.data.outcome).toBe('imported');
  });

  it('import.ctrl-c-stops-between-observations-exit-130-and-a-rerun-finishes', async () => {
    const h = harness();
    const args = withTranscript(h);
    const stop = new AbortController();
    // The first write is where Ctrl-C lands: that observation finishes, nothing after it starts.
    const base = h.wire;
    let writes = 0;
    h.wire = async (dir, o) => {
      const w = await base(dir, o);
      const write: MemoryWriter = {
        async write(...a) {
          writes++;
          stop.abort();
          return w.write!.write(...a);
        },
      };
      return { ...w, write };
    };
    const run = async (json: boolean) => {
      const io = fakeIo({ cwd: h.cwd, env: { HOME: h.root, OORT_HOME: h.home } });
      const ctx: Ctx = { io, wire: h.wire, keychain: createKeychain({ platform: 'none' }) };
      startOutput(ctx, 'import', json, json);
      const code = await importCommand(
        {
          projectsDir: args[3]!,
          includeUnresolved: true,
          yes: true,
          signal: stop.signal,
          clock: () => 0,
        },
        ctx,
      );
      flush(ctx, code);
      return { code, io };
    };
    const r = await run(true);
    expect(r.code).toBe(INTERRUPTED_EXIT);
    expect(writes).toBe(1);
    const env = JSON.parse(r.io.stdout) as {
      exitCode: number;
      data: { outcome: string; imported: { observations: number; notAttempted: number } };
      warnings: { code: string }[];
    };
    expect(env.exitCode).toBe(130);
    expect(env.data.outcome).toBe('interrupted');
    expect(env.data.imported).toMatchObject({ observations: 5, notAttempted: 4 });
    expect(env.warnings.map((w) => w.code)).toContain('interrupted');
    expect(r.io.stderr).toContain('Stopped by Ctrl-C: 4 observations were not attempted');

    // The cursor is past the one observation that finished: the rest, once each.
    expect(r.io.stderr).toContain('Imported 1 of 5 observations: added 1.');
    expect(await h.store.list(TG, {})).toHaveLength(1);
    const again = await h.run([...args, '--yes'], { tty: true });
    expect(again.code, again.io.stderr).toBe(0);
    expect(again.io.stdout).toContain('Imported 4 observations: added 4.');
  });
});
