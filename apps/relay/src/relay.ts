import type { D1DatabaseLike } from './d1.js';
import { hashKey } from './keys.js';

/**
 * Oort Pro relay: an authenticated, allow-listed reverse proxy in front of Voyage, TypeSafe and
 * Anthropic. The caller holds one Oort key; we hold the vendor keys.
 *
 * Rules this file keeps (spec §2 anti-goals, §3):
 * - It never logs, stores or inspects content beyond the allowlist checks. There is no console
 *   call in this handler, and error responses never echo a request body or an upstream body.
 * - Vendor keys only ever go upstream. Upstream response headers are filtered to an allowlist.
 * - Every forwarded call is metered against a monthly cap per account, reserved before the call
 *   and refunded when the provider did no work.
 * - What is forwarded is the object that was checked, re-serialised: never the caller's bytes.
 */

/** The Workers Rate Limiting binding. */
export interface RateLimitLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RelayEnv {
  DB: D1DatabaseLike;
  /** 60 per 10 s: keyed by the key hash, and again by `account:<id>` across an account's keys. */
  RATE_LIMITER: RateLimitLike;
  /** Failed sign-ins per IP (`ip:<address>`): unknown or revoked keys. */
  AUTH_LIMITER: RateLimitLike;
  VOYAGE_API_KEY: string;
  TYPESAFE_API_KEY: string;
  ANTHROPIC_API_KEY: string;
}

export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RelayDeps {
  fetch?: typeof fetch;
  now?: () => Date;
}

export const MAX_BODY_BYTES = 256 * 1024;
/** The writer's prompt plus 32 KB of user and assistant text each fits well inside this. */
export const MAX_MESSAGES_BODY_BYTES = 128 * 1024;
/** Per-field caps; one over returns 413 before any upstream call or metering. */
export const MAX_RERANK_QUERY_BYTES = 2 * 1024;
export const MAX_RERANK_DOCUMENT_BYTES = 4 * 1024;
export const MAX_EMBED_INPUT_BYTES = 8 * 1024;
/** Jev requests are small: state plus a handful of questions. */
export const MAX_TYPESAFE_BODY_BYTES = 64 * 1024;
export const ACCOUNT_URL = 'https://oortcloud.dev/account';
export const RATE_LIMIT = { requests: 60, seconds: 10 } as const;
/** Keys the site mints: `oort_sk_` plus 32 random bytes, base64url (43 characters). */
export const KEY_SHAPE = /^oort_sk_[A-Za-z0-9_-]{43}$/;
/** A subscription whose period ended this long ago is denied even if no webhook arrived. */
export const PERIOD_GRACE_MS = 3 * 24 * 3600_000;

/** Monthly counters in D1 `usage`. saves and recalls are the user-facing units. */
export const COUNTERS = [
  'saves',
  'recalls',
  'embed_inputs',
  'rerank_calls',
  'decide_calls',
] as const;
export type Counter = (typeof COUNTERS)[number];

/**
 * Monthly hard caps per plan and account. saves and recalls are Structure A in
 * docs/research/2026-11-04-pricing.md and `rates.managed.Pro` in apps/site/src/lib/oort-data.ts
 * (a test keeps them equal). The other three bound what each route can cost.
 */
export const PLAN_LIMITS = {
  pro: {
    saves: 25_000,
    recalls: 50_000,
    embed_inputs: 200_000,
    rerank_calls: 60_000,
    decide_calls: 150_000,
  },
} as const satisfies Record<string, Record<Counter, number>>;

type Limits = Record<Counter, number>;

function limitsFor(plan: string): Limits | undefined {
  return (PLAN_LIMITS as Record<string, Limits | undefined>)[plan];
}

const CAP_LABEL: Record<Counter, string> = {
  saves: 'saves',
  recalls: 'recalls',
  embed_inputs: 'embed inputs',
  rerank_calls: 'rerank calls',
  decide_calls: 'decide calls',
};

const ENTITLED = new Set(['active', 'trialing']);

