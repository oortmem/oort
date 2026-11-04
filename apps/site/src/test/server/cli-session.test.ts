// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { approveCli, getOverview } from '@/server/account';
import { cliCode, handleCliPoll } from '@/server/cli-session';
import { hashKey } from '@/server/keys';
import { deps, T0 } from './fakes';

const SESSION = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';

function setup() {
  const s = deps();
  const poll = (id = SESSION) =>
    handleCliPoll(id, { db: s.db, now: s.d.now ?? (() => new Date()) });
  return { ...s, poll };
}

const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);

describe('oort login (CLI sign-in)', () => {
  it('is pending until a signed-in user approves', async () => {
    const s = setup();
    const res = await s.poll();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('hands over a new key named "CLI on <date>" once, then never again', async () => {
    const s = setup();
    await s.poll();
    s.at(minutes(1));
    await approveCli(s.d, SESSION);
    const res = await s.poll();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; key: string; prefix: string };
    expect(body.status).toBe('approved');
    expect(body.key).toMatch(/^oort_sk_/);
    expect(body.prefix).toBe(body.key.slice(0, 12));

    const keys = (await getOverview(s.d)).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]?.name).toBe('CLI on 2026-11-04');
    const row = await s.db.prepare('SELECT hash FROM api_keys').first<{ hash: string }>();
    expect(row?.hash).toBe(await hashKey(body.key));

    const again = await s.poll();
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ status: 'used' });
    expect((await getOverview(s.d)).keys).toHaveLength(1);
  });

  it('stores only a hash of the session id and never the key', async () => {
    const s = setup();
    await s.poll();
    await approveCli(s.d, SESSION);
    const res = await s.poll();
    const { key } = (await res.json()) as { key: string };
    const rows = await s.db.prepare('SELECT * FROM cli_sessions').all();
    const dump = JSON.stringify(rows.results);
    expect(dump).not.toContain(SESSION);
    expect(dump).not.toContain(key);
  });

  it('expires 10 minutes after the session started, for approve and for poll', async () => {
    const s = setup();
    await s.poll();
    s.at(minutes(10.5));
    await expect(approveCli(s.d, SESSION)).rejects.toThrow(/expired/i);
    const res = await s.poll();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ status: 'expired' });
  });

  it('expires an approved session that the CLI did not collect in time', async () => {
    const s = setup();
    await s.poll();
    await approveCli(s.d, SESSION);
    s.at(minutes(11));
    expect((await s.poll()).status).toBe(410);
    expect((await getOverview(s.d)).keys).toHaveLength(0);
  });

  it('works when the browser approves before the first poll', async () => {
    const s = setup();
    await approveCli(s.d, SESSION);
    expect((await s.poll()).status).toBe(200);
  });

  it('cannot be approved by a second account', async () => {
    const s = setup();
    await approveCli(s.d, SESSION);
    s.signInAs('user_2');
    await expect(approveCli(s.d, SESSION)).rejects.toThrow(/already/i);
  });

  it('rejects a malformed session id', async () => {
    const s = setup();
    expect((await s.poll('short')).status).toBe(400);
    expect((await s.poll('x'.repeat(200))).status).toBe(400);
    expect((await s.poll('has spaces in it and is long enough....')).status).toBe(400);
    await expect(approveCli(s.d, 'short')).rejects.toThrow(/session/i);
  });

  it('shows the same short code the CLI can compute', async () => {
    const code = await cliCode(SESSION);
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(await cliCode(SESSION)).toBe(code);
    expect(await cliCode(`${SESSION}x`)).not.toBe(code);
  });
});
