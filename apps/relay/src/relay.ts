import type { D1DatabaseLike } from './d1.js';
import { KEY_PREFIX, hashKey } from './keys.js';

/**
 * Oort Pro relay: an authenticated, allow-listed reverse proxy in front of Voyage, TypeSafe and
 * Anthropic. The caller holds one Oort key; we hold the vendor keys.
 *
 * Rules this file keeps (spec §2 anti-goals, §3):
 * - It never logs, stores or inspects content beyond the allowlist checks. There is no console
 *   call anywhere in this package, and error responses never echo a request body.
 * - Vendor keys only ever go upstream. Upstream response headers are filtered to an allowlist.
 */

/** The Workers Rate Limiting binding. */
export interface RateLimitLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RelayEnv {
  DB: D1DatabaseLike;
  RATE_LIMITER: RateLimitLike;
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
export const ACCOUNT_URL = 'https://oortcloud.dev/account';
export const RATE_LIMIT = { requests: 60, seconds: 10 } as const;

/**
 * Monthly hard caps per plan: Structure A in docs/research/2026-11-04-pricing.md and
 * `rates.managed.Pro` in apps/site/src/lib/oort-data.ts (a test keeps them equal).
 */
export const PLAN_LIMITS = {
  pro: { saves: 25_000, recalls: 50_000 },
} as const satisfies Record<string, { saves: number; recalls: number }>;

function limitsFor(plan: string): { saves: number; recalls: number } | undefined {
  return (PLAN_LIMITS as Record<string, { saves: number; recalls: number } | undefined>)[plan];
}

const ENTITLED = new Set(['active', 'trialing']);

export const MODELS = {
  embed: ['voyage-3.5-lite'],
  // Both lite rerank models are allowed: rerank-3-lite is the engine default in
  // packages/core/src/config.ts, so Pro users get it unless they change their config, and
  // rerank-2.5-lite is the previous lite model that the launch spec names and older configs use.
  // Non-lite models (rerank-2.5, rerank-3) cost several times more and stay blocked.
  rerank: ['rerank-3-lite', 'rerank-2.5-lite'],
  messages: ['claude-haiku-5-5'],
} as const;
export const MAX_EMBED_INPUTS = 128;
export const MAX_RERANK_DOCUMENTS = 100;
export const MAX_OUTPUT_TOKENS = 2048;
const FORBIDDEN_MESSAGE_FIELDS = ['tools', 'tool_choice', 'mcp_servers', 'container'];

type Pool = 'saves' | 'recalls';
type Check = { error: string } | { meter: Pool | null; pool: Pool };
type Provider = 'voyage' | 'typesafe' | 'anthropic';

interface Route {
  path: string;
  upstream: string;
  provider: Provider;
  /** The body must be plain JSON so the allowlist can be checked. */
  check?: (body: Record<string, unknown>) => Check;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((s) => typeof s === 'string');

function checkEmbeddings(b: Record<string, unknown>): Check {
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
  const kind = b['input_type'];
  if (kind !== undefined && kind !== null && kind !== 'query' && kind !== 'document') {
    return { error: 'input_type must be query or document.' };
  }
  // A query embedding is one recall. Document embeddings are part of a save, counted by the
  // Anthropic call, but stop at the save cap.
  return kind === 'query' ? { meter: 'recalls', pool: 'recalls' } : { meter: null, pool: 'saves' };
}

function checkRerank(b: Record<string, unknown>): Check {
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
    return { error: `Send at most ${MAX_RERANK_DOCUMENTS} documents per rerank call.` };
  }
  // One engine recall is counted once, by its query embedding. The rerank in the same recall is
  // not counted, but it stops at the recall cap like the rest of the recall.
  return { meter: null, pool: 'recalls' };
}

function checkMessages(b: Record<string, unknown>): Check {
  if (!(MODELS.messages as readonly unknown[]).includes(b['model'])) {
    return { error: `Only ${MODELS.messages.join(', ')} is available through Oort Pro.` };
  }
  const max = b['max_tokens'];
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_OUTPUT_TOKENS) {
    return { error: `max_tokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}.` };
  }
  for (const f of FORBIDDEN_MESSAGE_FIELDS) {
    if (b[f] !== undefined) return { error: `${f} is not available through Oort Pro.` };
  }
  return { meter: 'saves', pool: 'saves' };
}

