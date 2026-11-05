import type * as Chrono from 'chrono-node';

/**
 * chrono-node, loaded only when a text may hold a date (CON-82). Importing it costs about
 * 95 ms, and a hook process pays that on every prompt; most prompts name no date, so the
 * temporal functions ask `mayHaveDateCue` first and treat a text without a cue as one chrono
 * finds nothing in.
 */

type ChronoModule = typeof Chrono;

const WEEKDAYS =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu|thurs?|fri|sat|sun|weekdays?|weekends?';
const MONTHS =
  'january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
const CASUAL =
  'today|tonight|tomorrow|tmrw?|yesterday|overmorrow|noon|midday|midnight|mornings?|afternoons?|evenings?|nights?|ago';
/** Time units, chrono's abbreviations included ("2h", "a few mins", "this am"). */
const UNITS =
  'sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?|hours?|days?|w(?:ee)?ks?|fortnights?|months?|mos?|quarters?|qtrs?|y(?:ea)?rs?|years?|decades?|[smhdwy]|a\\.?m|p\\.?m';
const ORDINAL =
  '(?:(?:twenty|thirty)[\\s-]?)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)|twenty|thirty';
/**
 * "May" the month, not the verb: chrono reads it with a day or ordinal near it, after "in",
 * before a comma or "of", or at the end of the text.
 */
const MAY = `in\\s+may|may\\s+(?:until|till|to|through)\\s+may|may\\s*(?:,|\\.\\s*\\d|of\\b|$|\\d|${ORDINAL})|(?:\\d|${ORDINAL})[\\s,]*(?:[a-z]+[\\s,]+)?may`;
const QUANTITY =
  'a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|several|couple|half|this|last|next|past|coming|previous|upcoming|within|in|for';
/** Words that make a following "now" a validity bound ("from now on", "until now"). */
const NOW_CUE =
  'until|till|through|thru|expires?|expiring|ends?|since|from|starting|starts|as\\s+of|effective|beginning|begins';

const CUES = [
  // Day and month names, also run into digits as chrono reads them ("17may", "sept11").
  `(?<![a-z])(?:${WEEKDAYS}|${MONTHS}|${CASUAL}|${MAY})(?![a-z])`,
  // "a week", "3 days", "a couple of days", "half an hour", "the end of the month".
  `\\b(?:\\d+|${QUANTITY})\\s+(?:[a-z]+\\s+){0,2}?(?:${UNITS})\\b`,
  // Times and dates: 17:30, 1/2, 2026-11-20, 12.5.2026, and "2026 11 3".
  '\\d\\s*[:/.?\\-]\\s*\\d',
  '\\d[\\s,]+\\d{1,2}[\\s,]+\\d',
  // Ranges, read as times: "6 to 8".
  '\\d\\s+to\\s+\\d',
  // Suffixed numbers: 5pm, 5 a, 24h, 30m, 1d, 3rd, 1990s, 5 o'clock, 5 a.m., 21 utc.
  `\\d\\s*(?:${UNITS}|a|st|nd|rd|th|o['’]?\\s*clock|utc|gmt)\\b`,
  // A bare number a preposition makes a time: "at 5", "from 9 to 5".
  '\\b(?:at|by|from|until|till|through|before|after|since|on|around|about|between)\\s*\\d',
  '\\bhalf\\s+a',
  `\\b(?:${NOW_CUE})\\s+(?:on\\s+)?(?:right\\s+)?now\\b`,
  // Quarters and halves: Q1, H2.
  '\\b[qh][1-4]\\b',
];
const CUE = new RegExp(CUES.join('|'), 'i');
/** A time with a zone abbreviation ("21 PST", "9 CEST"); upper case only, as zones are written. */
const ZONED = /\d\s*[A-Z]{1,4}T\b/;

/**
 * Whether `text` may hold a date or time expression chrono-node would read. False means
 * chrono reads none that the temporal functions act on (a bare "now" is the present, and
 * only counts after a bound word such as "from" or "until"). True may be a false alarm: that
 * only costs loading chrono.
 */
export function mayHaveDateCue(text: string): boolean {
  return CUE.test(text) || ZONED.test(text);
}

let chrono: ChronoModule | undefined;

/** Whether chrono-node has been loaded in this process. */
export function chronoLoaded(): boolean {
  return chrono !== undefined;
}

/**
 * Loads chrono-node ahead of need. Node never has to: the temporal functions load it
 * synchronously on first use. A bundled runtime without `require` (a Worker) awaits this once
 * at startup.
 */
export async function preloadChrono(): Promise<void> {
  chrono ??= await import('chrono-node');
}

/** chrono-node, loaded synchronously on first call. */
export function loadChrono(): ChronoModule {
  if (chrono !== undefined) return chrono;
  const mod = globalThis.process?.getBuiltinModule?.('node:module');
  if (mod === undefined) {
    throw new Error('chrono-node is not loaded: await preloadChrono() at startup');
  }
  chrono = mod.createRequire(import.meta.url)('chrono-node') as ChronoModule;
  return chrono;
}
