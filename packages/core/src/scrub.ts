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
}

type Hit = (match: string, ...args: unknown[]) => Replacement | null;

interface Rule {
  kind: string;
  re: RegExp;
  /**
   * Returns the replacement for one match, or null to leave it alone. Defaults
   * to a whole-match `[REDACTED:<kind>]`. `removed` counts only the characters
   * that were actually redacted, so partial rules (keep the header name) do not
   * inflate the secret ratio.
   */
  hit?: Hit;
}

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

const SUFFIXES = 'count|limit|budget|length|size|type|name|path|per|izer|ize';
const SNAKE_SUFFIX = new RegExp(`_(?:${SUFFIXES})$`, 'i');
const CAMEL_SUFFIX = new RegExp(
  `[a-z](?:${SUFFIXES.replace(/\b[a-z]/g, (c) => c.toUpperCase())})$`,
);

/** Is the identifier a credential name, judged on word boundaries? */
function envKey(key: string): boolean {
  const lead = /^(?:max|min|num|total|input|output|prompt|completion|cache|rate)/i.exec(key)?.[0];
  const camelPrefix =
    lead !== undefined && /^[a-z]+$/.test(lead) && /^[A-Z]/.test(key.slice(lead.length));
  if (
    /^(?:max|min|num|total|input|output|prompt|completion|cache|rate)_/i.test(key) ||
    camelPrefix
  ) {
    return false;
  }
  if (SNAKE_SUFFIX.test(key) || CAMEL_SUFFIX.test(key)) {
    return false;
  }
  for (const k of key.matchAll(KEYWORD)) {
    const i = k.index;
    const word = k[0];
    const prev = key[i - 1];
    const startOk =
      prev === undefined ||
      prev === '_' ||
      word === word.toUpperCase() || // glued upper-case prefix: PGPASSWORD
      (/[a-z]/.test(prev) && /[A-Z]/.test(word[0] ?? '')); // camelCase boundary
    const rest = key.slice(i + word.length);
    const plural = /^(?:secret|passw(?:or)?d)$/i.test(word) && /^[sS]\d*(?:_.*)?$/.test(rest);
    const endOk = /^\d*(?:_.*)?$/.test(rest) || plural || /^(?:KEY|Key)/.test(rest);
    if (startOk && endOk) return true;
  }
  return false;
}

/** Redact the value of a credential-named variable, keeping JSON quotes valid. */
function envSecret(m: string): Replacement | null {
  const key = /^["']?(?:export[ \t]+)?([A-Za-z][A-Za-z0-9_]*)/.exec(m)?.[1];
  const head = /^[^=:]*[=:][ \t]*/.exec(m)?.[0].length;
  if (key === undefined || head === undefined || !envKey(key)) return null;
  let value = m.slice(head);
  let open = '';
  let close = '';
  const q = value[0];
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
    open = q;
    close = q;
    value = value.slice(1, -1);
  }
  if (value === '' || value.includes(MARK)) return null;
  return { out: `${m.slice(0, head)}${open}${tag('env-secret')}${close}`, removed: value.length };
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
const TOKEN_MIN = 24;
/** npm subresource-integrity strings, anchored to the exact digest length. */
const INTEGRITY =
  /^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/;
const SHA_HEX_LEN: Record<string, number> = { sha256: 64, sha384: 96, sha512: 128 };
const WORDLIKE = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)\d{0,4}$/;

type Piece = 'word' | 'random' | 'neutral';

function classes(s: string): number {
  return [/[A-Z]/, /[a-z]/, /[0-9]/, /[+/=_.~-]/].filter((r) => r.test(s)).length;
}

/** Long, mixed-class, high-entropy and not just a long identifier. */
function isRandom(s: string): boolean {
  if (s.length < TOKEN_MIN || classes(s) < 3 || shannonEntropy(s) < ENTROPY_MIN) return false;
  const letters = s.replace(/[^A-Za-z]/g, '').length;
  const digits = s.replace(/[^0-9]/g, '').length;
  return digits >= 3 || letters / s.length <= 0.85;
}

