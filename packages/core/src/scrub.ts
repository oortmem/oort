import type { Observation } from './adapters.js';

/** How many times one kind of secret was redacted. */
export interface Redaction {
  kind: string;
  count: number;
}

export interface ScrubResult {
  text: string;
  redactions: Redaction[];
  /** Fraction of the original characters that were redacted (0 for empty input). */
  secretRatio: number;
}

/** An observation is dropped outright when more than this fraction of it was secret. */
const DROP_RATIO = 0.5;
const ENTROPY_MIN = 4.0;
const MARK = '[REDACTED:';

/** A replacement and how many of the matched characters it redacted. */
interface Replacement {
  out: string;
  removed: number;
  /** Input characters replaced, from the match start (default: the match). */
  length?: number;
}

type Hit = (match: string, offset: number, text: string) => Replacement | null;

/** One scrubbing rule (exported for tests of `escapeBounded`). */
export interface ScrubRule {
  kind: string;
  re: RegExp;
  /**
   * Returns the replacement for one match, or null to leave it alone. Defaults
   * to a whole-match `[REDACTED:<kind>]`. `removed` counts only the characters
   * that were actually redacted, so partial rules (keep the header name) do not
   * inflate the secret ratio.
   */
  hit?: Hit;
  /**
   * The rule writes its own escape-aware boundary (or needs none), so
   * `escapeBounded` leaves it alone instead of failing on its lookbehind.
   */
  ownBoundary?: true;
  /** After a rejected match, try again one char later rather than past the match. */
  retry?: true;
}

type Rule = ScrubRule;

const tag = (kind: string): string => `${MARK}${kind}]`;

/** Redact the whole match only if its body (after `skip` prefix chars) has a digit. */
function withDigit(kind: string, skip: number): Hit {
  return (m) => (/[0-9]/.test(m.slice(skip)) ? { out: tag(kind), removed: m.length } : null);
}

/**
 * Keep everything up to the value (name, delimiter and, for headers, a kept
 * scheme word) and redact the value. Skips values that already contain a
 * marker, so a second pass never re-redacts and the ratio stays at most 1.
 */
function keepName(kind: string, prefix: RegExp, drop?: RegExp): Hit {
  return (m) => {
    if (drop?.test(m) === true) return null;
    const cut = prefix.exec(m)?.[0].length ?? 0;
    const value = m.slice(cut);
    if (value.includes(MARK) || cut === 0) return null;
    return { out: `${m.slice(0, cut)}${tag(kind)}`, removed: value.length };
  };
}

const KEYWORD = /secret|token|passw(?:or)?d|api_?key|private_?key|access_?key/gi;

/** Key names that describe a credential rather than hold one: `TOKEN_TTL`, `secretName`. */
const SUFFIXES = [
  'count',
  'limit',
  'budget',
  'length',
  'size',
  'type',
  'name',
  'path',
  'per',
  'izer',
  'ize',
  'url',
  'uri',
  'endpoint',
  'arn',
  'ttl',
  'expiry',
  'region',
  'file',
];
const SNAKE_SUFFIX = new RegExp(`_(?:${SUFFIXES.join('|')}|expires_(?:in|at))$`, 'i');
const CAMEL_SUFFIX = new RegExp(
  `[a-z](?:${SUFFIXES.map((x) => x[0]?.toUpperCase() + x.slice(1)).join('|')}|Expires(?:In|At))$`,
);
/** What may follow the keyword in a credential name: `secretValue`, `SecretString`, `apiKEY`. */
const CONTINUATION =
  /^(?:KEY|VALUE|STRING|TEXT|RAW|PLAIN|ENCODED|Key|Value|String|Text|Raw|Plain|Encoded)/;

/**
 * Is the identifier a credential name, judged on word boundaries? `always`
 * redacts any value; `unless-count` (a plural `TOKENS`, as in `input_tokens`)
 * redacts only values that are not numbers, booleans or arrays.
 */
