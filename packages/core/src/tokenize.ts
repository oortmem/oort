/**
 * The lexical tokeniser every store uses, so all stores agree on what a token is: the SQLite and
 * in-memory stores, Oort Cloud's store, the relevance gate's word coverage, the lexical-first
 * skip and write-path reinforcement all call `tokenizeLexical`.
 *
 * Version 2 (CON-110, design §5.1) is script-aware. For plain English it gives exactly the
 * tokens version 1 gave, so English recall does not change. For each text:
 *
 * 1. NFKC, then lowercase: full-width `ＡＰＩ` becomes `api`, decomposed accents compose.
 * 2. Split on anything that is not a letter, combining mark, digit, `-`, `_` or `.`, and trim
 *    those joiners from token ends: `auth-service-8080` stays one token, `8080.` becomes `8080`.
 *    Combining marks stay inside words, so Devanagari and Thai words are no longer cut apart.
 * 3. Split each token into script runs. CJK runs (Han, Hiragana, Katakana, Hangul) become
 *    overlapping bigrams (a one-character run stays a unigram). Thai, Lao, Khmer and Myanmar runs
 *    are split into words by `Intl.Segmenter` (character bigrams when it is missing). Other runs
 *    stay whole.
 * 4. Latin letters lose their diacritics (`autenticación` matches `autenticacion`); marks in
 *    every other script are vowels, not accents, and stay.
 */
export function tokenizeLexical(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (PLAIN.test(w)) {
      out.push(w); // the common case: nothing script-specific to do
      continue;
    }
    for (const run of scriptRuns(w)) emitRun(run, out);
  }
  return out;
}

/** One word of a text: a token, or every bigram of one CJK run (`cjk`). */
export interface LexicalUnit {
  tokens: string[];
  cjk: boolean;
}

/**
 * `tokenizeLexical`'s tokens grouped into words: each token on its own, except that the bigrams
 * of one CJK run stay together. Word coverage (`queryCoverage`) weighs a CJK run as one word, as
 * version 1 did, so a question's many bigrams do not outweigh an identifier it names.
 */
export function tokenizeLexicalUnits(text: string): LexicalUnit[] {
  const units: LexicalUnit[] = [];
  for (const w of words(text)) {
    if (PLAIN.test(w)) {
      units.push({ tokens: [w], cjk: false });
      continue;
    }
    for (const run of scriptRuns(w)) {
      const out: string[] = [];
      emitRun(run, out);
      if (run.kind === 'cjk') units.push({ tokens: out, cjk: true });
      else for (const t of out) units.push({ tokens: [t], cjk: false });
    }
  }
  return units;
}

/** Steps 1 and 2: the normalised text split into words, joiners trimmed, empties dropped. */
function words(text: string): string[] {
  // ASCII is already NFKC: skip the normalisation passes.
  const norm = ASCII.test(text)
    ? text.toLowerCase()
    : text.normalize('NFKC').toLowerCase().normalize('NFC');
  const out: string[] = [];
  for (const word of norm.split(WORD_SEPARATOR)) {
    const w = trimJoiners(word);
    if (w.length > 0) out.push(w);
  }
  return out;
}

/**
 * The tokeniser's version. Stores record it beside their lexical index and rebuild the index
 * when it changes (store-sqlite schema version 4; Oort Cloud's batched rebuild).
 */
export const LEXICAL_VERSION = 2;

/**
 * Version 1, kept for indexes built before version 2: a store downgraded to an older schema
 * rebuilds its index with it, and a store still rebuilding (Oort Cloud, design §14) searches
 * the not-yet-rebuilt rows with it. Lowercase, split on anything that is not a letter, digit,
 * `-`, `_` or `.`, then trim those joiners from token ends.
 */
export function tokenizeLexicalV1(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}\-_.]+/u)
    .map((t) => t.replace(/^[-_.]+|[-_.]+$/g, ''))
    .filter((t) => t.length > 0);
}

