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

/**
 * Keep everything up to the value (the name, the delimiter, and optionally a
 * `Bearer` scheme) and redact the value, unless it is already redacted.
 */
function keepName(kind: string, scheme: boolean): Hit {
  return (m) => {
    const delim = m.search(/[=:]/) + 1;
    const rest = m.slice(delim);
    const lead = /^[ \t]*/.exec(rest)?.[0].length ?? 0;
    let cut = delim + lead;
    if (scheme) cut += /^bearer[ \t]+/i.exec(m.slice(cut))?.[0].length ?? 0;
    const value = m.slice(cut);
    return value.startsWith(MARK)
      ? null
      : { out: `${m.slice(0, cut)}${tag(kind)}`, removed: value.length };
  };
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

function classes(s: string): number {
  return [/[A-Z]/, /[a-z]/, /[0-9]/, /[+/=_-]/].filter((r) => r.test(s)).length;
}

function highEntropy(m: string, ...args: unknown[]): Replacement | null {
  const offset = args[0] as number;
  const whole = args[1] as string;
  const hit = { out: tag('high-entropy'), removed: m.length };
  if (UUID.test(m)) return null;
  if (HEX.test(m)) {
    if (m.length === 40) return null; // git SHA
    if (m.length === 64) {
      return KEYISH.test(whole.slice(Math.max(0, offset - 40), offset)) ? hit : null;
    }
  }
  if (classes(m) < 3 || shannonEntropy(m) < ENTROPY_MIN) return null;
  return hit;
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
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'voyage-key', re: /\bpa-[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    kind: 'url-credentials',
    // Only `user:password@` is redacted; scheme and host survive.
    re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+(?=@)/gi,
    hit: (m) => (m.startsWith(MARK) ? null : { out: tag('url-credentials'), removed: m.length }),
  },
  {
    kind: 'auth-header',
    re: /\b(?:authorization|x-api-key|api-key|x-auth-token)[ \t]*[:=][ \t]*(?:bearer[ \t]+)?\S+/gi,
    hit: keepName('auth-header', true),
  },
  {
    kind: 'env-secret',
    re: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*[ \t]*[=:][ \t]*\S+/gim,
    hit: keepName('env-secret', false),
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
