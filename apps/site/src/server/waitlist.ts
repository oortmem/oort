/** Minimal slice of the D1 API this handler uses, so tests can fake it. */
export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
};

export const SOURCES = ['home', 'pricing'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Per-IP fixed window counter. Lives in memory only and is never persisted. */
export function createRateLimiter(max = 5, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now: number) => {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const cur = hits.get(key);
    if (!cur) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= max;
  };
}

export type WaitlistDeps = {
  db: D1Like;
  allow: (key: string, now: number) => boolean;
  now?: () => Date;
};

const ok = () => Response.json({ ok: true });
const bad = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/**
 * Handles POST /api/waitlist. Same 200 for a new address, a known address and a
 * honeypot hit, so the response never reveals who is on the list. The IP is only
 * used as an in-memory rate limit key.
 */
export async function handleWaitlist(request: Request, deps: WaitlistDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!deps.allow(ip, now.getTime())) return bad('Too many requests. Try again in a minute.', 429);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) return bad('Invalid request.');
    body = parsed as Record<string, unknown>;
  } catch {
    return bad('Invalid request.');
  }

  // Honeypot: real people never see or fill this field.
  if (typeof body['website'] === 'string' && body['website'] !== '') return ok();

  const email = normalizeEmail(body['email']);
  if (!email) return bad('Enter a valid email address.');
  if (body['consent'] !== true) return bad('Please agree to be emailed when Oort Cloud opens.');

  const source = (SOURCES as readonly unknown[]).includes(body['source'])
    ? (body['source'] as string)
    : 'other';

  try {
    await deps.db
      .prepare(
        'INSERT INTO waitlist (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING',
      )
      .bind(email, now.toISOString(), source)
      .run();
  } catch {
    return bad('Something went wrong. Please try again.', 500);
  }
  return ok();
}