/** The tokeniser for an index built at `version` (1 or 2). */
export function tokenizerForVersion(version: number): (text: string) => string[] {
  return version === 1 ? tokenizeLexicalV1 : tokenizeLexical;
}

const ASCII = /^\p{ASCII}*$/u;

const WORD_SEPARATOR = /[^\p{L}\p{M}\p{N}\-_.]+/u;

const trimJoiners = (t: string): string => t.replace(/^[-_.]+|[-_.]+$/g, '');

/** Letters, digits and joiners only from scripts that need nothing more than v1 did. */
const PLAIN = /^[a-z0-9\-_.]+$/;

/**
 * Han, Hiragana, Katakana and Hangul, by `Script_Extensions` so that the prolonged sound mark
 * `ー` and the iteration marks count as CJK.
 */
const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;
/** Scripts written without spaces between words that have no bigram tradition. */
const SEA = /[\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;

type RunKind = 'cjk' | 'sea' | 'other';

/**
 * Splits a token into runs of one kind. A combining mark joins the run of the character before
 * it. A CJK or Southeast Asian run holds letters and marks only, so digits and joiners (`8080`
 * in `ポート8080を`) form their own runs.
 */
function scriptRuns(token: string): { kind: RunKind; text: string }[] {
  const runs: { kind: RunKind; text: string }[] = [];
  let kind: RunKind | undefined;
  let text = '';
  for (const ch of token) {
    let k: RunKind;
    if (MARK.test(ch) && kind !== undefined) k = kind;
    else if (LETTER.test(ch) && CJK.test(ch)) k = 'cjk';
    else if ((LETTER.test(ch) || MARK.test(ch)) && SEA.test(ch)) k = 'sea';
    else k = 'other';
    if (k !== kind && text.length > 0) {
      runs.push({ kind: kind as RunKind, text });
      text = '';
    }
    kind = k;
    text += ch;
  }
  if (text.length > 0) runs.push({ kind: kind as RunKind, text });
  return runs;
}

function emitRun(run: { kind: RunKind; text: string }, out: string[]): void {
  if (run.kind === 'cjk') {
    bigrams(run.text, out);
    return;
  }
  if (run.kind === 'sea') {
    segmentWords(run.text, out);
    return;
  }
  const t = trimJoiners(foldLatin(run.text));
  if (t.length > 0) out.push(t);
}

/** Overlapping character bigrams; a one-character run stays a unigram. */
function bigrams(text: string, out: string[]): void {
  const chars = [...text];
  if (chars.length === 1) {
    out.push(text);
    return;
  }
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
}

let segmenter: Intl.Segmenter | null | undefined;

/** Dictionary word segmentation (ICU), or character bigrams where `Intl.Segmenter` is missing. */
function segmentWords(text: string, out: string[]): void {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('und', { granularity: 'word' })
        : null;
  }
  if (segmenter === null) {
    // Whole grapheme-ish units: a base character with the marks after it.
    const units = text.match(/\P{M}\p{M}*/gu) ?? [text];
    if (units.length === 1) out.push(text);
    else for (let i = 0; i + 1 < units.length; i++) out.push(`${units[i]}${units[i + 1]}`);
    return;
  }
  for (const s of segmenter.segment(text)) if (s.isWordLike === true) out.push(s.segment);
}

/** Latin letters without their combining marks (NFD, strip, NFC); other scripts unchanged. */
function foldLatin(text: string): string {
  if (ASCII.test(text)) return text;
  return text
    .normalize('NFD')
    .replace(/(\p{scx=Latin})\p{M}+/gu, '$1')
    .normalize('NFC');
}

/** The ICU version `Intl.Segmenter` uses here, when the runtime reports it ('' otherwise). */
export function lexicalIcuVersion(): string {
  const p = (globalThis as { process?: { versions?: Record<string, string | undefined> } }).process;
  return p?.versions?.['icu'] ?? '';
}
