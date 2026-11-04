import { CLI_SESSION_TTL_MS, MAX_LIVE_KEYS, mintKey } from './account';
import type { D1DatabaseLike } from './d1';
import { CHALLENGE, challengeOf, formatUserCode, generateUserCode } from './keys';

/**
 * `oort login`, RFC 8628 style (review findings I3, I4, I5):
 *
 * 1. `POST /api/cli/session` `{challenge, os, host}`: the CLI keeps a secret S (32 random bytes)
 *    and sends only challenge = base64url(SHA-256(S)), with its OS and host name. The answer is a
 *    short user code and the approve page, `https://oortcloud.dev/account/cli`, which carries no
 *    secret. Rate-limited per IP; the IP is never stored.
 * 2. The user opens the page and types the code from their terminal. The page shows when the
 *    request started, the approximate country it came from, and the OS and host the CLI reported.
 * 3. `POST /api/cli/session/poll` `{secret: S}`: read-only until approved (202), then one atomic
 *    claim that mints the key (200, once), 410 `used` or `expired` after that, 404 for a secret
 *    that started no session, 409 `key_limit` at MAX_LIVE_KEYS.
 */

export const POLL_INTERVAL_S = 2;
const MAX_BODY_BYTES = 2048;
export const KEY_LIMIT_CLI_MESSAGE = `This account already has ${MAX_LIVE_KEYS} live keys, so no new key was made. Revoke a key at https://oortcloud.dev/account, then run oort login again.`;

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** A small JSON object body, or null. */
async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return null;
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A short, printable label the CLI reported (OS or host name), or null. */
function label(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .trim()
    .slice(0, max);
  return s === '' ? null : s;
}

export interface CliCreateDeps {
  db: D1DatabaseLike;
  now?: () => Date;
  /** Per-IP budget for starting sessions; false refuses with 429. */
  allow: () => Promise<boolean>;
  /** Site origin, for the approve URL. */
  origin: string;
  /** Two-letter country from Cloudflare's `request.cf.country`, if any. */
  country?: string | null;
}

/** POST /api/cli/session */
export async function handleCliCreate(request: Request, deps: CliCreateDeps): Promise<Response> {
  if (!(await deps.allow())) {
    return reply(429, { status: 'slow_down', error: 'Too many sign-in requests. Wait a minute.' });
  }
  const body = await jsonBody(request);
  const challenge = body?.['challenge'];
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) {
    return reply(400, { status: 'invalid' });
  }
  const now = (deps.now ?? (() => new Date()))();
  const country =
    typeof deps.country === 'string' && /^[A-Z0-9]{2}$/.test(deps.country) ? deps.country : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateUserCode();
    // A clash on user_code (vanishingly rare) tries a new code; a clash on the challenge is refused.
    const r = await deps.db
      .prepare(
        `INSERT INTO cli_sessions (id, user_code, created_at, country, client_os, client_host)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(
        challenge,
        code,
        now.toISOString(),
        country,
        label(body?.['os'], 32),
        label(body?.['host'], 64),
      )
      .run();
    if (r.meta.changes === 1) {
      return reply(201, {
        status: 'pending',
        user_code: formatUserCode(code),
        verification_uri: `${deps.origin}/account/cli`,
        expires_in: CLI_SESSION_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      });
    }
    const taken = await deps.db
      .prepare('SELECT 1 AS x FROM cli_sessions WHERE id = ?')
      .bind(challenge)
      .first();
    if (taken) return reply(409, { status: 'invalid' });
  }
  return reply(503, { status: 'busy' });
}

/** POST /api/cli/session/poll */
export async function handleCliPoll(
  request: Request,
  deps: { db: D1DatabaseLike; now?: () => Date },
): Promise<Response> {
  const body = await jsonBody(request);
  const id = await challengeOf(body?.['secret']);
  if (id === null) return reply(400, { status: 'invalid' });

  const now = (deps.now ?? (() => new Date()))();
  const { db } = deps;
  // Read-only until approved: a poll never writes for a secret that started no session.
  const row = await db
    .prepare('SELECT created_at, approved_at, consumed_at FROM cli_sessions WHERE id = ?')
    .bind(id)
    .first<{ created_at: string; approved_at: string | null; consumed_at: string | null }>();
  if (!row) return reply(404, { status: 'unknown' });
  if (row.consumed_at !== null) return reply(410, { status: 'used' });
  const cutoff = new Date(now.getTime() - CLI_SESSION_TTL_MS).toISOString();
  if (row.created_at <= cutoff) return reply(410, { status: 'expired' });
  if (row.approved_at === null) return reply(202, { status: 'pending' });

  // One claim: whoever runs this first (and only with S) gets the account id back.
  const claim = await db
    .prepare(
      `UPDATE cli_sessions SET consumed_at = ?
        WHERE id = ? AND approved_at IS NOT NULL AND account_id IS NOT NULL
          AND consumed_at IS NULL AND created_at > ?
        RETURNING account_id`,
    )
    .bind(now.toISOString(), id, cutoff)
    .first<{ account_id: string }>();
  if (!claim) return reply(410, { status: 'used' });

  const k = await mintKey(db, claim.account_id, `CLI on ${now.toISOString().slice(0, 10)}`, now);
  if (!k) return reply(409, { status: 'key_limit', error: KEY_LIMIT_CLI_MESSAGE });
  return reply(200, { status: 'approved', key: k.key, prefix: k.prefix });
}
