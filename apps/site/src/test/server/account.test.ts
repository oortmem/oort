// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  NotSignedIn,
  approveCli,
  createKey,
  getOverview,
  openPortal,
  revokeKey,
  startCheckout,
} from '@/server/account';
import { hashKey } from '@/server/keys';
import { rates } from '@/lib/oort-data';
import { deps, T0 } from './fakes';

const setStatus = (db: ReturnType<typeof deps>['db'], status: string, plan = 'pro') =>
  db
    .prepare('UPDATE accounts SET status = ?, plan = ? WHERE clerk_user_id = ?')
    .bind(status, plan, 'user_1')
    .run();

describe('every account action verifies the Clerk session first', () => {
  const actions: [string, (d: ReturnType<typeof deps>['d']) => Promise<unknown>][] = [
    ['getOverview', (d) => getOverview(d)],
    ['createKey', (d) => createKey(d, 'Laptop')],
    ['revokeKey', (d) => revokeKey(d, 'key_x')],
    ['startCheckout', (d) => startCheckout(d)],
    ['openPortal', (d) => openPortal(d)],
    ['approveCli', (d) => approveCli(d, 'a'.repeat(43))],
  ];
  for (const [name, run] of actions) {
    it(`${name} rejects a signed-out request and touches nothing`, async () => {
      const s = deps({ userId: null });
      await expect(run(s.d)).rejects.toBeInstanceOf(NotSignedIn);
      const rows = await s.db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
      expect(rows?.n).toBe(0);
      expect(s.stripe.calls).toHaveLength(0);
    });
  }
});