function envKey(key: string): 'always' | 'unless-count' | null {
  // Counters, not credentials: MAX_TOKENS, numPasswords. Other prefixes are
  // real credentials (GitHub Actions passes inputs as INPUT_PASSWORD).
  if (/^(?:max|min|num|count)_/i.test(key) || /^(?:max|min|num|count)[A-Z]/.test(key)) {
    return null;
  }
  if (SNAKE_SUFFIX.test(key) || CAMEL_SUFFIX.test(key)) return null;
  let plural = false;
  for (const k of key.matchAll(KEYWORD)) {
    const i = k.index;
    const word = k[0];
    const prev = key[i - 1];
    const startOk =
      prev === undefined ||
      prev === '_' ||
      word === word.toUpperCase() || // glued upper-case prefix: PGPASSWORD
      (/[a-z]/.test(prev) && /[A-Z]/.test(word[0] ?? '')); // camelCase boundary
    if (!startOk) continue;
    const rest = key.slice(i + word.length);
    const many = /^(?:secret|passw(?:or)?d)$/i.test(word) && /^[sS]\d*$/.test(rest);
    if (/^\d*(?:_.*)?$/.test(rest) || CONTINUATION.test(rest) || many) return 'always';
    if (/^token$/i.test(word) && /^[sS]$/.test(rest)) plural = true;
  }
  return plural ? 'unless-count' : null;
}

/** Values of a plural `TOKENS` key that count rather than hold: `128`, `~4k`, `6m0s`, `undefined`. */
const COUNT_VALUE =
  /^(?:[~<>≈][ \t]*)?(?:-?\d[\d_,.]*[kKmM]?|\d+(?:ms|s|m|h|d)(?:\d+(?:ms|s|m|h))*|true|false|null|none|undefined|NaN|True|False|None)$/;

/**
 * JSON string escapes. Tool inputs reach the scrubber serialised, so a token
 * may sit right after a literal `\n` (backslash, `n`): the `n` must not count
 * as part of the token, or `\b` and the lookbehinds below never see its start.
 */
const ESC_TAIL = String.raw`(?:[nrtbf"\\/]|u[0-9A-Fa-f]{4})`;
/** Just after an escape: a token may start here even though the last char is a letter. */
const AFTER_ESC = String.raw`(?<=\\${ESC_TAIL})`;
/** A JSON escape anywhere: what a value's count prefix stops at. */
const ESC_ANY = new RegExp(String.raw`\\${ESC_TAIL}`);
/**
 * Control escapes a bare value may not start with: `token:\nexpires` has no
 * value on its line. Inside a value no escape ends it: over-redaction beats a
 * leaked tail (`DB_PASSWORD=abc\ndef123` goes whole).
 */
const VALUE_START_ESC = String.raw`\\(?:[nrtbf"]|u00[01][0-9A-Fa-f])`;

/**
 * Gives a rule that starts with `\b` or a negative lookbehind an escape-aware
 * left boundary: the old boundary, or just after an escape. Both readings of
 * `\npm_…` are kept: as plain text the vendor prefix starts on the `n`, as
 * JSON just after it, and the regex tries both positions. A rule starting with
 * any other lookbehind must say it bounds itself (`ownBoundary`), or loading
 * the module fails rather than leaving the rule silently unbounded.
 */
export function escapeBounded(rule: Rule): Rule {
  if (rule.ownBoundary === true) return rule;
  const src = rule.re.source;
  const lead = /^(?:\\b|\(\?<![^()]*\))/.exec(src)?.[0];
  if (lead === undefined) {
    if (src.startsWith('(?<')) throw new Error(`scrub: cannot bound rule ${rule.kind}: ${src}`);
    return rule;
  }
  return {
    ...rule,
    re: new RegExp(`(?:${lead}|${AFTER_ESC})${src.slice(lead.length)}`, rule.re.flags),
  };
}

/**
 * A value: double-quoted (escapes allowed), single-quoted, escaped-quoted
 * (JSON inside a JSON string), an array of strings, or bare. A bare value may
 * hold `, } ] )`: one ends it only when followed by whitespace, a quote,
 * another delimiter or the end. A JSON escape of a backslash or a quote (`\\`, `\"`) never
 * ends it (see VALUE_START_ESC); any other backslash is a plain character, so it never
 * swallows the delimiter after it. A bracket followed by space, a quote, a bracket or a digit
 * opens a structure, which is left to the keys inside it.
 */
