import { describe, expect, it } from 'vitest';
import { createRateLimiter, handleWaitlist, type D1Like } from '@/server/waitlist';

function fakeD1() {
  const rows = new Map<string, { created_at: string; source: string }>();
  const statements: string[] = [];
  let fail = false;
  const db: D1Like = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind(...v) {
          return {
            async run() {
              if (fail) throw new Error('boom');
              const [email, created_at, source] = v as [string, string, string];
              if (!rows.has(email)) rows.set(email, { created_at, source });
            },
          };
        },
      };
    },
  };
  return { db, rows, statements, failNext: () => (fail = true) };
}

const T = new Date('2026-11-05T10:00:00Z');
const req = (body: unknown, ip = '1.2.3.4') =>
  new Request('http://x/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const setup = () => {
  const d = fakeD1();
  const allow = createRateLimiter(3, 60_000);
  const run = (b: unknown, ip?: string) =>
    handleWaitlist(req(b, ip), { db: d.db, allow, now: () => T });
  return { ...d, run };
};
const good = { email: 'Ada@Example.com ', consent: true, source: 'home' };

describe('POST /api/waitlist', () => {
  it('stores a lowercase email, the time and the source, nothing else', async () => {
    const s = setup();
    const res = await s.run(good);
    expect(res.status).toBe(200);
    expect([...s.rows]).toEqual([
      ['ada@example.com', { created_at: T.toISOString(), source: 'home' }],
    ]);
  });
  it('returns the same 200 for a new and a known address', async () => {
    const s = setup();
    const a = await s.run(good);
    const b = await s.run(good);
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
    expect(s.rows.size).toBe(1);
  });
  it('rejects an invalid email', async () => {
    const s = setup();
    expect((await s.run({ ...good, email: 'nope' })).status).toBe(400);
    expect(s.rows.size).toBe(0);
  });
  it('requires consent', async () => {
    const s = setup();
    expect((await s.run({ ...good, consent: false })).status).toBe(400);
    expect(s.rows.size).toBe(0);
  });
  it('rejects bad JSON', async () => {
    const s = setup();
    expect((await s.run('{oops')).status).toBe(400);
  });
  it('silently drops honeypot hits with the same 200', async () => {
    const s = setup();
    const res = await s.run({ ...good, website: 'http://spam' });
    expect(res.status).toBe(200);
    expect(s.rows.size).toBe(0);
    expect(s.statements).toHaveLength(0);
  });
  it('rate limits per IP and lets other IPs through', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect((await s.run(good, '9.9.9.9')).status).toBe(200);
    expect((await s.run(good, '9.9.9.9')).status).toBe(429);
    expect((await s.run(good, '8.8.8.8')).status).toBe(200);
  });
  it('maps an unknown source to other', async () => {
    const s = setup();
    await s.run({ ...good, source: 'evil' });
    expect(s.rows.get('ada@example.com')?.source).toBe('other');
  });
  it('never puts the IP into the insert', async () => {
    const s = setup();
    await s.run(good, '5.5.5.5');
    expect(JSON.stringify([...s.rows])).not.toContain('5.5.5.5');
    expect(s.statements[0]).not.toMatch(/ip|agent/i);
  });
  it('returns 500 when the database fails', async () => {
    const s = setup();
    s.failNext();
    expect((await s.run(good)).status).toBe(500);
  });
});
