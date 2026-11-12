import { z } from 'zod';
import { checkNear, checkPlace, checkPlacePath, utf8Bytes } from '@oortmem/core';
import { OortUsageError } from './errors.js';

/**
 * Strict runtime schemas for every input (CON-108 §4.1, §4.5): an unknown key is a usage error,
 * never silently dropped. Errors name the field, never its value, and are raised before any I/O.
 * Places and spatial filters (`place`, `near`, `within`, CON-84) are checked by core's own rules.
 */

export const LIMITS = Object.freeze({
  queryBytes: 2048,
  recallLimit: 50,
  turnBytes: 128 * 1024,
  turnRef: 128,
  rememberFacts: 5,
  factChars: 500,
  recentLimit: 100,
  idMinPrefix: 8,
  idMax: 128,
});

/** Checks `v` against `schema`; a failure names the fields only. */
export function check<T>(schema: z.ZodType<T>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  const fields = new Set<string>();
  for (const i of r.error.issues) {
    const at = i.path.map(String).join('.');
    if (i.code === 'unrecognized_keys') {
      for (const k of i.keys) fields.add(at === '' ? k : `${at}.${k}`);
    } else fields.add(at === '' ? what : at);
  }
  const list = [...fields].map((f) => f.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64));
  const unknown = r.error.issues.some((i) => i.code === 'unrecognized_keys');
  throw new OortUsageError(
    `${what}: ${unknown ? 'unknown or invalid' : 'invalid'} ${list.length === 1 ? 'field' : 'fields'} ${list.join(', ')}.`,
    { reason: 'invalid-argument' },
  );
}

const isoDate = z.union([
  z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  z.date().refine((d) => !Number.isNaN(d.getTime())),
]);

/** A name (agent, user, org, project): one word, no spaces or control characters. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const signal = z.custom<AbortSignal>((v) => v instanceof AbortSignal);

/**
 * A value checked by one of core's place checks: its RangeError names the field (`place.pose.x
 * must be …`), which becomes the issue's path below the key; the value is never echoed.
 */
function corePlaceCheck<T>(fn: (v: unknown) => T) {
  return z.unknown().transform((v, ctx): T | undefined => {
    if (v === undefined) return undefined;
    try {
      return fn(v);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      const field = e.message.split(' ')[0] ?? '';
      ctx.addIssue({ code: 'custom', message: 'invalid', path: field.split('.').slice(1) });
      return z.NEVER;
    }
  });
}
const place = corePlaceCheck((v) => checkPlace(v));
const near = corePlaceCheck((v) => checkNear(v));
const within = corePlaceCheck((v) => checkPlacePath(v, 'within'));
const level = z.enum(['self', 'planet', 'star', 'constellation', 'galaxy']);

export const OptionsSchema = z.strictObject({
  mode: z.enum(['auto', 'local', 'cloud']).optional(),
  home: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  project: z.union([z.string().regex(NAME), z.null()]).optional(),
  projectConfig: z.boolean().optional(),
  agent: z.string().min(1).max(64).optional(),
  user: z.string().optional(),
  org: z.string().optional(),
  keys: z
    .strictObject({
      voyage: z.string().min(1).optional(),
      typesafe: z.string().min(1).optional(),
      anthropic: z.string().min(1).optional(),
      oort: z.string().min(1).optional(),
    })
    .optional(),
  keySources: z.array(z.enum(['explicit', 'env', 'keychain'])).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  url: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  migrate: z.boolean().optional(),
  env: z.record(z.string(), z.union([z.string(), z.undefined()])).optional(),
  fetch: z.custom<typeof fetch>((v) => typeof v === 'function').optional(),
  judge: z
    .strictObject({
      role: z.enum(['agent', 'expert']),
      operator: z.string().trim().min(1).max(128).optional(),
    })
    .optional(),
});

export const RecallOptionsSchema = z.strictObject({
  limit: z.number().int().min(1).max(LIMITS.recallLimit).optional(),
  mode: z.enum(['current', 'as-of', 'history', 'known-at']).optional(),
  asOf: isoDate.optional(),
  knownAt: isoDate.optional(),
  include: z.array(level).min(1).optional(),
  budgetChars: z.number().int().positive().optional(),
  includeWithdrawn: z.boolean().optional(),
  speed: z.enum(['full', 'fast', 'lexical']).optional(),
  inferTime: z.boolean().optional(),
  within: within.optional(),
  near: near.optional(),
  signal: signal.optional(),
});

export const QuerySchema = z
  .string()
  .refine((s) => s.trim() !== '')
  .refine((s) => utf8Bytes(s) <= LIMITS.queryBytes);

export const TurnSchema = z
  .strictObject({
    user: z.string(),
    assistant: z.string(),
    tools: z.array(z.string()).optional(),
    at: isoDate.optional(),
    sessionId: z.string().min(1).max(256).optional(),
    turnRef: z.string().min(1).max(LIMITS.turnRef).optional(),
    place: place.optional(),
  })
  .refine(
    (t) =>
      utf8Bytes(t.user) +
        utf8Bytes(t.assistant) +
        (t.tools ?? []).reduce((n, x) => n + utf8Bytes(x), 0) <=
      LIMITS.turnBytes,
    { path: ['user'], message: 'too large' },
  );

export const SignalOnlySchema = z.strictObject({ signal: signal.optional() });

export const FactsSchema = z
  .array(z.string().refine((s) => s.trim() !== '' && s.length <= LIMITS.factChars))
  .min(1)
  .max(LIMITS.rememberFacts);

export const RememberOptionsSchema = z.strictObject({
  type: z.enum(['semantic', 'episodic', 'procedural', 'preference']).optional(),
  place: place.optional(),
});

export const IdSchema = z
  .string()
  .min(LIMITS.idMinPrefix)
  .max(LIMITS.idMax)
  .regex(/^[A-Za-z0-9_:.-]+$/);

export const ForgetOptionsSchema = z.strictObject({ everywhere: z.boolean().optional() });

export const RecentOptionsSchema = z.strictObject({
  since: isoDate.optional(),
  limit: z.number().int().min(1).max(LIMITS.recentLimit).optional(),
});

export const JudgmentInputSchema = z.strictObject({
  subject: z.string(),
  ref: z.string().optional(),
  verdict: z.string(),
  verdicts: z.array(z.string()).optional(),
  reason: z.string(),
  criteria: z.array(z.string()).optional(),
  domain: z.string(),
  by: z.string(),
  decidedAt: isoDate.optional(),
});

export const JudgeItemSchema = z.union([
  z.string().min(1),
  z.strictObject({
    summary: z.string().min(1),
    details: z.string().optional(),
    ref: z.string().optional(),
    domain: z.string().optional(),
    by: z.string().optional(),
  }),
]);

export const JudgeOptionsSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).optional(),
  threshold: z.number().min(0).max(1).optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
  minAgreement: z.number().min(0).max(1).optional(),
  includeImported: z.boolean().optional(),
  includeAgentRecorded: z.boolean().optional(),
});

export const JudgeListSchema = z.strictObject({
  domain: z.string().optional(),
  by: z.string().optional(),
  all: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const ConsolidateSchema = z.strictObject({
  budgetMs: z.number().int().positive().optional(),
  signal: signal.optional(),
});

export const ScopedSchema = z.strictObject({
  user: z.string().optional(),
  project: z.union([z.string().regex(NAME), z.null()]).optional(),
  agent: z.string().min(1).max(64).optional(),
  judgeRole: z.literal('agent').optional(),
});

/** An ISO string for a validated `string | Date`. */
export const iso = (d: string | Date): string => new Date(d).toISOString();