/** Words, camel/snake words, short names and numbers: things a path is made of. */
function isWord(p: string): boolean {
  const w = p.replace(/^[.~]+/, '');
  if (w === '' || /^\d{1,8}$/.test(w)) return true;
  const dot = w.indexOf('.');
  if (
    dot > 0 &&
    /^[A-Za-z][a-z]{2,}\d{0,4}$/.test(w.slice(0, dot)) &&
    /^[A-Za-z0-9.]{1,12}$/.test(w.slice(dot + 1))
  ) {
    return true;
  }
  if (w.length <= 11) {
    const parts = w.split(/[_.-]+/).filter((x) => x !== '');
    if (parts.every((x) => WORDLIKE.test(x) || /^\d{1,8}$/.test(x))) return true;
  }
  if (/^[A-Za-z][a-z]{2,}\d{0,4}$/.test(w) || /^[A-Z]{1,8}\d{0,4}$/.test(w)) return true;
  const parts = w
    .replace(/\d{0,4}$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[ _-]+/);
  return parts.length >= 2 && parts.every((x) => /^[A-Z]?[a-z]{2,}$/.test(x));
}

function classify(p: string, before: string): Piece {
  if (UUID.test(p) || INTEGRITY.test(p)) return 'word';
  if (HEX.test(p)) {
    if (p.length === 40) return 'word'; // git SHA
    const sha = /(sha(?:256|384|512)):$/.exec(before)?.[1];
    if (sha !== undefined && SHA_HEX_LEN[sha] === p.length) return 'word';
    if (p.length === 64) return KEYISH.test(before.slice(-40)) ? 'random' : 'word';
  }
  if (isWord(p)) return 'word';
  return isRandom(p) ? 'random' : 'neutral';
}

/**
 * Judge a candidate token (a run of `[A-Za-z0-9+/=_.~-]` of 24+ chars) piece by
 * piece, splitting on `/`. A path-like token (two or more real words, or one after a
 * `./`, `~/` or drive prefix) keeps its words and redacts random pieces together
 * with the neutral pieces next to them, since base64 contains `/` and its chunks
 * can look like anything; a run of neutral pieces totalling 32+ chars goes too.
 * Any other token is one secret: if any piece or the whole is random, all of it
 * is redacted.
 */
function highEntropy(full: string, ...args: unknown[]): Replacement | null {
  const offset = args[0] as number;
  const text = args[1] as string;
  const trail = /\.*$/.exec(full)?.[0] ?? '';
  const m = full.slice(0, full.length - trail.length);
  if (m.length < TOKEN_MIN || INTEGRITY.test(m)) return null;
  const before = (at: number): string => text.slice(Math.max(0, at - 40), at);
  const pieces = m.split('/');
  const kinds: Piece[] = [];
  let at = offset;
  for (const p of pieces) {
    kinds.push(classify(p, before(at)));
    at += p.length + 1;
  }
  // A one or two character piece wedged between non-word pieces is key chunk
  // glue (base64 contains `/`), not a path component.
  const glue = kinds.map((k, i) => {
    const piece = pieces[i] ?? '';
    const edgeEmpty = piece === '' && (i === 0 || i === kinds.length - 1);
    if (k !== 'word' || piece.length > 2 || edgeEmpty) return k;
    return kinds[i - 1] !== 'word' && kinds[i + 1] !== 'word' ? 'neutral' : k;
  });
  kinds.splice(0, kinds.length, ...glue);
  // Only real words count as path evidence: key chunks often look like `Q4` or `Bo5`.
  const words = pieces.filter((p, i) => kinds[i] === 'word' && /[a-z]{3}/.test(p)).length;
  const marker = /^(?:\.\/|~\/|[A-Za-z]:\\)/.test(m) ? 1 : 2;
  if (words < marker) {
    const hit = kinds.includes('random') || isRandom(m);
    return hit ? { out: tag('high-entropy') + trail, removed: m.length } : null;
  }
  const mark = kinds.map((k) => k === 'random');
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== 'random') continue;
    for (let j = i - 1; j >= 0 && kinds[j] === 'neutral'; j--) mark[j] = true;
    for (let j = i + 1; j < kinds.length && kinds[j] === 'neutral'; j++) mark[j] = true;
  }
  for (let i = 0; i < kinds.length;) {
    if (kinds[i] !== 'neutral') {
      i++;
      continue;
    }
    let j = i;
    while (j < kinds.length && kinds[j] === 'neutral') j++;
    if (j - i >= 2 && pieces.slice(i, j).join('/').length >= 32) {
      for (let k = i; k < j; k++) mark[k] = true;
    }
    i = j;
  }
  if (!mark.some(Boolean)) return null;
  let out = '';
  let removed = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] ?? '';
    const sep = i > 0 ? '/' : '';
    if (mark[i] === true) {
      removed += piece.length + (i > 0 && mark[i - 1] === true ? 1 : 0);
      out += mark[i - 1] === true ? '' : sep + tag('high-entropy');
    } else {
      out += sep + piece;
    }
  }
  return { out: out + trail, removed };
}