describe('overview', () => {
  it('creates the account on first visit with plan free and status none', async () => {
    const s = deps();
    const o = await getOverview(s.d);
    expect(o).toMatchObject({ plan: 'free', status: 'none', entitled: false, keys: [] });
    expect(o.usage).toEqual({
      month: '2026-11',
      saves: 0,
      recalls: 0,
      limits: { saves: rates.managed.Pro.saves, recalls: rates.managed.Pro.recalls },
    });
    await getOverview(s.d);
    const n = await s.db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("shows this month's usage", async () => {
    const s = deps();
    await getOverview(s.d);
    const acc = await s.db
      .prepare('SELECT id FROM accounts WHERE clerk_user_id = ?')
      .bind('user_1')
      .first<{ id: string }>();
    await s.db
      .prepare('INSERT INTO usage (account_id, month, saves, recalls) VALUES (?, ?, ?, ?)')
      .bind(acc!.id, '2026-11', 12, 34)
      .run();
    await s.db
      .prepare('INSERT INTO usage (account_id, month, saves, recalls) VALUES (?, ?, ?, ?)')
      .bind(acc!.id, '2026-10', 999, 999)
      .run();
    expect((await getOverview(s.d)).usage).toMatchObject({ saves: 12, recalls: 34 });
  });

  it('is entitled only while active or trialing on Pro', async () => {
    const s = deps();
    await getOverview(s.d);
    await setStatus(s.db, 'active');
    expect((await getOverview(s.d)).entitled).toBe(true);
    await setStatus(s.db, 'trialing');
    expect((await getOverview(s.d)).entitled).toBe(true);
    await setStatus(s.db, 'past_due');
    expect((await getOverview(s.d)).entitled).toBe(false);
  });

  it("never shows another user's keys", async () => {
    const s = deps();
    await createKey(s.d, 'Mine');
    s.signInAs('user_2');
    expect((await getOverview(s.d)).keys).toEqual([]);
  });
});

describe('API keys', () => {
  it('shows a new key once and stores only its hash and prefix', async () => {
    const s = deps();
    const k = await createKey(s.d, '  Work laptop ');
    expect(k.key).toMatch(/^oort_sk_/);
    expect(k.name).toBe('Work laptop');
    expect(k.prefix).toBe(k.key.slice(0, 12));
    const row = await s.db.prepare('SELECT * FROM api_keys').first<Record<string, unknown>>();
    expect(row?.['hash']).toBe(await hashKey(k.key));
    expect(JSON.stringify(row)).not.toContain(k.key);
    const listed = (await getOverview(s.d)).keys;
    expect(listed).toEqual([
      {
        id: k.id,
        prefix: k.prefix,
        name: 'Work laptop',
        createdAt: T0.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(k.key);
    expect(JSON.stringify(listed)).not.toContain(String(row?.['hash']));
  });

  it('rejects an empty or very long name', async () => {
    const s = deps();
    await expect(createKey(s.d, '   ')).rejects.toThrow(/name/i);
    await expect(createKey(s.d, 'x'.repeat(61))).rejects.toThrow(/name/i);
  });

  it('caps live keys per account at 20', async () => {
    const s = deps();
    for (let i = 0; i < 20; i++) await createKey(s.d, `k${i}`);
    await expect(createKey(s.d, 'one more')).rejects.toThrow(/20/);
  });

  it('revokes a key of the signed-in user only', async () => {
    const s = deps();
    const k = await createKey(s.d, 'Mine');
    s.signInAs('user_2');
    expect(await revokeKey(s.d, k.id)).toEqual({ revoked: false });
    s.signInAs('user_1');
    expect(await revokeKey(s.d, k.id)).toEqual({ revoked: true });
    expect((await getOverview(s.d)).keys[0]?.revokedAt).toBe(T0.toISOString());
    expect(await revokeKey(s.d, k.id)).toEqual({ revoked: false });
  });
});

describe('billing', () => {
  it('starts a subscription Checkout with automatic tax and a required billing address', async () => {
    const s = deps();
    const { url } = await startCheckout(s.d);
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const acc = await s.db
      .prepare('SELECT id, stripe_customer_id FROM accounts')
      .first<{ id: string; stripe_customer_id: string }>();
    expect(acc?.stripe_customer_id).toBe('cus_1');
    const create = s.stripe.calls.find((c) => c.method === 'customers.create');
    expect(create?.params).toEqual({ metadata: { account_id: acc!.id } });
    const cs = s.stripe.calls.find((c) => c.method === 'checkout.sessions.create')!.params;
    expect(cs).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: acc!.id,
      line_items: [{ price: 'price_pro_test', quantity: 1 }],
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      subscription_data: { metadata: { account_id: acc!.id } },
      consent_collection: { terms_of_service: 'required' },
      success_url: 'https://oortcloud.dev/account?checkout=success',
      cancel_url: 'https://oortcloud.dev/account?checkout=cancel',
    });
    expect(JSON.stringify(cs)).toContain('/legal/terms-of-service');
    expect(JSON.stringify(cs)).toMatch(/14 days/);
  });

  it('reuses the Stripe customer on a second Checkout', async () => {
    const s = deps();
    await startCheckout(s.d);
    await startCheckout(s.d);
    expect(s.stripe.calls.filter((c) => c.method === 'customers.create')).toHaveLength(1);
  });

  it('does not start a second subscription while one is active', async () => {
    const s = deps();
    await getOverview(s.d);
    await setStatus(s.db, 'active');
    await expect(startCheckout(s.d)).rejects.toThrow(/already/i);
    expect(s.stripe.calls).toHaveLength(0);
  });

  it('sends the user to the Portal while any subscription has not ended', async () => {
    for (const status of ['past_due', 'unpaid', 'incomplete', 'paused']) {
      const s = deps();
      await startCheckout(s.d);
      s.stripe.subs['sub_1'] = {
        id: 'sub_1',
        customer: 'cus_1',
        status,
        items: { data: [{ price: { id: 'price_pro_test' } }] },
      };
      const before = s.stripe.calls.filter((c) => c.method === 'checkout.sessions.create').length;
      expect(await startCheckout(s.d), status).toEqual({
        url: 'https://billing.stripe.com/p/session/test_1',
        portal: true,
      });
      expect(s.stripe.calls.filter((c) => c.method === 'checkout.sessions.create')).toHaveLength(
        before,
      );
    }
  });

  it('starts Checkout again once every subscription has ended', async () => {
    const s = deps();
    await startCheckout(s.d);
    s.stripe.subs['sub_1'] = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'canceled',
      items: { data: [{ price: { id: 'price_pro_test' } }] },
    };
    expect((await startCheckout(s.d)).url).toContain('checkout.stripe.com');
  });

  it('expires an open Checkout from another tab before starting a new one', async () => {
    const s = deps();
    await startCheckout(s.d);
    expect(s.stripe.openSessions()).toHaveLength(1);
    const first = s.stripe.openSessions()[0]!.id;
    await startCheckout(s.d);
    expect(s.stripe.calls).toContainEqual({ method: 'checkout.sessions.expire', params: first });
    expect(s.stripe.openSessions()).toHaveLength(1);
    expect(s.stripe.openSessions()[0]!.id).not.toBe(first);
  });

  it('opens the Customer Portal for the account customer', async () => {
    const s = deps();
    await startCheckout(s.d);
    const { url } = await openPortal(s.d);
    expect(url).toBe('https://billing.stripe.com/p/session/test_1');
    expect(s.stripe.calls.at(-1)).toEqual({
      method: 'billingPortal.sessions.create',
      params: { customer: 'cus_1', return_url: 'https://oortcloud.dev/account' },
    });
  });

  it('has no portal before the first Checkout', async () => {
    const s = deps();
    await expect(openPortal(s.d)).rejects.toThrow(/subscribe/i);
  });
});