export const MODELS = {
  embed: ['voyage-3.5-lite'],
  // Both lite rerank models are allowed: rerank-3-lite is the engine default in
  // packages/core/src/config.ts, so Pro users get it unless they change their config, and
  // rerank-2.5-lite is the previous lite model that the launch spec names and older configs use.
  // Non-lite models (rerank-2.5, rerank-3) cost several times more and stay blocked.
  rerank: ['rerank-3-lite', 'rerank-2.5-lite'],
  messages: ['claude-haiku-5-5'],
  // The model @oortmem/decide-jev uses: the TypeSafe SDK's default, which the adapter pins in
  // relay mode. A body without a model gets this one.
  decide: ['jev-latest'],
} as const;
export const MAX_EMBED_INPUTS = 128;
export const MAX_RERANK_DOCUMENTS = 100;
export const MAX_OUTPUT_TOKENS = 2048;
export const MAX_DECIDE_QUESTIONS = 32;

type Check =
  | {
      error: string;
      /** 413 for a field over its size cap; 400 (the default) for anything else. */
      status?: 413;
    }
  | {
      /** The checked object; this, re-serialised, is what goes upstream. */
      body: Record<string, unknown>;
      /** Counter increments reserved before the call. */
      add: Partial<Record<Counter, number>>;
      /** Counters that must be below their cap, without being incremented. */
      gate: Counter[];
    };
type Provider = 'voyage' | 'typesafe' | 'anthropic';

