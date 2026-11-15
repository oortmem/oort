import { describe, expect, it } from 'vitest';
import {
  checkOccurrences,
  formatRange,
  MAX_OCCURRENCE_DAYS,
  occurrencesOf,
  queryRange,
  type Occurrence,
} from './event-time.js';
import { temporalIntent, timeShape } from './temporal.js';

// A Monday.
const NOW = new Date('2023-05-22T10:00:00.000Z');
const day = (d: string) => `${d}T00:00:00.000Z`;

describe('queryRange: the past time a query names', () => {
  const cases: [string, string, string, string][] = [
    ['What did I do last weekend?', '2023-05-20', '2023-05-22', 'last weekend'],
    ['Where did I go in March?', '2023-03-01', '2023-04-01', 'March'],
    ['What did I buy two weeks ago?', '2023-05-08', '2023-05-15', 'two weeks ago'],
    ['What concerts did I go to in 2022?', '2022-01-01', '2023-01-01', 'in 2022'],
    ['What did we deploy yesterday?', '2023-05-21', '2023-05-22', 'yesterday'],
    ['What happened on 2 April?', '2023-04-02', '2023-04-03', 'on 2 April'],
    [
      'Which cafe did I try the past two months?',
      '2023-03-22',
      '2023-05-23',
      'the past two months',
    ],
    ['What did I do last summer?', '2022-06-01', '2022-09-01', 'last summer'],
    ['What did I read since March?', '2023-03-01', '2023-05-23', 'March'],
    ['How many weddings did I attend this year?', '2023-01-01', '2023-05-23', 'this year'],
    ['What did I do earlier this month?', '2023-05-01', '2023-05-23', 'earlier this month'],
    [
      'What did I do between April 3 and April 10?',
      '2023-04-03',
      '2023-04-11',
      'April 3 and April 10',
    ],
    ['Where was I a few days ago?', '2023-05-18', '2023-05-21', 'a few days ago'],
    // Through the end's own month.
    [
      'How many concerts did I attend from January to March?',
      '2023-01-01',
      '2023-04-01',
      'January to March',
    ],
  ];
  for (const [q, from, to, text] of cases) {
    it(`range.${q}`, () => {
      expect(queryRange(q, NOW)).toMatchObject({ from: day(from), to: day(to), text });
    });
  }

  it('range.widened-to-what-it-names-not-a-point', () => {
    // "in March" is the month, not its last instant: the old read asked as-of 31 March only.
    expect(queryRange('Where did I go in March?', NOW)?.precision).toBe('month');
    expect(queryRange('What did we deploy yesterday?', NOW)?.precision).toBe('day');
    expect(queryRange('What concerts did I go to in 2022?', NOW)?.precision).toBe('year');
    expect(queryRange('What did I read since March?', NOW)?.precision).toBe('span');
  });

  it('range.a-month-ahead-means-the-last-one', () => {
    // Asked in May, "in November" is last November.
    expect(queryRange('What did I cook in November?', NOW)).toMatchObject({
      from: day('2022-11-01'),
      to: day('2022-12-01'),
    });
  });

  it('range.none-for-the-present-the-future-or-a-bare-date', () => {
    for (const q of [
      'what port did we move auth to?',
      'What is my plan for next Friday?',
      'What changed this week?',
      'What did we discuss about 2026-05-16 pooling?',
      'what is the plan today',
      'how do I fix the March release build',
      'I am planning another theme park weekend; do you have any suggestions?',
      // Relative to an event the question names, not to today.
      "What time did I go to bed on the day before my doctor's appointment?",
    ]) {
      expect(queryRange(q, NOW), q).toBeUndefined();
    }
  });
});

