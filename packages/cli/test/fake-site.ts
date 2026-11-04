import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for oortcloud.dev's CLI sign-in, on 127.0.0.1 with a random
 * port. It follows apps/site/src/server/cli-session.ts: `GET
 * /api/cli/session/<id>` is 400 for a bad id, 202 until approved, 200
 * `{ status: "approved", key, prefix }` once, then 410 `used`, and 410
 * `expired` once the session is older than its lifetime. The session starts
 * at the first poll or page view, as there. Nothing here reaches the network.
 */
export interface FakeSite {
  url: string;
  /** Every session id polled, in order (one entry per poll). */
  polls: string[];
  /** Pages viewed (`/account/cli?session=…`), as the browser would. */
  views: string[];
  /** The key minted at the approving poll, once there has been one. */
  minted: string | undefined;
  /** Approves `id` as a signed-in user would on the page. */
  approve(id: string): void;
  close(): Promise<void>;
}

export interface FakeSiteOptions {
  /** Approve each session automatically at its nth poll (1-based). */
  approveAtPoll?: number;
  /** Answer every poll with this status instead (e.g. 503), for the first `failFirst` polls. */
  failFirst?: { polls: number; status: number };
  /** The session lifetime; the site's is 10 minutes. */
  ttlMs?: number;
  now?: () => number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;

export async function fakeSite(opts: FakeSiteOptions = {}): Promise<FakeSite> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const sessions = new Map<string, { created: number; approved: boolean; consumed: boolean }>();
  const counts = new Map<string, number>();
  const start = (id: string) => {
    let s = sessions.get(id);
    if (s === undefined) {
      s = { created: now(), approved: false, consumed: false };
      sessions.set(id, s);
    }
    return s;
  };
  const site: FakeSite = {
    url: '',
    polls: [],
    views: [],
    minted: undefined,
    approve: (id) => void (start(id).approved = true),
    close: () => new Promise((r) => server.close(() => r())),
  };
  let failed = 0;
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const u = new URL(req.url ?? '/', 'http://fake.invalid');
    if (req.method === 'GET' && u.pathname === '/account/cli') {
      const id = u.searchParams.get('session') ?? '';
      site.views.push(id);
      if (SESSION_ID.test(id)) start(id);
      const code = createHash('sha256').update(`oort-cli-code:${id}`).digest('hex').toUpperCase();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`Approve oort login? Code ${code.slice(0, 4)}-${code.slice(4, 8)}\n`);
      return;
    }
    const m = /^\/api\/cli\/session\/([^/]*)$/.exec(u.pathname);
    if (req.method !== 'GET' || m === null) return reply(404, { error: 'not found' });
    const id = decodeURIComponent(m[1] ?? '');
    site.polls.push(id);
    if (opts.failFirst !== undefined && failed < opts.failFirst.polls) {
      failed++;
      return reply(opts.failFirst.status, { error: 'busy' });
    }
    if (!SESSION_ID.test(id)) return reply(400, { status: 'invalid' });
    const s = start(id);
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    if (opts.approveAtPoll !== undefined && n >= opts.approveAtPoll) s.approved = true;
    if (s.consumed) return reply(410, { status: 'used' });
    if (now() - s.created > ttl) return reply(410, { status: 'expired' });
    if (!s.approved) return reply(202, { status: 'pending' });
    s.consumed = true;
    const key = `oort_sk_${randomBytes(32).toString('base64url')}`;
    site.minted = key;
    return reply(200, { status: 'approved', key, prefix: key.slice(0, 12) });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return site;
}