/**
 * Applied in this order. Order matters: specific vendor shapes run before the
 * generic ones so each secret gets its most precise kind, and the generic
 * rules skip anything already replaced by a marker.
 *
 * Assumption: Typesafe keys are modelled as `ts_(live|test)_<16+ alnum>`.
 */
const RULES: Rule[] = [
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
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'typesafe-key', re: /\bts_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // A digit is required in the body so kebab-case words like `sk-learn-...` survive.
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, hit: withDigit('openai-key', 3) },
  { kind: 'voyage-key', re: /\bpa-[A-Za-z0-9_-]{20,}/g, hit: withDigit('voyage-key', 3) },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    kind: 'url-credentials',
    // Only `user:password@` is redacted; scheme and host survive. The user may
    // be empty and the password may hold `@`: it runs to the last `@` of the authority.
    re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^\s/]+(?=@[^@\s/]*(?:[/\s]|$))/gi,
    hit: (m) => (m.includes(MARK) ? null : { out: tag('url-credentials'), removed: m.length }),
  },
  {
    kind: 'auth-header',
    re: /["']?\b(?:authorization|x-api-key|api-key|x-auth-token)["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+["']?)?[^\s"']+/gi,
    hit: keepName(
      'auth-header',
      /^[^=:]*[=:][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+["']?)?/i,
    ),
  },
  {
    kind: 'env-secret',
    // Any identifier-ish key containing a keyword; `envKey` decides whether the
    // keyword sits on a real boundary. The lookahead keeps this linear.
    re: /(?<![A-Za-z0-9_])["']?(?:export[ \t]+)?(?=[A-Za-z0-9_]{0,95}?(?:secret|token|passw(?:or)?d|api_?key|private_?key|access_?key))[A-Za-z][A-Za-z0-9_]{0,95}["']?[ \t]*[=:][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s"',}\])]+)/gi,
    hit: envSecret,
  },
  {
    kind: 'high-entropy',
    re: /(?<![A-Za-z0-9+/=_.~-])[A-Za-z0-9+/=_.~-]{24,}(?![A-Za-z0-9+/=_.~-])/g,
    hit: highEntropy,
  },
];

interface Scrubbed {
  text: string;
  redactions: Redaction[];
  removed: number;
}

function run(input: string): Scrubbed {
  let text = input;
  let removed = 0;
  const counts = new Map<string, number>();
  for (const { kind, re, hit } of RULES) {
    text = text.replace(re, (m: string, ...args: unknown[]) => {
      const r = hit === undefined ? { out: tag(kind), removed: m.length } : hit(m, ...args);
      if (r === null) return m;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      removed += r.removed;
      return r.out;
    });
  }
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
    secretRatio: text.length === 0 ? 0 : Math.min(1, r.removed / text.length),
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