describe('timeShape: what a query asks about its time', () => {
  const shapes: [string, string][] = [
    ['What did I do last weekend?', 'range'],
    ['How many weddings did I attend this year?', 'count'],
    ['How long did my trip in April last?', 'duration'],
    ['Which came first, the move or the new job in January?', 'order'],
    ['What did I do earlier this month?', 'range'],
    ['What car did I own in 2021?', 'state'],
    ['Which build tool did we use in March?', 'state'],
    ['What was my salary in 2022?', 'state'],
    ['What was the restaurant I went to last weekend?', 'range'],
    ['what port did auth use as of 2 April?', 'state'],
    ['on 8 February, which port did media-proxy-2 listen on', 'state'],
    ['What album did I listen to last weekend?', 'range'],
    // Events, though they read like states: a passive, an "earn", a "work" that is not the verb.
    ['How many babies were born to friends in the last few months?', 'count'],
    ['How much cashback did I earn at the store last Thursday?', 'range'],
    ['How many fun runs did I miss in March due to work commitments?', 'count'],
  ];
  for (const [q, shape] of shapes) {
    it(`shape.${q}`, () => {
      const r = queryRange(q, NOW);
      expect(r, q).toBeDefined();
      expect(timeShape(q, r!.text)).toBe(shape);
    });
  }

  it('shape.only-a-state-reads-as-of', () => {
    expect(temporalIntent('What car did I own in 2021?', NOW)).toEqual({
      mode: 'as-of',
      asOf: '2021-12-31T23:59:59.999Z',
      range: { from: day('2021-01-01'), to: day('2022-01-01'), precision: 'year' },
      shape: 'state',
      text: 'What car did I own ?',
    });
    // An event question keeps the current view and every word: the range ranks, never filters.
    expect(temporalIntent('Where did I go in March?', NOW)).toEqual({
      mode: 'current',
      range: { from: day('2023-03-01'), to: day('2023-04-01'), precision: 'month' },
      shape: 'range',
    });
    expect(temporalIntent('what port did we move auth to?', NOW)).toEqual({ mode: 'current' });
  });
});

describe('occurrencesOf: when what a memory tells of happened', () => {
  const mention: Occurrence = {
    from: day('2023-05-22'),
    to: day('2023-05-23'),
    precision: 'day',
    source: 'mention',
  };
  const cases: [string, Occurrence[]][] = [
    [
      'I went hiking with Sam last weekend.',
      [{ from: day('2023-05-20'), to: day('2023-05-22'), precision: 'span', source: 'relative' }],
    ],
    [
      'We got married on March 4, 2021.',
      [{ from: day('2021-03-04'), to: day('2021-03-05'), precision: 'day', source: 'explicit' }],
    ],
    [
      'I started the new job two weeks ago.',
      [{ from: day('2023-05-08'), to: day('2023-05-15'), precision: 'week', source: 'relative' }],
    ],
    [
      'We were in Lisbon from April 3 to April 10.',
      [{ from: day('2023-04-03'), to: day('2023-04-11'), precision: 'span', source: 'explicit' }],
    ],
    [
      'Back in 2019 I lived in Oslo.',
      [{ from: day('2019-01-01'), to: day('2020-01-01'), precision: 'year', source: 'explicit' }],
    ],
    [
      'Last summer I painted the fence.',
      [{ from: day('2022-06-01'), to: day('2022-09-01'), precision: 'span', source: 'relative' }],
    ],
    // A plan says when it will happen: the coming March, not the last one.
    [
      'I am going to Japan in March.',
      [{ from: day('2024-03-01'), to: day('2024-04-01'), precision: 'month', source: 'explicit' }],
    ],
    // No date: only the day it was said.
    ['The port is 8080.', []],
    // A duration is not a date.
    ['The meeting lasted for 10 minutes.', []],
    // Weekdays as a schedule, not as days that happened.
    ['Monday: rest day. Tuesday: run. Wednesday: swim. Thursday: rest.', []],
  ];
  for (const [text, stated] of cases) {
    it(`occurred.${text}`, () => {
      expect(occurrencesOf(text, NOW)).toEqual([...stated, mention]);
    });
  }

  it('occurred.read-against-the-time-it-was-written-not-today', () => {
    // A session from a year earlier: "last weekend" is that session's weekend.
    const then = new Date('2022-05-23T09:00:00.000Z');
    expect(occurrencesOf('I went hiking last weekend.', then)[0]).toMatchObject({
      from: day('2022-05-21'),
      to: day('2022-05-23'),
    });
  });

  it('occurred.in-the-writers-utc-offset', () => {
    // 23:30 on the 21st in UTC is already the 22nd at +02:00: the mention day is the writer's.
    const late = new Date('2023-05-21T23:30:00.000Z');
    expect(occurrencesOf('noted', late, 120).at(-1)).toEqual({
      from: '2023-05-21T22:00:00.000Z',
      to: '2023-05-22T22:00:00.000Z',
      precision: 'day',
      source: 'mention',
    });
  });

  it('occurred.what-it-produces-passes-the-check', () => {
    for (const [text] of cases) expect(checkOccurrences(occurrencesOf(text, NOW))).toBeTruthy();
  });
});