interface Route {
  path: string;
  upstream: string;
  provider: Provider;
  maxBytes: number;
  check: (body: Record<string, unknown>) => Check;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((s) => typeof s === 'string');
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/** The first key of `o` outside `allowed`, if any. */
function unknownKey(o: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(o).find((k) => !allowed.has(k));
}

const encoder = new TextEncoder();
/** True when `s` is longer than `max` UTF-8 bytes. */
const overBytes = (s: string, max: number): boolean =>
  s.length > max || (s.length * 3 > max && encoder.encode(s).byteLength > max);

const tooLarge = (what: string, max: number): { error: string; status: 413 } => ({
  error: `${what} is larger than ${max / 1024} KB.`,
  status: 413,
});

const notAvailable = (field: string): { error: string } => ({
  error: `${field} is not available through Oort Pro.`,
});

const EMBED_FIELDS = new Set([
  'model',
  'input',
  'input_type',
  'truncation',
  'output_dimension',
  'output_dtype',
  'encoding_format',
]);

function checkEmbeddings(b: Record<string, unknown>): Check {
  const extra = unknownKey(b, EMBED_FIELDS);
  if (extra !== undefined) return notAvailable(extra);
  if (!(MODELS.embed as readonly unknown[]).includes(b['model'])) {
    return {
      error: `Only ${MODELS.embed.join(', ')} is available for embeddings through Oort Pro.`,
    };
  }
  const input = b['input'];
  const n = typeof input === 'string' ? 1 : isStrings(input) ? input.length : -1;
  if (n < 1) return { error: 'input must be a string or a non-empty list of strings.' };
  if (n > MAX_EMBED_INPUTS) {
    return { error: `Send at most ${MAX_EMBED_INPUTS} inputs per embeddings call.` };
  }
  if (
    (typeof input === 'string' ? [input] : (input as string[])).some((t) =>
      overBytes(t, MAX_EMBED_INPUT_BYTES),
    )
  ) {
    return tooLarge('An embedding input', MAX_EMBED_INPUT_BYTES);
  }
  const kind = b['input_type'];
  if (kind !== 'query' && kind !== 'document') {
    return { error: 'input_type must be "query" or "document".' };
  }
  // Every input is counted. A query embedding is also the one recall an engine recall makes.
  // Document embeddings are part of a save (counted by the Anthropic call) and stop at the
  // save cap.
  return kind === 'query'
    ? { body: b, add: { embed_inputs: n, recalls: 1 }, gate: [] }
    : { body: b, add: { embed_inputs: n }, gate: ['saves'] };
}

const RERANK_FIELDS = new Set([
  'model',
  'query',
  'documents',
  'top_k',
  'truncation',
  'return_documents',
]);

function checkRerank(b: Record<string, unknown>): Check {
  const extra = unknownKey(b, RERANK_FIELDS);
  if (extra !== undefined) return notAvailable(extra);
  if (!(MODELS.rerank as readonly unknown[]).includes(b['model'])) {
    return {
      error: `Only ${MODELS.rerank.join(' or ')} is available for rerank through Oort Pro.`,
    };
  }
  if (typeof b['query'] !== 'string') return { error: 'query must be a string.' };
  const docs = b['documents'];
  if (!isStrings(docs) || docs.length < 1) {
    return { error: 'documents must be a non-empty list of strings.' };
  }
  if (docs.length > MAX_RERANK_DOCUMENTS) {
    return {
      error: `Send at most ${MAX_RERANK_DOCUMENTS} documents per rerank call.`,
      status: 413,
    };
  }
  if (overBytes(b['query'], MAX_RERANK_QUERY_BYTES)) {
    return tooLarge('The rerank query', MAX_RERANK_QUERY_BYTES);
  }
  if (docs.some((d) => overBytes(d, MAX_RERANK_DOCUMENT_BYTES))) {
    return tooLarge('A rerank document', MAX_RERANK_DOCUMENT_BYTES);
  }
  // The rerank in an engine recall is not a second recall, but it is counted as a rerank call
  // and stops at the recall cap like the rest of the recall.
  return { body: b, add: { rerank_calls: 1 }, gate: ['recalls'] };
}

const DECIDE_FIELDS = new Set(['state', 'questions', 'model']);
const QUESTION_FIELDS = new Set(['type', 'instructions', 'criteria']);
// `box` needs an image and jev-preview; decide-jev asks only these three.
const QUESTION_TYPES = new Set(['noul', 'score', 'choice']);

function checkDecide(b: Record<string, unknown>): Check {
  const extra = unknownKey(b, DECIDE_FIELDS);
  if (extra !== undefined) return notAvailable(extra);
  const model = b['model'] ?? MODELS.decide[0];
  if (!(MODELS.decide as readonly unknown[]).includes(model)) {
    return { error: `Only ${MODELS.decide.join(', ')} is available for Jev through Oort Pro.` };
  }
  if (b['state'] === undefined || b['state'] === null) return { error: 'state is required.' };
  const q = b['questions'];
  if (!isObj(q)) return { error: 'questions must be an object.' };
  const entries = Object.values(q);
  if (entries.length < 1 || entries.length > MAX_DECIDE_QUESTIONS) {
    return { error: `Send 1 to ${MAX_DECIDE_QUESTIONS} questions per Jev call.` };
  }
  for (const v of entries) {
    if (!isObj(v) || !QUESTION_TYPES.has(v['type'] as string)) {
      return { error: 'Each question must be a noul, score or choice question.' };
    }
    const bad = unknownKey(v, QUESTION_FIELDS);
    if (bad !== undefined) return notAvailable(`questions.*.${bad}`);
  }
  return {
    body: { state: b['state'], questions: q, model },
    add: { decide_calls: 1 },
    gate: ['saves'],
  };
}

const MESSAGE_FIELDS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'stop_sequences',
  'metadata',
  'stream',
  'thinking',
  'output_config',
]);
const THINKING_TYPES = new Set(['disabled', 'enabled', 'adaptive']);