const ENV_VALUE = new RegExp(
  String.raw`"(?:[^"\\\n]|\\.)*"|"[^"\n]*"|'[^'\n]*'|\\"[^"\\\n]*\\"|\[[ \t]*(?:"[^"\n]*"|'[^'\n]*')(?:[ \t]*,[ \t]*(?:"[^"\n]*"|'[^'\n]*'))*[ \t]*\]|(?![[{](?:[\s"'[\]{}\d]|$)|${VALUE_START_ESC})(?:\\[\\"]|[^\s"',}\])]|[,}\])](?![\s"',}\])]|$))+`,
  'y',
);

/**
 * Redact the value after a credential-named key, keeping JSON quotes valid.
 * The value is read only once the key is accepted, so a rejected key
 * (`tokenizer:`) never hides a real one in its value.
 */
function envSecret(head: string, offset: number, text: string): Replacement | null {
  const key = /^["']?(?:export[ \t]+)?([A-Za-z][A-Za-z0-9_]*)/.exec(head)?.[1];
  const level = key === undefined ? null : envKey(key);
  if (level === null) return null;
  ENV_VALUE.lastIndex = offset + head.length;
  const raw = ENV_VALUE.exec(text)?.[0];
  if (raw === undefined || raw.includes(MARK)) return null;
  const length = head.length + raw.length;
  // An array is `[` then a quote (ENV_VALUE's bare alternative never starts `[ ` or `['`); a bare
  // value that merely starts with a bracket (`token=[abc]`) is redacted whole, below.
  if (/^\[[ \t]*["']/.test(raw)) {
    // An array of strings: redact each element, keep the array.
    if (level === 'unless-count') return null;
    let removed = 0;
    const out = raw.replace(/"[^"\n]*"|'[^'\n]*'/g, (q) => {
      if (q.length <= 2) return q;
      removed += q.length - 2;
      return `${q[0]}${tag('env-secret')}${q[0]}`;
    });
    return removed === 0 ? null : { out: `${head}${out}`, removed, length };
  }
  let value = raw;
  let quote = '';
  for (const q of ['\\"', '"', "'"]) {
    if (value.length >= 2 * q.length && value.startsWith(q) && value.endsWith(q)) {
      quote = q;
      value = value.slice(q.length, -q.length);
      break;
    }
  }
  if (value === '') return null;
  // A plural `tokens` value is a count, or quoted text with spaces (`"Hello world"`).
  // The count is read up to the first escape: `input_tokens: 1234\n…` stays a count.
  const count = value.split(ESC_ANY)[0] ?? value;
  if (level === 'unless-count' && (COUNT_VALUE.test(count) || (quote !== '' && /\s/.test(value)))) {
    return null;
  }
  return { out: `${head}${quote}${tag('env-secret')}${quote}`, removed: value.length, length };
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HEX = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYISH = /(secret|token|key|password)/i;
/** Shorter tokens are never judged: too many ids and hashes look random at 24. */
const TOKEN_MIN = 32;
/** npm subresource-integrity strings, anchored to the exact digest length. */
const INTEGRITY =
  /^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/i;
const SHA_HEX_LEN: Record<string, number> = { sha256: 64, sha384: 96, sha512: 128 };
const WORDLIKE = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)\d{0,4}$/;
/** A short part made only of base64 characters: could be a chunk of a key. */
const CHUNK = /^[A-Za-z0-9+=]{0,8}$/;
/** The longest base64-only component taken as key glue or as a key's edge chunk. */
const GLUE = /^[A-Za-z0-9+=]{0,16}$/;
/** A real directory name next to a key, not a chunk of it: `app`, `blobs`, `Desktop`. */
const PATH_WORD = /^(?:[a-z]{3,}|[A-Z][a-z]{3,})\d{0,4}$/;
/** Words that are no part of a key: a lowercase run, or a character base64 lacks. */
const REAL_WORD = /[a-z]{3}|[-_~]/;

type Piece = 'word' | 'random' | 'neutral';

/** Character classes; `+ / =` are the only symbols base64 adds to letters and digits. */
function classes(s: string): number {
  return [/[A-Z]/, /[a-z]/, /[0-9]/, /[+/=]/].filter((r) => r.test(s)).length;
}

/** Share of the letters that sit in words (`Request`, `get`): high in identifiers, low in keys. */
function wordShare(s: string): number {
  const letters = s.replace(/[^A-Za-z]/g, '').length;
  let inWords = 0;
  for (const w of s.matchAll(/[A-Z]?[a-z]{3,}/g)) inWords += w[0].length;
  return letters === 0 ? 0 : inWords / letters;
}

/**
 * Mixed-class, high-entropy and not an identifier (length aside). Identifiers
 * are mostly words (word share 0.8 to 1.0, `handleRequestV2Timeout30sRetry3Ms`
 * included); random keys sit near 0.2 and under 0.75 in 99.9% of cases. A
 * letter-heavy token (over 85% letters, under 3 digits) needs only 0.5, so
 * acronym-heavy names (`getHTTPSURLForAWSS3Bucket`) stay.
 */
function keyLike(s: string): boolean {
  if (classes(s) < 3 || shannonEntropy(s) < ENTROPY_MIN) return false;
  const letters = s.replace(/[^A-Za-z]/g, '').length;
  const digits = s.replace(/[^0-9]/g, '').length;
  const heavy = digits < 3 && letters / s.length > 0.85;
  return wordShare(s) < (heavy ? 0.5 : 0.75);
}

function isRandom(s: string): boolean {
  return s.length >= TOKEN_MIN && keyLike(s);
}

/** Do these parts, joined by `/` as base64 would have them, look like one key? */
function runIsKey(parts: string[]): boolean {
  return parts.join('/').length >= TOKEN_MIN && keyLike(parts.join(''));
}

/** Words, camel/snake words, short names and numbers: things a path is made of. */
function isWord(p: string): boolean {
  const w = p.replace(/^~+/, '');
  if (w === '' || /^\d+$/.test(w)) return true;
  if (w.length <= 11) {
    const parts = w.split(/[_-]+/).filter((x) => x !== '');
    if (parts.every((x) => WORDLIKE.test(x) || /^\d{1,8}$/.test(x))) return true;
  }
  if (/^[A-Za-z][a-z]{2,}\d{0,4}$/.test(w) || /^[A-Z]{1,8}\d{0,4}$/.test(w)) return true;
  const parts = w
    .replace(/\d{0,4}$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[ _-]+/)
    .filter((x) => x !== '');
  return parts.length >= 2 && parts.every((x) => /^[A-Z]?[a-z]{2,}$/.test(x));
}

/** Classify one part of a token (no `/` or `.` in it). */
function classify(p: string, before: string): Piece {
  if (UUID.test(p) || INTEGRITY.test(p)) return 'word';
  if (HEX.test(p)) {
    if (p.length === 40) return 'word'; // git SHA
    const sha = /(sha(?:256|384|512)):$/i.exec(before)?.[1]?.toLowerCase();
    if (sha !== undefined && SHA_HEX_LEN[sha] === p.length) return 'word';
    if (p.length === 64) return KEYISH.test(before.slice(-40)) ? 'random' : 'word';
  }
  if (isWord(p)) return 'word';
  if (isRandom(p)) return 'random';
  // `-`, `_` and `~` never occur in standard base64, so such a part is no chunk of a key.
  return /[-_~]/.test(p) ? 'word' : 'neutral';
}

/**
 * Judge a candidate token (a run of `[A-Za-z0-9+/=_.~-]` of 32+ chars). A
 * query-style `name=` prefix is kept and the value judged on its own, since
 * base64 has `=` only at its end.
 */
function highEntropy(full: string, offset: number, text: string): Replacement | null {
  // After a backslash the token may begin with an escape's own char (`n` in
  // `\n`, `/` in `\/`, `u00e9` in `\u00e9`). Both readings are judged and either
  // one being a key redacts. Inside a JSON string the escape reading comes
  // first (the escape survives); in plain text (`C:\keys\r…`) the whole token
  // does, so no key char is left beside the marker.
  const esc = escapeAt(full, offset, text);
  if (esc === undefined) return readToken(full, offset, text);
  const asJson = (): Replacement | null => {
    const rest = readToken(full.slice(esc.length), offset + esc.length, text);
    return rest === null ? null : { out: esc + rest.out, removed: rest.removed };
  };
  return inJsonString(text, offset - 1)
    ? (asJson() ?? readToken(full, offset, text))
    : (readToken(full, offset, text) ?? asJson());
}

/** The escape a token starts with, if an odd run of backslashes precedes it. */
function escapeAt(full: string, offset: number, text: string): string | undefined {
  let n = 0;
  while (offset - 1 - n >= 0 && text[offset - 1 - n] === '\\') n++;
  if (n % 2 === 0) return undefined;
  return /^(?:[nrtbf/]|u[0-9A-Fa-f]{4})/.exec(full)?.[0];
}

/**
 * Quote parity per position, built once per text in one pass: `1` where an odd
 * number of unescaped quotes (after an even run of backslashes) precede it on
 * its line. Serialised text can be one megabyte with no real newline, so
 * rescanning the line for every token would be quadratic.
 */
let parityOf: { text: string; odd: Uint8Array } | undefined;

function quoteParity(text: string): Uint8Array {
  const odd = new Uint8Array(text.length + 1);
  let inside = 0;
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    odd[i] = inside;
    const c = text.charCodeAt(i);
    if (c === 10) {
      inside = 0;
      slashes = 0;
    } else if (c === 92) {
      slashes++;
    } else {
      if (c === 34 && slashes % 2 === 0) inside ^= 1;
      slashes = 0;
    }
  }
  odd[text.length] = inside;
  return odd;
}

