import type { D1DatabaseLike } from './d1.js';

/**
 * `oort login` requests (cli_sessions, written by apps/site) only need to live for their
 * 10 minutes plus long enough to answer "used" or "expired". The relay's hourly cron deletes them
 * once they are an hour old, so none is kept for more than about two hours. No request handler
 * prunes, so polling never writes.
 */
export const CLI_SESSION_KEEP_MS = 3600_000;

export async function pruneCliSessions(db: D1DatabaseLike, now: Date): Promise<number> {
  const r = await db
    .prepare('DELETE FROM cli_sessions WHERE created_at < ?')
    .bind(new Date(now.getTime() - CLI_SESSION_KEEP_MS).toISOString())
    .run();
  return r.meta.changes;
}
