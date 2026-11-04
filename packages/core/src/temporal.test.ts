import { describe, expect, it } from 'vitest';
import { checkWriterDate, factInterval, temporalIntent } from './temporal.js';

// A Wednesday.
const AT = new Date('2026-11-04T10:00:00.000Z');

describe('factInterval', () => {
  it('temporal.until-a-weekday-ends-the-fact-after-that-day', () => {
    const r = factInterval('We use port 8080 until Friday.', AT);
    // Friday 2026-11-06 is included: the fact ends at the start of Saturday.
    expect(r.validTo).toBe('2026-11-07T00:00:00.000Z');
    expect(r.validFrom).toBeUndefined();
  });

  it('temporal.until-an-absolute-date', () => {
    expect(factInterval('The deploy freeze lasts until 2026-11-20.', AT).validTo).toBe(
      '2026-11-21T00:00:00.000Z',
    );
  });

  it('temporal.starting-next-week-starts-the-fact-later', () => {
    const r = factInterval('Starting next week the team moves the build to bun.', AT);
    expect(r.validFrom).toBe('2026-11-11T00:00:00.000Z');
    expect(r.validTo).toBeUndefined();
  });

  it('temporal.since-a-past-day-starts-the-fact-then', () => {
    expect(factInterval('Since last Monday the API deploys on fly.io.', AT).validFrom).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });

  it('temporal.a-plain-date-mention-sets-no-interval', () => {
    // A dated event, not a validity bound.
    expect(factInterval('On 2026-11-03 the team chose pnpm over yarn.', AT)).toEqual({});
    expect(factInterval('The service listens on port 8080.', AT)).toEqual({});
  });

  it('temporal.an-end-before-the-start-is-ignored', () => {
    expect(
      factInterval('Since 2026-12-01 we use bun until 2026-11-20.', AT).validTo,
    ).toBeUndefined();
  });
});

describe('checkWriterDate', () => {
  it('temporal.writer-date-matches-the-relative-day', () => {
    const r = checkWriterDate(
      'yesterday we switched the build to pnpm',
      'On 2026-11-03 the team switched the build to pnpm.',
      AT,
    );
    expect(r).toEqual({ text: 'On 2026-11-03 the team switched the build to pnpm.' });
  });

  it('temporal.a-wrong-writer-date-is-replaced-by-the-resolved-day', () => {
    const r = checkWriterDate(
      'yesterday we switched the build to pnpm',
      'On 2026-11-02 the team switched the build to pnpm.',
      AT,
    );
    expect(r.text).toBe('On 2026-11-03 the team switched the build to pnpm.');
    expect(r.fixed).toEqual({ from: '2026-11-02', to: '2026-11-03' });
  });

  it('temporal.ambiguous-cases-are-left-alone', () => {
    // Two relative expressions, or two dates in the fact: no single reading to check against.
    const two = checkWriterDate('yesterday and today we tested', 'On 2026-11-01 we tested.', AT);
    expect(two.fixed).toBeUndefined();
    const noRelative = checkWriterDate('on 2026-11-01 we tested', 'On 2026-11-02 we tested.', AT);
    expect(noRelative.fixed).toBeUndefined();
  });
});

describe('temporalIntent', () => {
  it('temporal.intent-defaults-to-current', () => {
    expect(temporalIntent('which port does the auth service listen on', AT)).toEqual({
      mode: 'current',
    });
    expect(temporalIntent('which port does it listen on now', AT).mode).toBe('current');
    // Chrono dates "this week" to its Monday; it still asks about the present.
    expect(temporalIntent('billing changes this week', AT)).toEqual({ mode: 'current' });
  });

  it('temporal.intent-strips-its-own-words-from-the-search-text', () => {
    expect(temporalIntent('which port did auth service 0 use on 2 April 2026', AT).text).toBe(
      'which port did auth service 0 use',
    );
    expect(temporalIntent('how has the auth port changed over time', AT).text).toBe(
      'how has the auth port',
    );
  });

  it('temporal.intent-history', () => {
    for (const q of [
      'how has the auth service port changed over time',
      'which ports did the auth service use before',
      'history of the build tool',
      'what did the team use previously for builds',
    ]) {
      expect(temporalIntent(q, AT).mode, q).toBe('history');
    }
  });

  it('temporal.intent-history-words-in-other-senses-stay-current', () => {
    for (const q of ['which script is used to deploy', 'git history cleanup script']) {
      expect(temporalIntent(q, AT).mode, q).toBe('current');
    }
    expect(temporalIntent('we used to deploy with fly', AT).mode).toBe('history');
  });

  it('temporal.intent-as-of-a-past-date', () => {
    const r = temporalIntent('which port did auth service 0 use on 2 April 2026', AT);
    expect(r.mode).toBe('as-of');
    expect(r.asOf).toBe('2026-04-02T23:59:59.999Z');
  });

  it('temporal.intent-a-month-only-date-is-the-past-one', () => {
    // chrono reads a bare "March" as the next one; a question about the past means the last one.
    const r = temporalIntent('which build tool did we use in March', AT);
    expect(r.mode).toBe('as-of');
    expect(r.asOf?.startsWith('2026-03')).toBe(true);
  });

  it('temporal.intent-known-at', () => {
    const r = temporalIntent('what did we believe the auth port was on 2026-04-02', AT);
    expect(r.mode).toBe('known-at');
    expect(r.knownAt).toBe('2026-04-02T23:59:59.999Z');
  });

  it('temporal.intent-a-bare-date-is-a-keyword-not-as-of', () => {
    expect(temporalIntent('2026-05-16 connection pooling tsup', AT)).toEqual({ mode: 'current' });
    expect(temporalIntent('2026-09-16', AT)).toEqual({ mode: 'current' });
    // A relative past day needs no preposition.
    expect(temporalIntent('what did we deploy yesterday', AT).mode).toBe('as-of');
  });

  it('temporal.intent-a-future-date-is-not-as-of', () => {
    expect(temporalIntent('which port will we use next Friday', AT).mode).toBe('current');
  });
});
