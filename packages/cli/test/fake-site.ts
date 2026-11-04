import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for oortcloud.dev's CLI sign-in, on 127.0.0.1 with a random port. It follows
 * apps/site/src/server/cli-session.ts:
 *
 * - `POST /api/cli/session` `{challenge, os, host}`: 400 for a bad challenge, else 201
 *   `{status, user_code, verification_uri, expires_in, interval}`.
 * - `POST /api/cli/session/poll` `{secret}`: 400 for a bad secret, 404 when no session has
 *   challenge base64url(SHA-256(secret)), 202 until approved, 200 `{status: "approved", key,
 *   prefix}` once, then 410 `used`, 410 `expired` once older than its lifetime, 409 `key_limit`.
 *
 * Nothing here reaches the network.
 */
export interface FakeSession {
  challenge: string;
  os: unknown;
  host: unknown;
  /** As the terminal shows it, XXXX-XXXX. */
  code: string;
}

export interface FakeSite {
  url: string;
  /** Every session started, in order. */
  sessions: FakeSession[];
  /** Every secret polled, in order (one entry per poll). */
  polls: string[];
  /** Every request's path and body, in order, to check nothing secret is in a URL. */
  requests: { method: string; path: string; body: string }[];
  /** The key minted at the approving poll, once there has been one. */
  minted: string | undefined;
  /** Approves the session with this user code, as a signed-in user would on the page. */
  approve(code: string): void;
  close(): Promise<void>;
}

export interface FakeSiteOptions {
  /** Approve each session automatically at its nth poll (1-based). */
  approveAtPoll?: number;
  /** Answer every poll with this status instead (e.g. 503), for the first `failFirst` polls. */
  failFirst?: { polls: number; status: number };
  /** Answer session creation with this status and no session. */
  createStatus?: number;
  /** The account is at its live-key limit: the approving poll answers 409. */
  keyLimit?: boolean;
  /** The session lifetime; the site's is 10 minutes. */
  ttlMs?: number;
  now?: () => number;
}

const B64 = /^[A-Za-z0-9_-]{43}$/;
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export async function fakeSite(opts: FakeSiteOptions = {}): Promise<FakeSite> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const state = new Map<
    string,
    { created: number; approved: boolean; consumed: boolean; polls: number; code: string }
  >();
  const site: FakeSite = {
    url: '',
    sessions: [],
    polls: [],
    requests: [],
    minted: undefined,
    approve: (code) => {
      for (const s of state.values()) if (s.code === code) s.approved = true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  let failed = 0;
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fake.invalid').pathname;
      site.requests.push({ method: req.method ?? '', path: req.url ?? '', body: raw });
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // stays empty
      }
      if (req.method === 'POST' && path === '/api/cli/session') {
        if (opts.createStatus !== undefined) return reply(opts.createStatus, { error: 'no' });
        const challenge = body['challenge'];
        if (typeof challenge !== 'string' || !B64.test(challenge)) {
          return reply(400, { status: 'invalid' });
        }
        const code = [...randomBytes(8)].map((b) => ALPHABET[b % 20]).join('');
        const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
        state.set(challenge, {
          created: now(),
          approved: false,
          consumed: false,
          polls: 0,
          code: shown,
        });
        site.sessions.push({ challenge, os: body['os'], host: body['host'], code: shown });
        return reply(201, {
          status: 'pending',
          user_code: shown,
          verification_uri: `${site.url}/account/cli`,
          expires_in: ttl / 1000,
          interval: 2,
        });
      }
      if (req.method === 'POST' && path === '/api/cli/session/poll') {
        const secret = body['secret'];
        site.polls.push(typeof secret === 'string' ? secret : '');
        if (opts.failFirst !== undefined && failed < opts.failFirst.polls) {
          failed++;
          return reply(opts.failFirst.status, { error: 'busy' });
        }
        if (typeof secret !== 'string' || !B64.test(secret))
          return reply(400, { status: 'invalid' });
        const challenge = createHash('sha256')
          .update(Buffer.from(secret, 'base64url'))
          .digest('base64url');
        const s = state.get(challenge);
        if (s === undefined) return reply(404, { status: 'unknown' });
        s.polls++;
        if (opts.approveAtPoll !== undefined && s.polls >= opts.approveAtPoll) s.approved = true;
        if (s.consumed) return reply(410, { status: 'used' });
        if (now() - s.created > ttl) return reply(410, { status: 'expired' });
        if (!s.approved) return reply(202, { status: 'pending' });
        s.consumed = true;
        if (opts.keyLimit) {
          return reply(409, {
            status: 'key_limit',
            error:
              'This account already has 20 live keys, so no new key was made. Revoke a key at https://oortcloud.dev/account, then run oort login again.',
          });
        }
        const key = `oort_sk_${randomBytes(32).toString('base64url')}`;
        site.minted = key;
        return reply(200, { status: 'approved', key, prefix: key.slice(0, 12) });
      }
      return reply(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return site;
}