export const ROUTES: readonly Route[] = [
  {
    path: '/v1/voyage/embeddings',
    upstream: 'https://api.voyageai.com/v1/embeddings',
    provider: 'voyage',
    check: checkEmbeddings,
  },
  {
    path: '/v1/voyage/rerank',
    upstream: 'https://api.voyageai.com/v1/rerank',
    provider: 'voyage',
    check: checkRerank,
  },
  {
    // The only path @typesafe-ai/sdk 0.7.0 calls for `systemOne` (POST {baseURL}/v1/systemone).
    // Its body may be zstd-compressed or multipart, so it is forwarded byte for byte.
    path: '/v1/typesafe/v1/systemone',
    upstream: 'https://api.typesafe.ai/v1/systemone',
    provider: 'typesafe',
  },
  {
    path: '/v1/anthropic/v1/messages',
    upstream: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic',
    check: checkMessages,
  },
];

const BASE_HEADERS = { 'cache-control': 'no-store' };

function fail(status: number, error: string, extra: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { ...BASE_HEADERS, ...extra } });
}

function callerKey(h: Headers): string | null {
  const auth = h.get('authorization');
  const bearer = auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = bearer ?? h.get('x-api-key')?.trim() ?? null;
  return key !== null && key.startsWith(KEY_PREFIX) && key.length > KEY_PREFIX.length ? key : null;
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

function upstreamHeaders(route: Route, env: RelayEnv, h: Headers): Headers {
  const out = new Headers({ accept: 'application/json' });
  switch (route.provider) {
    case 'voyage':
      out.set('authorization', `Bearer ${env.VOYAGE_API_KEY}`);
      out.set('content-type', 'application/json');
      break;
    case 'typesafe': {
      out.set('authorization', `Bearer ${env.TYPESAFE_API_KEY}`);
      out.set('content-type', h.get('content-type') ?? 'application/json');
      const enc = h.get('content-encoding');
      if (enc !== null) out.set('content-encoding', enc);
      const retry = h.get('x-typesafe-retry-count');
      if (retry !== null && /^\d{1,2}$/.test(retry)) out.set('x-typesafe-retry-count', retry);
      break;
    }
    case 'anthropic': {
      out.set('x-api-key', env.ANTHROPIC_API_KEY);
      out.set('content-type', 'application/json');
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

/** Response headers we pass back. Everything else (request ids, cookies, key echoes) is dropped. */
const KEEP_RESPONSE_HEADERS = ['content-type', 'retry-after'];

function responseHeaders(up: Headers): Headers {
  const out = new Headers(BASE_HEADERS);
  for (const name of KEEP_RESPONSE_HEADERS) {
    const v = up.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

function scrubKeys(s: string, env: RelayEnv): string {
  let out = s;
  for (const k of [env.VOYAGE_API_KEY, env.TYPESAFE_API_KEY, env.ANTHROPIC_API_KEY]) {
    if (k) out = out.split(k).join('[redacted]');
  }
  return out;
}

/** An upstream error body with our keys and upstream request ids removed. */
function cleanErrorBody(raw: string, env: RelayEnv): string {
  let text = raw;
  try {
    const j: unknown = JSON.parse(raw);
    if (isObj(j)) {
      delete j['request_id'];
      delete j['requestId'];
      text = JSON.stringify(j);
    }
  } catch {
    // Not JSON; pass the scrubbed text through.
  }
  return scrubKeys(text, env);
}

interface KeyRow {
  key_id: string;
  account_id: string;
  revoked_at: string | null;
  plan: string;
  status: string;
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

  const key = callerKey(request.headers);
  if (!key) {
    return fail(
      401,
      `Send your Oort key as "Authorization: Bearer oort_sk_...". Get one at ${ACCOUNT_URL}.`,
    );
  }
  const hash = await hashKey(key);

  const { success } = await env.RATE_LIMITER.limit({ key: hash });
  if (!success) {
    return fail(
      429,
      `Too many requests: Oort Pro allows ${RATE_LIMIT.requests} requests every ${RATE_LIMIT.seconds} seconds per key. Wait a few seconds and try again.`,
      { 'retry-after': String(RATE_LIMIT.seconds) },
    );
  }

  let row: KeyRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT k.id AS key_id, k.account_id, k.revoked_at, a.plan, a.status
         FROM api_keys k JOIN accounts a ON a.id = k.account_id
        WHERE k.hash = ?`,
    )
      .bind(hash)
      .first<KeyRow>();
  } catch {
    return fail(503, 'Oort Pro is briefly unavailable. Try again in a moment.');
  }
  if (!row) return fail(401, `This Oort key is not valid. Create a new one at ${ACCOUNT_URL}.`);
  if (row.revoked_at !== null) {
    return fail(401, `This Oort key was revoked. Create a new one at ${ACCOUNT_URL}.`);
  }
  const limits = limitsFor(row.plan);
  if (!ENTITLED.has(row.status) || !limits) {
    return fail(
      402,
      `Oort Pro is not active on this account. Subscribe or update billing at ${ACCOUNT_URL}.`,
    );
  }

  const body = await readCapped(request, MAX_BODY_BYTES);
  if (body === null) return fail(413, 'The request body is larger than 256 KB.');

  const encoding = request.headers.get('content-encoding');
  let pool: Pool = 'saves';
  let meter: Pool | null = null;
  if (route.check) {
    if (encoding !== null && encoding !== 'identity') {
      return fail(415, 'Send this request uncompressed.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return fail(400, 'The request body must be JSON.');
    }
    if (!isObj(parsed)) return fail(400, 'The request body must be a JSON object.');
    const c = route.check(parsed);
    if ('error' in c) return fail(400, c.error);
    pool = c.pool;
    meter = c.meter;
  } else {
    if (encoding !== null && encoding !== 'identity' && encoding !== 'zstd') {
      return fail(415, 'Only zstd or uncompressed bodies are accepted.');
    }
    const type = request.headers.get('content-type') ?? '';
    if (!/^(application\/json|multipart\/form-data)\b/i.test(type)) {
      return fail(415, 'Send application/json or multipart/form-data.');
    }
  }

  const month = now.toISOString().slice(0, 7);
  let used: { saves: number; recalls: number } | null;
  try {
    used = await env.DB.prepare(
      'SELECT saves, recalls FROM usage WHERE account_id = ? AND month = ?',
    )
      .bind(row.account_id, month)
      .first<{ saves: number; recalls: number }>();
  } catch {
    return fail(503, 'Oort Pro is briefly unavailable. Try again in a moment.');
  }
  if ((used?.[pool] ?? 0) >= limits[pool]) {
    const word = pool === 'saves' ? 'saves' : 'recalls';
    return fail(
      429,
      `You have used the ${limits[pool].toLocaleString('en-US')} ${word} included in Oort Pro this month. ${word[0]!.toUpperCase()}${word.slice(1)} start again on 1 ${nextMonthName(now)} (UTC). Usage is at ${ACCOUNT_URL}.`,
    );
  }

  let upstream: Response;
  try {
    upstream = await doFetch(route.upstream, {
      method: 'POST',
      headers: upstreamHeaders(route, env, request.headers),
      body,
    });
  } catch {
    return fail(502, 'The provider could not be reached. Try again in a moment.');
  }

  const account = row.account_id;
  const keyId = row.key_id;
  const stamp = now.toISOString();
  ctx.waitUntil(
    (async () => {
      const writes = [
        env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(stamp, keyId),
      ];
      if (upstream.ok && meter !== null) {
        writes.push(
          env.DB.prepare(
            `INSERT INTO usage (account_id, month, saves, recalls) VALUES (?, ?, ?, ?)
             ON CONFLICT (account_id, month) DO UPDATE SET
               saves = saves + excluded.saves, recalls = recalls + excluded.recalls`,
          ).bind(account, month, meter === 'saves' ? 1 : 0, meter === 'recalls' ? 1 : 0),
        );
      }
      await env.DB.batch(writes);
    })().catch(() => undefined),
  );

  if (upstream.status === 401 || upstream.status === 403) {
    void upstream.body?.cancel().catch(() => undefined);
    return fail(
      502,
      'The relay could not sign in to the provider. This is on our side; try again later.',
    );
  }
  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    return new Response(cleanErrorBody(raw, env), {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  });
}