describe('checkOccurrences', () => {
  const ok: Occurrence = {
    from: day('2023-05-20'),
    to: day('2023-05-22'),
    precision: 'span',
    source: 'relative',
  };
  it('check.accepts-what-a-store-writes', () => {
    expect(checkOccurrences([ok])).toEqual([ok]);
    expect(checkOccurrences([])).toEqual([]);
  });
  it('check.refuses-bad-shapes', () => {
    const bad: unknown[] = [
      'x',
      [null],
      [{ ...ok, extra: 1 }],
      [{ ...ok, from: '2023-05-20' }],
      [{ ...ok, to: ok.from }],
      [
        {
          ...ok,
          to: new Date(Date.parse(ok.from) + (MAX_OCCURRENCE_DAYS + 1) * 86_400_000).toISOString(),
        },
      ],
      [{ ...ok, precision: 'hour' }],
      [{ ...ok, source: 'model' }],
      Array.from({ length: 10 }, () => ok),
    ];
    for (const b of bad) expect(() => checkOccurrences(b), JSON.stringify(b)).toThrow(RangeError);
  });
});

describe('formatRange', () => {
  it('format.as-a-reader-sees-it', () => {
    expect(formatRange({ from: day('2023-05-20'), to: day('2023-05-21'), precision: 'day' })).toBe(
      '2023-05-20',
    );
    expect(
      formatRange({ from: day('2023-03-01'), to: day('2023-04-01'), precision: 'month' }),
    ).toBe('2023-03');
    expect(formatRange({ from: day('2019-01-01'), to: day('2020-01-01'), precision: 'year' })).toBe(
      '2019',
    );
    expect(formatRange({ from: day('2023-05-20'), to: day('2023-05-22'), precision: 'span' })).toBe(
      '2023-05-20 to 2023-05-21',
    );
  });
});

describe('cost on long text', () => {
  it('parse.a-megabyte-of-dates-stays-cheap', () => {
    // Text full of dates must not cost more than a few milliseconds per kilobyte: the write path
    // and the store migration read it inside a transaction. Generous bound: the machine may be busy.
    const big = 'last week 2023-05-01 '.repeat(50_000);
    expect(big.length).toBeGreaterThan(1_000_000);
    occurrencesOf('warm up chrono on 2023-05-01', NOW);
    const t = performance.now();
    const o = occurrencesOf(big, NOW);
    const q = queryRange(`what did I do ${big}`, NOW);
    expect(performance.now() - t).toBeLessThan(200);
    expect(o.length).toBeGreaterThan(1);
    expect(q).toBeDefined();
  });

  it('parse.an-unreadable-time-places-nothing', () => {
    expect(occurrencesOf('I went hiking last weekend', new Date(Number.NaN))).toEqual([]);
    expect(queryRange('what did I do last weekend', new Date(Number.NaN))).toBeUndefined();
  });
});
