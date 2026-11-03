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

/** Is the identifier a credential name, judged on word boundaries? */
function envKey(key: string): boolean {
  if (/^(?:MAX|MIN|NUM|COUNT)_/i.test(key) || /_(?:COUNT|LIMIT|LENGTH|SIZE)$/i.test(key)) {
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
    const endOk = rest === '' || /^[sS]?\d*(?:_.*)?$/.test(rest) || /^[A-Z]/.test(rest);
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
const WORD_SEGMENT = /^(?:[a-z_-]{4,}|src|lib|bin|etc|usr|var|org|tmp|dev|opt|app|pkg|doc|api|me)$/;

function classes(s: string): number {
  return [/[A-Z]/, /[a-z]/, /[0-9]/, /[+/=_-]/].filter((r) => r.test(s)).length;
}

/** Does this piece, on its own, look like random key material? */
function looksRandom(seg: string, before: string): boolean {
  if (seg.length < 32 || UUID.test(seg)) return false;
  if (HEX.test(seg)) {
    if (seg.length === 40) return false; // git SHA
    if (seg.length === 64) return !/sha256:$/.test(before) && KEYISH.test(before.slice(-40));
  }
  if (classes(seg) < 3 || shannonEntropy(seg) < ENTROPY_MIN) return false;
  // Identifiers (camelCase and friends) are mostly letters with next to no digits.
  const letters = seg.replace(/[^A-Za-z]/g, '').length;
  const digits = seg.replace(/[^0-9]/g, '').length;
  return !(letters / seg.length > 0.85 && digits <= 2);
}

const INTEGRITY = /^sha(?:256|384|512)-/;
const PATH_START = /^(?:\.\/|~\/|http)/;

/**
 * Candidate tokens are split on `/` and `.` and judged piece by piece. Only a
 * path-like token (two or more plain lowercase words between slashes, or a path prefix) is
 * redacted per piece, so the path survives and just the key in it goes. Any
 * other token is one secret, because base64 contains `/`: if any piece or the
 * whole looks random, all of it is redacted. npm integrity strings are exempt.
 */
function highEntropy(m: string, ...args: unknown[]): Replacement | null {
  const offset = args[0] as number;
  const whole = args[1] as string;
  if (INTEGRITY.test(m)) return null;
  const before = (at: number): string => whole.slice(Math.max(0, at - 40), at);
  const segs = m.split('/');
  const pathLike = PATH_START.test(m) || segs.filter((x) => WORD_SEGMENT.test(x)).length >= 2;
  if (!pathLike) {
    const any = m.split(/[/.]/).some((p) => looksRandom(p, '')) || looksRandom(m, before(offset));
    return any ? { out: tag('high-entropy'), removed: m.length } : null;
  }
  let pos = offset;
  let removed = 0;
  const out = m.split(/([/.])/).map((part) => {
    const at = pos;
    pos += part.length;
    if (!looksRandom(part, before(at))) return part;
    removed += part.length;
    return tag('high-entropy');
  });
  return removed > 0 ? { out: out.join(''), removed } : null;
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
    re: /(?<![A-Za-z0-9_])["']?(?:export[ \t]+)?(?=[A-Za-z0-9_]{0,95}?(?:secret|token|passw(?:or)?d|api_?key|private_?key|access_?key))[A-Za-z][A-Za-z0-9_]{0,95}["']?[ \t]*[=:][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    hit: envSecret,
  },
  {
    kind: 'high-entropy',
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g,
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
