import * as fs from 'node:fs';
import * as path from 'node:path';
import * as chrono from 'chrono-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mayHaveDateCue } from './date-cue.js';

// A Wednesday, as in temporal.test.ts.
const AT = new Date('2026-11-04T10:00:00.000Z');

/** Text that has to load chrono. */
const POSITIVES = [
  'We use port 8080 until Friday.',
  'what did we deploy yesterday',
  'what ships on December 1',
  'which build tool did we use in March',
  'standup at 5',
  'meet at 5pm',
  'the job runs at 17:30',
  'released 2026-11-03',
  'due 3/11/2026',
  'due 12.5.2026',
  'in a few hours',
  'a couple of days ago',
  'half an hour',
  'two weeks',
  'retry in 24h',
  'took 30m',
  'next mon',
  'past week',
  'this weekend',
  'this morning',
  'tonight',
  'tmrw',
  'in the 1990s',
  "at 5 o'clock",
  'what was the plan in May',
  'May 5',
  'the 5 May release',
  'May first',
  'May 2026',
  'the call is 21 PST',
  '17may',
  'sept11',
  'pages 6 to 8',
  'in a day or so',
];

/** Prompt-shaped text with no date: chrono stays unloaded. */
const NEGATIVES = [
  'which port does the auth service listen on',
  'fix the failing test in recall.ts',
  'refactor the loader so it streams the file',
  'you may need to update the docs too',
  'this may break the build, so add a test',
  'which script is used to deploy',
  'git history cleanup script',
  'how has the auth service port changed over time',
  'what did the auth port used to be',
  'fix the test, the config changed',
  'which port does it listen on now',
  'now run the linter',
  'bump the dependency',
  'port 8080 is taken',
  'upgrade to node 22',
  'set the charset to utf-8',
  'see file.ts line 12',
  'use sha256 for the digest',
  'move the summary into the decision record',
  'the doctor command should check common mistakes',
  'last step: next, open a PR',
];

/** "Now" after a bound word: chrono reads the present, which bounds a fact ("from now on"). */
const NOW_BOUNDS = [
  'from now on we use pnpm',
  'that was true until now',
  'as of right now we use bun',
];

/** Cues chrono reads nothing in: each costs only loading chrono. */
const FALSE_ALARMS = [
  'install v2.10.3 of chrono',
  'the second test is flaky',
  'on the 21st',
  // Quarters and halves: chrono reads none today; kept so a version that does is covered.
  'Q1 targets',
  'H2 roadmap',
];

describe('mayHaveDateCue', () => {
  it.each(POSITIVES)('date-cue.positive: %s', (text) => {
    expect(mayHaveDateCue(text)).toBe(true);
  });

  it.each([...NOW_BOUNDS, ...FALSE_ALARMS])('date-cue.positive: %s', (text) => {
    expect(mayHaveDateCue(text)).toBe(true);
  });

  it.each(NEGATIVES)('date-cue.negative: %s', (text) => {
    expect(mayHaveDateCue(text)).toBe(false);
  });

  it('date-cue.positives-are-dates-chrono-reads', () => {
    // The table is honest: chrono reads something in each positive.
    for (const text of POSITIVES) {
      expect(readable(text), text).toBe(true);
    }
  });

  it('date-cue.negatives-and-false-alarms-are-text-chrono-reads-nothing-in', () => {
    for (const text of [...NEGATIVES, ...FALSE_ALARMS]) expect(readable(text), text).toBe(false);
  });

  it('date-cue.every-temporal-test-phrase-with-a-date-is-a-cue', () => {
    const phrases = literals('temporal.test.ts');
    expect(phrases.length).toBeGreaterThan(50);
    const dated = phrases.filter(readable);
    expect(dated.length).toBeGreaterThan(30);
    for (const text of dated) expect(mayHaveDateCue(text), text).toBe(true);
  });

  it('date-cue.no-misses-across-the-test-and-eval-corpus', () => {
    for (const text of corpus()) {
      if (readable(text)) expect(mayHaveDateCue(text), text).toBe(true);
    }
  });
});

describe('lazy chrono (CON-82)', () => {
  afterEach(() => {
    vi.doUnmock('./date-cue.js');
    vi.resetModules();
  });

  it('date-cue.date-free-text-never-loads-chrono', async () => {
    vi.resetModules();
    const cue = await import('./date-cue.js');
    const t = await import('./temporal.js');
    expect(cue.chronoLoaded()).toBe(false);
    expect(t.temporalIntent('which port does the auth service listen on', AT)).toEqual({
      mode: 'current',
    });
    expect(t.temporalIntent('which port does it listen on now', AT).mode).toBe('current');
    expect(t.factInterval('The service listens on port 8080.', AT)).toEqual({});
    expect(t.checkWriterDate('we moved to pnpm', 'On 2026-11-03 we moved to pnpm.', AT)).toEqual({
      text: 'On 2026-11-03 we moved to pnpm.',
    });
    expect(cue.chronoLoaded()).toBe(false);

    expect(t.temporalIntent('what did we deploy yesterday', AT).mode).toBe('as-of');
    expect(cue.chronoLoaded()).toBe(true);
  });

  it('date-cue.results-match-chrono-on-every-text (equivalence)', async () => {
    vi.resetModules();
    const lazy = await import('./temporal.js');
    // The reference: the same functions with the prefilter switched off, so chrono reads all.
    vi.resetModules();
    vi.doMock('./date-cue.js', async (original) => ({
      ...(await original<typeof import('./date-cue.js')>()),
      mayHaveDateCue: () => true,
    }));
    const eager = await import('./temporal.js');
    const ny = new Date('2026-11-05T04:30:00.000Z');
    let compared = 0;
    for (const text of corpus()) {
      expect(lazy.temporalIntent(text, AT), text).toEqual(eager.temporalIntent(text, AT));
      expect(lazy.factInterval(text, AT), text).toEqual(eager.factInterval(text, AT));
      expect(lazy.factInterval(text, ny, -300), text).toEqual(eager.factInterval(text, ny, -300));
      const fact = 'On 2026-11-02 the team switched the build to pnpm.';
      expect(lazy.checkWriterDate(text, fact, AT), text).toEqual(
        eager.checkWriterDate(text, fact, AT),
      );
      compared++;
    }
    expect(compared).toBeGreaterThan(200);
  });
});

/** chrono reads a date in `text`, a bare "now" (the present) aside. */
function readable(text: string): boolean {
  const ref = { instant: AT, timezone: 0 };
  return [
    ...chrono.parse(text, ref, { forwardDate: false }),
    ...chrono.parse(text, ref, { forwardDate: true }),
  ].some((r) => !/^(right\s+)?now$/i.test(r.text));
}

/** The string literals of a test file in this directory, test names aside. */
function literals(file: string): string[] {
  const src = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g)) {
    const text = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
    if (text.length < 3 || /^[a-z-]+\.[a-z0-9-]+/.test(text)) continue;
    out.add(text);
  }
  return [...out];
}

/** Every phrase the temporal, observe and recall tests and the eval fixture use, and the tables. */
function corpus(): string[] {
  const fixture = fs
    .readFileSync(path.join(import.meta.dirname, '../../bench/eval/fixture.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { question: string }).question);
  return [
    ...new Set([
      ...literals('temporal.test.ts'),
      ...literals('observe.test.ts'),
      ...literals('recall.test.ts'),
      ...fixture,
      ...POSITIVES,
      ...NEGATIVES,
      ...NOW_BOUNDS,
      ...FALSE_ALARMS,
      'until right now the API was frozen',
      'now we use bun',
    ]),
  ];
}