/** Plain text only: a string, or `{type: "text", text}` blocks (no images, documents, caching). */
function textOnly(content: unknown, where: string): string | undefined {
  if (typeof content === 'string') return undefined;
  if (!Array.isArray(content)) return `${where} must be a string or a list of text blocks.`;
  for (const block of content) {
    if (!isObj(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') {
      return `${where} may hold only text blocks through Oort Pro.`;
    }
    const bad = unknownKey(block, new Set(['type', 'text']));
    if (bad !== undefined) return `${where}: ${bad} is not available through Oort Pro.`;
  }
  return undefined;
}

function checkMessages(b: Record<string, unknown>): Check {
  const extra = unknownKey(b, MESSAGE_FIELDS);
  if (extra !== undefined) return notAvailable(extra);
  if (!(MODELS.messages as readonly unknown[]).includes(b['model'])) {
    return { error: `Only ${MODELS.messages.join(', ')} is available through Oort Pro.` };
  }
  const max = b['max_tokens'];
  if (!isInt(max) || max < 1 || max > MAX_OUTPUT_TOKENS) {
    return { error: `max_tokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}.` };
  }
  const messages = b['messages'];
  if (!Array.isArray(messages)) return { error: 'messages must be a list.' };
  for (const m of messages) {
    if (!isObj(m) || (m['role'] !== 'user' && m['role'] !== 'assistant')) {
      return { error: 'Each message needs role "user" or "assistant".' };
    }
    const bad = unknownKey(m, new Set(['role', 'content']));
    if (bad !== undefined) return notAvailable(`messages.*.${bad}`);
    const e = textOnly(m['content'], 'Message content');
    if (e !== undefined) return { error: e };
  }
  if (b['system'] !== undefined) {
    const e = textOnly(b['system'], 'system');
    if (e !== undefined) return { error: e };
  }
  if (b['stop_sequences'] !== undefined && !isStrings(b['stop_sequences'])) {
    return { error: 'stop_sequences must be a list of strings.' };
  }
  const meta = b['metadata'];
  if (
    meta !== undefined &&
    (!isObj(meta) ||
      unknownKey(meta, new Set(['user_id'])) !== undefined ||
      (meta['user_id'] !== undefined && typeof meta['user_id'] !== 'string'))
  ) {
    return { error: 'metadata may hold only user_id.' };
  }
  if (b['stream'] !== undefined && typeof b['stream'] !== 'boolean') {
    return { error: 'stream must be true or false.' };
  }
  const thinking = b['thinking'];
  if (
    thinking !== undefined &&
    (!isObj(thinking) ||
      !THINKING_TYPES.has(thinking['type'] as string) ||
      unknownKey(thinking, new Set(['type', 'budget_tokens'])) !== undefined ||
      (thinking['budget_tokens'] !== undefined &&
        (!isInt(thinking['budget_tokens']) || thinking['budget_tokens'] > MAX_OUTPUT_TOKENS)))
  ) {
    return { error: 'thinking is not available in that form through Oort Pro.' };
  }
  const out = b['output_config'];
  if (out !== undefined) {
    if (!isObj(out) || unknownKey(out, new Set(['format', 'effort'])) !== undefined) {
      return { error: 'output_config may hold only format and effort.' };
    }
    const format = out['format'];
    if (
      format !== undefined &&
      (!isObj(format) || format['type'] !== 'json_schema' || !isObj(format['schema']))
    ) {
      return { error: 'output_config.format must be a json_schema format.' };
    }
    if (out['effort'] !== undefined && typeof out['effort'] !== 'string') {
      return { error: 'output_config.effort must be a string.' };
    }
  }
  return { body: b, add: { saves: 1 }, gate: [] };
}

export const ROUTES: readonly Route[] = [
  {
    path: '/v1/voyage/embeddings',
    upstream: 'https://api.voyageai.com/v1/embeddings',
    provider: 'voyage',
    maxBytes: MAX_BODY_BYTES,
    check: checkEmbeddings,
  },
  {
    path: '/v1/voyage/rerank',
    upstream: 'https://api.voyageai.com/v1/rerank',
    provider: 'voyage',
    maxBytes: MAX_BODY_BYTES,
    check: checkRerank,
  },
  {
    // The only path @typesafe-ai/sdk 0.7.0 calls for `systemOne` (POST {baseURL}/v1/systemone).
    // decide-jev sends plain JSON in relay mode (compression off), so it is checked like the rest.
    path: '/v1/typesafe/v1/systemone',
    upstream: 'https://api.typesafe.ai/v1/systemone',
    provider: 'typesafe',
    maxBytes: MAX_TYPESAFE_BODY_BYTES,
    check: checkDecide,
  },
  {
    path: '/v1/anthropic/v1/messages',
    upstream: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic',
    maxBytes: MAX_MESSAGES_BODY_BYTES,
    check: checkMessages,
  },
];

const BASE_HEADERS = { 'cache-control': 'no-store' };

function fail(
  status: number,
  error: string,
  extra: Record<string, string> = {},
  reason?: string,
): Response {
  return Response.json(reason === undefined ? { error } : { error, reason }, {
    status,
    headers: { ...BASE_HEADERS, ...extra },
  });
}

const BUSY = 'Oort Pro is busy, try again shortly.';
const UNAVAILABLE = 'Oort Pro is briefly unavailable. Try again in a moment.';

/** The caller's Oort key, only when it has the exact shape the site mints. */
function callerKey(h: Headers): string | null {
  const auth = h.get('authorization');
  const bearer = auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = bearer ?? h.get('x-api-key')?.trim() ?? null;
  return key !== null && KEY_SHAPE.test(key) ? key : null;
}

/** Reads at most `max` bytes. Returns null when the body is larger. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function nextMonthName(now: Date): string {
  return MONTHS[(now.getUTCMonth() + 1) % 12]!;
}

function capMessage(c: Counter, cap: number, now: Date): string {
  const n = cap.toLocaleString('en-US');
  const reset = `1 ${nextMonthName(now)} (UTC)`;
  if (c === 'saves' || c === 'recalls') {
    const word = CAP_LABEL[c];
    return `You have used the ${n} ${word} included in Oort Pro this month. ${word[0]!.toUpperCase()}${word.slice(1)} start again on ${reset}. Usage is at ${ACCOUNT_URL}.`;
  }
  return `This account has reached Oort Pro's monthly limit of ${n} ${CAP_LABEL[c]}. It resets on ${reset}. Usage is at ${ACCOUNT_URL}.`;
}

function upstreamHeaders(route: Route, env: RelayEnv, h: Headers): Headers {
  const out = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
  switch (route.provider) {
    case 'voyage':
      out.set('authorization', `Bearer ${env.VOYAGE_API_KEY}`);
      break;
    case 'typesafe': {
      out.set('authorization', `Bearer ${env.TYPESAFE_API_KEY}`);
      const retry = h.get('x-typesafe-retry-count');
      if (retry !== null && /^\d{1,2}$/.test(retry)) out.set('x-typesafe-retry-count', retry);
      break;
    }
    case 'anthropic': {
      out.set('x-api-key', env.ANTHROPIC_API_KEY);
      const version = h.get('anthropic-version');
      out.set(
        'anthropic-version',
        version !== null && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : '2023-06-01',
      );
      break;
    }
  }
  return out;
}

/** Response headers we pass back on success. Everything else (request ids, cookies, key echoes) is dropped. */
function responseHeaders(up: Headers): Headers {
  const out = new Headers(BASE_HEADERS);
  const type = up.get('content-type');
  if (type !== null) out.set('content-type', type);
  const retry = retryAfter(up);
  if (retry !== undefined) out.set('retry-after', retry);
  return out;
}

/** A provider's Retry-After, only as a small whole number of seconds. */
function retryAfter(up: Headers): string | undefined {
  const v = up.get('retry-after')?.trim();
  return v !== undefined && /^\d{1,3}$/.test(v) ? v : undefined;
}

interface KeyRow {
  key_id: string;
  account_id: string;
  revoked_at: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
}

type Need = Record<Counter, number>;

/** What each counter must have left: its increment, or 1 for a gate. */
function needOf(add: Partial<Record<Counter, number>>, gate: readonly Counter[]): Need {
  const out = {} as Need;
  for (const c of COUNTERS) out[c] = Math.max(add[c] ?? 0, gate.includes(c) ? 1 : 0);
  return out;
}

const UPSERT_USAGE = `INSERT INTO usage (account_id, month, ${COUNTERS.join(', ')})
  VALUES (?, ?, ${COUNTERS.map(() => '?').join(', ')})
  ON CONFLICT (account_id, month) DO UPDATE SET
    ${COUNTERS.map((c) => `${c} = usage.${c} + excluded.${c}`).join(', ')}
  WHERE ${COUNTERS.map((c) => `usage.${c} + ? <= ?`).join(' AND ')}`;

const REFUND_USAGE = `UPDATE usage SET ${COUNTERS.map((c) => `${c} = MAX(${c} - ?, 0)`).join(', ')}
  WHERE account_id = ? AND month = ?`;

/**
 * Reserves the call's counters in one conditional statement, so concurrent calls cannot pass a
 * cap. Returns null when reserved, or the counter whose cap refused it.
 */
async function reserve(
  db: D1DatabaseLike,
  account: string,
  month: string,
  add: Partial<Record<Counter, number>>,
  need: Need,
  limits: Limits,
): Promise<Counter | null> {
  const r = await db
    .prepare(UPSERT_USAGE)
    .bind(
      account,
      month,
      ...COUNTERS.map((c) => add[c] ?? 0),
      ...COUNTERS.flatMap((c) => [need[c], need[c] > 0 ? limits[c] : Number.MAX_SAFE_INTEGER]),
    )
    .run();
  if (r.meta.changes > 0) return null;
  const row = await db
    .prepare(`SELECT ${COUNTERS.join(', ')} FROM usage WHERE account_id = ? AND month = ?`)
    .bind(account, month)
    .first<Record<Counter, number>>();
  return (
    COUNTERS.find((c) => need[c] > 0 && (row?.[c] ?? 0) + need[c] > limits[c]) ??
    COUNTERS.find((c) => need[c] > 0) ??
    'saves'
  );
}

export async function handleRelay(
  request: Request,
  env: RelayEnv,
  ctx: WaitUntilLike,
  deps: RelayDeps = {},
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    // Unauthenticated liveness for `oort doctor`: no D1, no rate limiter, no upstream.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'Use GET.', { allow: 'GET, HEAD' });
    }
    return Response.json({ ok: true }, { headers: BASE_HEADERS });
  }

  const route = ROUTES.find((r) => r.path === url.pathname);
  if (!route) return fail(404, 'Not found. See https://oortcloud.dev/docs for the relay routes.');
  if (request.method !== 'POST') return fail(405, 'Use POST.', { allow: 'POST' });

  // The key's shape is checked before any limiter or D1 work.
  const key = callerKey(request.headers);
  if (!key) {
    return fail(
      401,
      `Send your Oort key as "Authorization: Bearer oort_sk_...". Get one at ${ACCOUNT_URL}.`,
    );
  }
  const hash = await hashKey(key);

  const limited = (scope: string) =>
    fail(
      429,
      `Too many requests: Oort Pro allows ${RATE_LIMIT.requests} requests every ${RATE_LIMIT.seconds} seconds per ${scope}. Wait a few seconds and try again.`,
      { 'retry-after': String(RATE_LIMIT.seconds) },
      `rate limit: ${scope}`,
    );
  if (!(await env.RATE_LIMITER.limit({ key: hash })).success) return limited('key');

  let row: KeyRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT k.id AS key_id, k.account_id, k.revoked_at, a.plan, a.status, a.current_period_end
         FROM api_keys k JOIN accounts a ON a.id = k.account_id
        WHERE k.hash = ?`,
    )
      .bind(hash)
      .first<KeyRow>();
  } catch {
    return fail(503, UNAVAILABLE);
  }
  if (!row || row.revoked_at !== null) {
    // Failed sign-ins count against the caller's IP, so guessing keys is throttled.
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await env.AUTH_LIMITER.limit({ key: `ip:${ip}` })).success) {
      return fail(
        429,
        'Too many requests with keys that are not valid. Wait a minute and try again.',
        { 'retry-after': '60' },
        'rate limit: failed sign-ins',
      );
    }
    return row
      ? fail(401, `This Oort key was revoked. Create a new one at ${ACCOUNT_URL}.`)
      : fail(401, `This Oort key is not valid. Create a new one at ${ACCOUNT_URL}.`);
  }
  const limits = limitsFor(row.plan);
  const periodEnd = row.current_period_end === null ? NaN : Date.parse(row.current_period_end);
  const lapsed = Number.isFinite(periodEnd) && now.getTime() > periodEnd + PERIOD_GRACE_MS;
  if (!ENTITLED.has(row.status) || !limits || lapsed) {
    return fail(
      402,
      `Oort Pro is not active on this account. Subscribe or update billing at ${ACCOUNT_URL}.`,
    );
  }
  if (!(await env.RATE_LIMITER.limit({ key: `account:${row.account_id}` })).success) {
    return limited('account');
  }

  const encoding = request.headers.get('content-encoding');
  if (encoding !== null && encoding !== 'identity') {
    return fail(415, 'Send this request uncompressed.');
  }
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return fail(415, 'Send content-type: application/json.');
  }
  const raw = await readCapped(request, route.maxBytes);
  if (raw === null) {
    return fail(413, `The request body is larger than ${route.maxBytes / 1024} KB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fail(400, 'The request body must be JSON.');
  }
  if (!isObj(parsed)) return fail(400, 'The request body must be a JSON object.');
  const c = route.check(parsed);
  if ('error' in c) return fail(c.status ?? 400, c.error);

  const month = now.toISOString().slice(0, 7);
  const account = row.account_id;
  const need = needOf(c.add, c.gate);
  let refused: Counter | null;
  try {
    refused = await reserve(env.DB, account, month, c.add, need, limits);
  } catch {
    return fail(503, UNAVAILABLE);
  }
  if (refused !== null) {
    return fail(
      429,
      capMessage(refused, limits[refused], now),
      {},
      `monthly cap: ${CAP_LABEL[refused]}`,
    );
  }

  const keyId = row.key_id;
  const stamp = now.toISOString();
  const settle = (refund: boolean) =>
    ctx.waitUntil(
      (async () => {
        const writes = [
          env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(stamp, keyId),
        ];
        if (refund) {
          writes.push(
            env.DB.prepare(REFUND_USAGE).bind(
              ...COUNTERS.map((k) => c.add[k] ?? 0),
              account,
              month,
            ),
          );
        }
        await env.DB.batch(writes);
      })().catch(() => undefined),
    );

  let upstream: Response;
  try {
    upstream = await doFetch(route.upstream, {
      method: 'POST',
      headers: upstreamHeaders(route, env, request.headers),
      body: JSON.stringify(c.body),
    });
  } catch {
    // The caller left (it closed the connection): the provider may well have done the work, so the
    // reservation stays. A failure with the caller still there is refunded.
    settle(!request.signal.aborted);
    return fail(502, 'The provider could not be reached. Try again in a moment.');
  }

  if (upstream.ok) {
    settle(false);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
    });
  }

  // No upstream error body is passed on: it can name our organisation, its limits or ids.
  void upstream.body?.cancel().catch(() => undefined);
  const s = upstream.status;
  if (s === 401 || s === 403) {
    settle(true);
    return fail(
      502,
      'The relay could not sign in to the provider. This is on our side; try again later.',
    );
  }
  if (s === 429 || s >= 500) {
    // The provider is rate-limited or failing for everyone: not this account's cap.
    settle(true);
    const retry = retryAfter(upstream.headers);
    return fail(503, BUSY, retry === undefined ? {} : { 'retry-after': retry }, 'upstream busy');
  }
  settle(false);
  if (s >= 400) return fail(s, `The provider rejected this request (HTTP ${s}).`);
  return fail(502, 'The provider sent an unexpected answer. Try again later.');
}
