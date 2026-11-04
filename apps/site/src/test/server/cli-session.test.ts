// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_KEYS,
  approveCli,
  codeAttemptGuard,
  createKey,
  getOverview,
  lookupCli,
} from '@/server/account';
import { handleCliCreate, handleCliPoll } from '@/server/cli-session';
import { challengeOf, hashKey, normalizeUserCode } from '@/server/keys';
import { deps, T0 } from './fakes';

const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);
const b64 = (b: Buffer) => b.toString('base64url');

function secretPair() {
  const raw = randomBytes(32);
  return { secret: b64(raw), challenge: b64(createHash('sha256').update(raw).digest()) };
}

function setup(over: { allow?: () => Promise<boolean> } = {}) {
  const s = deps();
  const now = () => s.d.now!();
  const create = async (body: unknown, country: string | null = 'SE') => {
    const res = await handleCliCreate(
      new Request('https://oortcloud.dev/api/cli/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      {
        db: s.db,
        now,
        allow: over.allow ?? (async () => true),
        origin: 'https://oortcloud.dev',
        country,
      },
    );
    return { res, body: (await res.json()) as Record<string, unknown> };
  };
  const poll = (secret: unknown) =>
    handleCliPoll(
      new Request('https://oortcloud.dev/api/cli/session/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      }),
      { db: s.db, now },
    );
  /** A started session: its secret and the code the terminal shows. */
  const start = async (extra: Record<string, unknown> = { os: 'macOS', host: 'marcus-mbp' }) => {
    const p = secretPair();
    const { body } = await create({ challenge: p.challenge, ...extra });
    return { ...p, code: String(body['user_code']) };
  };
  return { ...s, create, poll, start };
}

describe('oort login: starting a session', () => {
  it('answers a user code and an approve URL with nothing secret in it', async () => {
    const s = setup();
    const p = secretPair();
    const { res, body } = await s.create({ challenge: p.challenge, os: 'macOS', host: 'mbp' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      status: 'pending',
      user_code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
      verification_uri: 'https://oortcloud.dev/account/cli',
      expires_in: 600,
      interval: 2,
    });
    const dump = JSON.stringify(body);
    expect(dump).not.toContain(p.challenge);
    expect(dump).not.toContain(p.secret);
  });

  it('stores the challenge, the code, the country and what the CLI reported, never the secret', async () => {
    const s = setup();
    const p = await s.start({ os: 'Linux', host: 'build-box\u0007<script>' });
    const rows = (await s.db.prepare('SELECT * FROM cli_sessions').all()).results;
    expect(rows).toEqual([
      {
        id: p.challenge,
        user_code: normalizeUserCode(p.code),
        created_at: T0.toISOString(),
        country: 'SE',
        client_os: 'Linux',
        client_host: 'build-boxscript',
        account_id: null,
        approved_at: null,
        consumed_at: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(p.secret);
  });

  it('rejects a bad challenge, a reused challenge and a non-JSON body', async () => {
    const s = setup();
    expect((await s.create({ challenge: 'short' })).res.status).toBe(400);
    expect((await s.create('{nope')).res.status).toBe(400);
    expect((await s.create({ challenge: 'x'.repeat(5000) })).res.status).toBe(400);
    const p = secretPair();
    expect((await s.create({ challenge: p.challenge })).res.status).toBe(201);
    expect((await s.create({ challenge: p.challenge })).res.status).toBe(409);
  });

  it('is rate-limited per IP with 429', async () => {
    const s = setup({ allow: async () => false });
    const { res } = await s.create({ challenge: secretPair().challenge });
    expect(res.status).toBe(429);
    expect((await s.db.prepare('SELECT COUNT(*) AS n FROM cli_sessions').first())?.['n']).toBe(0);
  });

  it('keeps only a two-letter country', async () => {
    const s = setup();
    await s.create({ challenge: secretPair().challenge }, 'Sweden');
    expect((await s.db.prepare('SELECT country FROM cli_sessions').first())?.['country']).toBe(
      null,
    );
  });
});

describe('oort login: approving and collecting', () => {
  it('is pending until approved, then hands over a "CLI on <date>" key once', async () => {
    const s = setup();
    const p = await s.start();
    const pending = await s.poll(p.secret);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: 'pending' });
    s.at(minutes(1));
    await approveCli(s.d, p.code);
    const res = await s.poll(p.secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; key: string; prefix: string };
    expect(body.status).toBe('approved');
    expect(body.key).toMatch(/^oort_sk_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.key.slice(0, 12));
    const keys = (await getOverview(s.d)).keys;
    expect(keys.map((k) => k.name)).toEqual(['CLI on 2026-11-04']);
    const row = await s.db.prepare('SELECT hash FROM api_keys').first<{ hash: string }>();
    expect(row?.hash).toBe(await hashKey(body.key));
    const again = await s.poll(p.secret);
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ status: 'used' });
  });

  it('the poll never writes before approval, and is 404 for a secret that started nothing', async () => {
    const s = setup();
    const p = await s.start();
    for (let i = 0; i < 3; i++) await s.poll(p.secret);
    const row = await s.db.prepare('SELECT * FROM cli_sessions').first();
    expect(row).toMatchObject({ approved_at: null, consumed_at: null, account_id: null });
    expect((await s.poll(secretPair().secret)).status).toBe(404);
    expect((await s.poll('not base64url!')).status).toBe(400);
    expect((await s.poll(p.challenge.slice(0, 10))).status).toBe(400);
  });

  it('only the secret collects the key, not the challenge or the code', async () => {
    const s = setup();
    const p = await s.start();
    await approveCli(s.d, p.code);
    expect((await s.poll(p.challenge)).status).toBe(404);
    expect((await s.poll(p.code)).status).toBe(400);
    expect((await s.poll(p.secret)).status).toBe(200);
  });

  it('two polls at once mint one key', async () => {
    const s = setup();
    const p = await s.start();
    await approveCli(s.d, p.code);
    const rs = await Promise.all([s.poll(p.secret), s.poll(p.secret), s.poll(p.secret)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 410, 410]);
    expect((await getOverview(s.d)).keys).toHaveLength(1);
  });

  it('expires 10 minutes after the session started, for lookup, approve and poll', async () => {
    const s = setup();
    const p = await s.start();
    s.at(minutes(10.5));
    await expect(lookupCli(s.d, p.code)).rejects.toThrow(/expired/i);
    await expect(approveCli(s.d, p.code)).rejects.toThrow(/expired/i);
    const res = await s.poll(p.secret);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ status: 'expired' });
  });

  it('expires an approved session that the CLI did not collect in time', async () => {
    const s = setup();
    const p = await s.start();
    await approveCli(s.d, p.code);
    s.at(minutes(11));
    expect((await s.poll(p.secret)).status).toBe(410);
    expect((await getOverview(s.d)).keys).toHaveLength(0);
  });

  it('is approved once: a second account (or a second click) is refused', async () => {
    const s = setup();
    const p = await s.start();
    await approveCli(s.d, p.code);
    await expect(approveCli(s.d, p.code)).rejects.toThrow(/already approved/i);
    s.signInAs('user_2');
    await expect(approveCli(s.d, p.code)).rejects.toThrow(/no pending/i);
    const row = await s.db
      .prepare('SELECT COUNT(DISTINCT account_id) AS n FROM cli_sessions')
      .first();
    expect(row?.['n']).toBe(1);
  });

  it('accepts the code typed in lower case, with spaces or without the dash', async () => {
    const s = setup();
    const p = await s.start();
    const typed = ` ${p.code.replace('-', ' ').toLowerCase()} `;
    expect((await lookupCli(s.d, typed)).code).toBe(p.code);
    await approveCli(s.d, p.code.replace('-', ''));
    expect((await s.poll(p.secret)).status).toBe(200);
  });

  it('rejects a malformed or unknown code', async () => {
    const s = setup();
    await expect(lookupCli(s.d, 'short')).rejects.toThrow(/8-letter code/);
    await expect(lookupCli(s.d, 'AAAA-AAAA')).rejects.toThrow(/8-letter code/); // A is not in the alphabet
    await expect(approveCli(s.d, 'BCDF-GHJK')).rejects.toThrow(/no pending/i);
  });

  it('lookup shows when, where from, and the reported computer, for the page', async () => {
    const s = setup();
    const p = await s.start();
    expect(await lookupCli(s.d, p.code)).toEqual({
      code: p.code,
      createdAt: T0.toISOString(),
      country: 'SE',
      os: 'macOS',
      host: 'marcus-mbp',
      keyLimitReached: false,
    });
  });

  it('limits how many codes one account may try', async () => {
    const s = setup();
    let left = 2;
    s.d.allowCodeAttempt = () => left-- > 0;
    await expect(lookupCli(s.d, 'BCDF-GHJK')).rejects.toThrow(/no pending/i);
    await expect(lookupCli(s.d, 'BCDF-GHJK')).rejects.toThrow(/no pending/i);
    await expect(lookupCli(s.d, 'BCDF-GHJK')).rejects.toThrow(/too many/i);
  });

  it('counts typed codes in the limiter binding, per account and per IP', async () => {
    const keys: string[] = [];
    const refuse = new Set<string>();
    const limiter = {
      limit: async ({ key }: { key: string }) => (keys.push(key), { success: !refuse.has(key) }),
    };
    const local = () => {
      throw new Error('the in-memory fallback must not be used with a binding');
    };
    const guard = codeAttemptGuard(limiter, '203.0.113.9', local);
    expect(await guard('acc_1')).toBe(true);
    expect(keys.sort()).toEqual(['code-account:acc_1', 'code-ip:203.0.113.9']);
    refuse.add('code-ip:203.0.113.9');
    expect(await guard('acc_2')).toBe(false); // another account, same IP
    refuse.clear();
    refuse.add('code-account:acc_1');
    expect(await guard('acc_1')).toBe(false); // same account, another IP is still refused
    expect(await guard('acc_3')).toBe(true);
  });

  it('falls back to memory only when there is no binding', async () => {
    let n = 0;
    const guard = codeAttemptGuard(undefined, 'ip', () => n++ < 2);
    expect(await guard('a')).toBe(true);
    expect(await guard('a')).toBe(false);
  });

  it('holds MAX_LIVE_KEYS: the page refuses, and so does the poll', async () => {
    const s = setup();
    for (let i = 0; i < MAX_LIVE_KEYS; i++) await createKey(s.d, `k${i}`);
    const p = await s.start();
    expect((await lookupCli(s.d, p.code)).keyLimitReached).toBe(true);
    await expect(approveCli(s.d, p.code)).rejects.toThrow(/revoke one/i);
    // Approved before the limit was reached (another tab made keys since): the poll holds the line.
    await s.db
      .prepare("UPDATE cli_sessions SET account_id = (SELECT id FROM accounts), approved_at = 'x'")
      .run();
    const res = await s.poll(p.secret);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      status: 'key_limit',
      error: expect.stringContaining('Revoke a key at https://oortcloud.dev/account'),
    });
  });

  it('challengeOf is base64url(SHA-256(S)) over the raw bytes, as the CLI computes it', async () => {
    const p = secretPair();
    expect(await challengeOf(p.secret)).toBe(p.challenge);
    expect(await challengeOf(`${p.secret}A`)).toBeNull();
  });
});