/** Is `at` inside a JSON string: an odd number of unescaped quotes before it on its line? */
function inJsonString(text: string, at: number): boolean {
  if (parityOf?.text !== text) parityOf = { text, odd: quoteParity(text) };
  return parityOf.odd[at] === 1;
}

function readToken(full: string, offset: number, text: string): Replacement | null {
  const trail = /\.*$/.exec(full)?.[0] ?? '';
  const m = full.slice(0, full.length - trail.length);
  const name = /^[A-Za-z_][A-Za-z0-9_]*=(?=[^=])/.exec(m)?.[0] ?? '';
  const r = judgeToken(m.slice(name.length), offset + name.length, text);
  return r === null ? null : { out: name + r.out + trail, removed: r.removed };
}

/**
 * The token is split into parts on `/` and `.`, each judged word, random or
 * neutral (could be a chunk of base64, which contains `/` but never `.`, `-`,
 * `_` or `~`). A path-like token (two or more real words, or one after `./` or
 * `~/`) keeps its words and redacts each key in it: a run of random, neutral
 * and short chunk parts joined by `/`, plus the short components beside it. Any
 * other token is one secret: if any part is random, or its parts other than
 * real words together look like a key, all of it is redacted.
 */
function judgeToken(m: string, offset: number, text: string): Replacement | null {
  if (m.length < TOKEN_MIN || INTEGRITY.test(m)) return null;
  const bits = m.split(/([/.])/);
  const parts = bits.filter((_, i) => i % 2 === 0);
  /** `seps[i]` sits between `parts[i]` and `parts[i + 1]`. */
  const seps = bits.filter((_, i) => i % 2 === 1);
  const slash = (i: number): boolean => seps[i] === '/';
  const n = parts.length;
  const kinds: Piece[] = [];
  let at = offset;
  for (const [i, p] of parts.entries()) {
    kinds.push(classify(p, text.slice(Math.max(0, at - 40), at)));
    at += p.length + (seps[i]?.length ?? 0);
  }
  // Short chunks that could belong to a key: `Q4`, `kT9`, `x`, empty; not `app`,
  // `Desktop` or a number.
  const chunk = (i: number): boolean => {
    const p = parts[i] ?? '';
    return kinds[i] === 'word' && CHUNK.test(p) && !PATH_WORD.test(p) && !/^\d+$/.test(p);
  };
  const loose = (i: number): boolean => kinds[i] !== undefined && kinds[i] !== 'word';
  // Short base64-only words wedged by slashes between two parts of key material
  // are key chunk glue (base64 contains `/`), not path components.
  const glued = kinds.slice();
  for (let i = 0; i < n;) {
    if (!loose(i)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && slash(j - 1) && kinds[j] === 'word' && GLUE.test(parts[j] ?? '')) j++;
    if (j > i + 1 && j < n && slash(j - 1) && loose(j)) glued.fill('neutral', i + 1, j);
    i = j;
  }
  // Only real words count as path evidence: key chunks often look like `Q4` or `Bo5`.
  const words = parts.filter((p, i) => glued[i] === 'word' && /[a-z]{3}/.test(p)).length;
  if (words < (/^[.~]\//.test(m) ? 1 : 2)) {
    // Only real words (a lowercase run, or a `-`, `_` or `~`) are left out.
    const material = parts.filter((p, i) => glued[i] !== 'word' || !REAL_WORD.test(p));
    const hit = glued.includes('random') || runIsKey(material);
    return hit ? { out: tag('high-entropy'), removed: m.length } : null;
  }
  // A key is a run of parts joined by `/` that are random, neutral or short
  // chunks (`Q4`, `kT9`, `x`, empty): it goes whole if it holds a random part,
  // or if its neutral parts carry it and together they look like a key.
  const mark = parts.map(() => false);
  const inKey = (i: number): boolean => glued[i] !== 'word' || chunk(i);
  for (let i = 0; i < n;) {
    if (!inKey(i)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && slash(j - 1) && inKey(j)) j++;
    const run = parts.slice(i, j);
    const neutral = run.filter((_, k) => glued[i + k] === 'neutral').join('').length;
    const random = glued.slice(i, j).includes('random');
    if (random || (neutral >= 16 && runIsKey(run))) mark.fill(true, i, j);
    i = j;
  }
  // Base64 contains `/`, so the components next to a key may be its edge chunks
  // (`.../qvnp`, `53/S/...`) and cannot be told from directories: the short
  // ones go too. Leftwards this stops at a dot (`example.com`, `.cache`), which
  // base64 never has, and at an empty part (the root, or `//`).
  const short = (j: number): boolean => GLUE.test(parts[j] ?? '');
  const dotted = (j: number): boolean => j > 0 && seps[j - 1] === '.';
  const keys = mark.slice();
  for (let i = 0; i < n; i++) {
    if (!keys[i]) continue;
    for (let j = i - 1; j >= 0 && !keys[j] && slash(j) && short(j) && !dotted(j); j--) {
      if (parts[j] === '') break; // the root, or `//`
      mark[j] = true;
    }
    for (let j = i + 1; j < n && !keys[j] && slash(j - 1) && short(j); j++) {
      mark[j] = true;
      if (parts[j] === '') break;
    }
  }
  if (!mark.some(Boolean)) return null;
  let out = '';
  let removed = 0;
  for (let i = 0; i < n; i++) {
    const piece = parts[i] ?? '';
    const sep = i > 0 ? (seps[i - 1] ?? '') : '';
    if (mark[i] !== true) out += sep + piece;
    else if (i > 0 && mark[i - 1] === true) removed += sep.length + piece.length;
    else {
      out += sep + tag('high-entropy');
      removed += piece.length;
    }
  }
  return { out, removed };
}

/**
 * Applied in this order; every rule that starts at a boundary gets the
 * escape-aware one (`escapeBounded`). Order matters: specific vendor shapes run before the
 * generic ones so each secret gets its most precise kind, and the generic
 * rules skip anything already replaced by a marker.
 *
 * Assumption: Typesafe keys are modelled as `ts_(live|test)_<16+ alnum>`.
 */
const RULES: Rule[] = (
  [
    {
      kind: 'pem-private-key',
      re: /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gs,
    },
    { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    {
      kind: 'aws-secret-key',
      re: /aws_secret_access_key[ \t]*[=:][ \t]*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
      hit: (m) => {
        const at = m.search(/[A-Za-z0-9/+=]{40}$/);
        return { out: `${m.slice(0, at)}${tag('aws-secret-key')}`, removed: m.length - at };
      },
    },
    { kind: 'github-token', re: /(?<![A-Za-z0-9_-])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
    { kind: 'github-token', re: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{22,}\b/g },
    { kind: 'anthropic-key', re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
    // Oort's own keys (oort keys create, oort login): the same shape `oort login` accepts.
    { kind: 'oort-key', re: /(?<![A-Za-z0-9_-])oort_sk_[A-Za-z0-9_-]{16,}/g },
    { kind: 'stripe-key', re: /(?<![A-Za-z0-9_-])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { kind: 'typesafe-key', re: /(?<![A-Za-z0-9_-])ts_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    // Vendor tokens shorter than 32 chars or with hex bodies (two character
    // classes) that the high-entropy rule cannot see.
    { kind: 'shopify-key', re: /(?<![A-Za-z0-9_-])(?:shpat|shpss|shppa)_[0-9a-f]{32}\b/g },
    { kind: 'digitalocean-token', re: /(?<![A-Za-z0-9_-])(?:dop|doo|dor)_v1_[0-9a-f]{64}\b/g },
    { kind: 'mailgun-key', re: /(?<![A-Za-z0-9_-])key-[0-9a-f]{32}\b/g },
    { kind: 'gitlab-token', re: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'square-token', re: /(?<![A-Za-z0-9_-])sq0(?:atp|csp)-[A-Za-z0-9_-]{22,}\b/g },
    { kind: 'slack-token', re: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: 'npm-token', re: /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{36}\b/g },
    // Letters-only bodies included; 34 chars is the current shape, longer ones too.
    { kind: 'huggingface-token', re: /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{34,}\b/g },
    {
      kind: 'twilio-sid',
      // An account SID is an id, but with the key it is half a credential; only
      // when named as one, so other `AC<hex>` strings survive.
      re: /(?<![A-Za-z0-9_-])AC[0-9a-f]{32}\b/g,
      hit: (m, offset, text) =>
        /sid|account/i.test(text.slice(Math.max(0, offset - 20), offset))
          ? { out: tag('twilio-sid'), removed: m.length }
          : null,
    },
    { kind: 'twilio-key', re: /(?<![A-Za-z0-9_-])SK[0-9a-f]{32}\b/g },
    {
      kind: 'slack-webhook',
      ownBoundary: true,
      // The path is the credential; the host stays.
      re: /(?<=https:\/\/hooks\.slack\.com\/services\/)T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    },
    // Vendor prefixes start a token: `-pa-` inside a base64url key is no Voyage key.
    // A digit is required in the body so kebab-case words like `sk-learn-...` survive.
    {
      kind: 'openai-key',
      re: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
      hit: withDigit('openai-key', 3),
    },
    {
      kind: 'voyage-key',
      re: /(?<![A-Za-z0-9_-])pa-[A-Za-z0-9_-]{20,}/g,
      hit: withDigit('voyage-key', 3),
    },
    {
      kind: 'jwt',
      re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    },
    {
      kind: 'url-credentials',
      ownBoundary: true,
      // Only `user:password@` is redacted; scheme and host survive. The user may
      // be empty and the password may hold `@`: it runs to the last `@` of the authority.
      re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^\s/]+(?=@[^@\s/]*(?:[/\s]|$))/gi,
      hit: (m) => (m.includes(MARK) ? null : { out: tag('url-credentials'), removed: m.length }),
    },
    {
      kind: 'url-credentials',
      ownBoundary: true,
      // A user-only userinfo of 20+ token characters is a key (Sentry DSN, a
      // token used as a git username); short names like `user@` stay.
      re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[A-Za-z0-9_-]{20,}(?=@[^@\s/]*(?:[/\s]|$))/gi,
    },
    {
      kind: 'basic-auth-arg',
      ownBoundary: true,
      // `curl -u user:password`: the flag and the user stay. A numeric value is a
      // group id (`docker run -u 1000:1000`).
      re: new RegExp(
        String.raw`(?<=(?:^|\s|\\[nrt])(?:-u[ \t]+|--user[ \t=]+)(?:[^\s:\\]|\\.)+:)\S+`,
        'g',
      ),
      hit: (m) =>
        /^\d+$/.test(m) || m.includes(MARK)
          ? null
          : { out: tag('basic-auth-arg'), removed: m.length },
    },
    {
      kind: 'auth-header',
      ownBoundary: true,
      re: new RegExp(
        String.raw`["']?(?:\b|${AFTER_ESC})(?:authorization|x-api-key|api-key|x-auth-token)["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+["']{0,2})?[^\s"']+`,
        'gi',
      ),
      hit: keepName(
        'auth-header',
        /^[^=:]*[=:][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+["']{0,2})?/i,
      ),
    },
    {
      kind: 'env-secret',
      retry: true,
      // Any identifier-ish key containing a keyword, up to its `=` or `:`; `envKey`
      // decides whether the keyword sits on a real boundary and `envSecret` reads
      // the value. The lookahead keeps this linear.
      re: /(?<![A-Za-z0-9_])["']?(?:export[ \t]+)?(?=[A-Za-z0-9_]{0,95}?(?:secret|token|passw(?:or)?d|api_?key|private_?key|access_?key))[A-Za-z][A-Za-z0-9_]{0,95}\\?["']?[ \t]*[=:][ \t]*/gi,
      hit: envSecret,
    },
    {
      kind: 'high-entropy',
      // A token touching a marker is the rest of one already judged: skip it, so
      // a second pass changes nothing.
      re: /(?<![A-Za-z0-9+/=_.~-]|\[REDACTED:[a-z-]+\])[A-Za-z0-9+/=_.~-]{32,}(?![A-Za-z0-9+/=_.~-]|\[REDACTED:)/g,
      hit: highEntropy,
    },
  ] satisfies Rule[]
).map(escapeBounded);

/** The kind of every rule, in order (one entry per rule): for tests and introspection. */
export const RULE_KINDS: readonly string[] = RULES.map((r) => r.kind);

interface Scrubbed {
  text: string;
  redactions: Redaction[];
  removed: number;
}

function run(input: string): Scrubbed {
  let text = input;
  let removed = 0;
  const counts = new Map<string, number>();
  for (const { kind, re, hit, retry } of RULES) {
    let out = '';
    let from = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const r =
        hit === undefined ? { out: tag(kind), removed: m[0].length } : hit(m[0], m.index, text);
      if (r === null) {
        // A rejected key (`napiKey`, as the plain-text reading of `\napiKey`)
        // must not hide the one starting a char later.
        if (retry === true) re.lastIndex = m.index + 1;
        continue;
      }
      out += text.slice(from, m.index) + r.out;
      from = m.index + (r.length ?? m[0].length);
      re.lastIndex = from;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      removed += r.removed;
    }
    text = out + text.slice(from);
  }
  parityOf = undefined; // do not keep the last text alive
  return { text, redactions: [...counts].map(([kind, count]) => ({ kind, count })), removed };
}

/**
 * Redacts credentials from text. Pure, deterministic and idempotent: a second
 * pass over the output changes nothing, because `[REDACTED:...]` matches no rule.
 */
export function scrub(text: string): ScrubResult {
  const r = run(text);
  return {
    text: r.text,
    redactions: r.redactions,
    // Not clamped: `removed` counts characters of the input, so the ratio is at
    // most 1 by construction, and `scrub.ratio-never-exceeds-one` checks it.
    secretRatio: text.length === 0 ? 0 : r.removed / text.length,
  };
}

/**
 * Scrubs every text field of an observation. The observation is dropped when
 * more than half of it was secret: what is left would be meaningless, and the
 * turn is not worth keeping.
 */
export function scrubObservation(obs: Observation): {
  obs: Observation;
  dropped: boolean;
  redactions: Redaction[];
} {
  const merged = new Map<string, number>();
  let removed = 0;
  let total = 0;
  const one = (s: string): string => {
    const r = run(s);
    removed += r.removed;
    total += s.length;
    for (const { kind, count } of r.redactions) merged.set(kind, (merged.get(kind) ?? 0) + count);
    return r.text;
  };
  const clean: Observation = {
    ...obs,
    userText: one(obs.userText),
    assistantText: one(obs.assistantText),
    toolSummaries: obs.toolSummaries.map(one),
  };
  return {
    obs: clean,
    dropped: total > 0 && removed / total > DROP_RATIO,
    redactions: [...merged].map(([kind, count]) => ({ kind, count })),
  };
}
