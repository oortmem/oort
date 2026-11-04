import { CLI_SESSION_TTL_MS, SESSION_ID, mintKey } from './account';
import type { D1DatabaseLike } from './d1';
import { hashKey } from './keys';

/**
 * GET /api/cli/session/:id, polled by `oort login`. The session id is a random secret the CLI
 * generated and opened in the browser as /account/cli?session=<id>. D1 keeps only its hash.
 *
 * - 202 pending until a signed-in user approves.
 * - 200 once with a new key named "CLI on <date>", minted at this moment.
 * - 410 after that (single use) or 10 minutes after the session started.
 */
export async function handleCliPoll(
  sessionId: string,
  deps: { db: D1DatabaseLike; now?: () => Date },
): Promise<Response> {
  const reply = (status: number, body: Record<string, unknown>) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (!SESSION_ID.test(sessionId)) return reply(400, { status: 'invalid' });

  const now = (deps.now ?? (() => new Date()))();
  const id = await hashKey(sessionId);
  const { db } = deps;

  // Old rows are only kept long enough to answer "used" or "expired".
  await db
    .prepare('DELETE FROM cli_sessions WHERE created_at < ?')
    .bind(new Date(now.getTime() - 24 * 3600_000).toISOString())
    .run();
  await db
    .prepare('INSERT INTO cli_sessions (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
    .bind(id, now.toISOString())
    .run();
  const row = await db
    .prepare(
      'SELECT created_at, account_id, approved_at, consumed_at FROM cli_sessions WHERE id = ?',
    )
    .bind(id)
    .first<{
      created_at: string;
      account_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    }>();
  if (!row) return reply(410, { status: 'expired' });
  if (row.consumed_at !== null) return reply(410, { status: 'used' });
  if (now.getTime() - Date.parse(row.created_at) > CLI_SESSION_TTL_MS) {
    return reply(410, { status: 'expired' });
  }
  if (row.approved_at === null || row.account_id === null) return reply(202, { status: 'pending' });

  const claim = await db
    .prepare(
      'UPDATE cli_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND approved_at IS NOT NULL',
    )
    .bind(now.toISOString(), id)
    .run();
  if (claim.meta.changes !== 1) return reply(410, { status: 'used' });

  const k = await mintKey(db, row.account_id, `CLI on ${now.toISOString().slice(0, 10)}`, now);
  return reply(200, { status: 'approved', key: k.key, prefix: k.prefix });
}

/**
 * A short code shown on the approve page so the user can check it matches the terminal.
 * The CLI computes the same: SHA-256 of "oort-cli-code:" + session id, first 8 hex, as XXXX-XXXX.
 */
export async function cliCode(sessionId: string): Promise<string> {
  const h = (await hashKey(`oort-cli-code:${sessionId}`)).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}
