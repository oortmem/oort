// @vitest-environment node
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { getOverview, startCheckout } from '@/server/account';
import type { SubscriptionLike } from '@/server/stripe';
import { handleStripeWebhook, WEBHOOK_EVENTS } from '@/server/stripe-webhook';
import { deps, fakeStripe } from './fakes';

const SECRET = 'whsec_test_secret';
const real = new Stripe('sk_test_offline_never_used');
const crypto = Stripe.createSubtleCryptoProvider();

const sub = (status: string, price = 'price_pro_test', end = 1_798_000_000): SubscriptionLike => ({
  id: 'sub_1',
  customer: 'cus_1',
  status,
  metadata: {},
  items: { data: [{ price: { id: price }, current_period_end: end }] },
});

async function setup() {
  const s = deps();
  await startCheckout(s.d); // creates the account and links cus_1
  const st = fakeStripe({ sub_1: sub('active') });
  const send = async (event: Record<string, unknown>, opts: { badSig?: boolean } = {}) => {
    const payload = JSON.stringify({ object: 'event', api_version: '2026-10-28.endive', ...event });
    const header = await real.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: opts.badSig ? 'whsec_wrong' : SECRET,
      cryptoProvider: crypto,
    });
    const req = new Request('https://oortcloud.dev/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      body: payload,
    });
    return handleStripeWebhook(req, {
      db: s.db,
      stripe: st.stripe,
      verify: (body, sig) =>
        real.webhooks.constructEventAsync(body, sig, SECRET, undefined, crypto),
      pricePro: 'price_pro_test',
      now: () => new Date('2026-11-04T10:00:00Z'),
    });
  };
  const account = () =>
    s.db
      .prepare('SELECT id, plan, status, current_period_end, stripe_customer_id FROM accounts')
      .first<Record<string, string | null>>();
  return { ...s, st, send, account };
}

describe('POST /api/stripe/webhook', () => {
  it('handles exactly the events the spec lists', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.deleted',
        'customer.subscription.updated',
        'invoice.payment_failed',
      ].sort(),
    );
  });

  it('rejects a bad signature with 400 and changes nothing', async () => {
    const s = await setup();
    const res = await s.send(
      { id: 'evt_bad', type: 'customer.subscription.updated', data: { object: sub('active') } },
      { badSig: true },
    );
    expect(res.status).toBe(400);
    expect((await s.account())?.['status']).toBe('none');
    expect(s.st.calls).toHaveLength(0);
  });

  it('rejects a missing signature header with 400', async () => {
    const s = await setup();
    const res = await handleStripeWebhook(
      new Request('https://x/api/stripe/webhook', { method: 'POST', body: '{}' }),
      {
        db: s.db,
        stripe: s.st.stripe,
        verify: () => Promise.reject(new Error('unreachable')),
        pricePro: 'p',
      },
    );
    expect(res.status).toBe(400);
  });

  it('checkout.session.completed links the customer and turns on Pro', async () => {
    const s = await setup();
    const acc = await s.account();
    await s.db.prepare('UPDATE accounts SET stripe_customer_id = NULL').run();
    const res = await s.send({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          object: 'checkout.session',
          client_reference_id: acc!['id'],
          customer: 'cus_1',
          subscription: 'sub_1',
          mode: 'subscription',
        },
      },
    });
    expect(res.status).toBe(200);
    expect(await s.account()).toMatchObject({
      stripe_customer_id: 'cus_1',
      plan: 'pro',
      status: 'active',
      current_period_end: new Date(1_798_000_000 * 1000).toISOString(),
    });
    expect((await getOverview(s.d)).entitled).toBe(true);
  });

  it('customer.subscription.updated follows the live subscription status', async () => {
    const s = await setup();
    s.st.subs['sub_1'] = sub('past_due');
    await s.send({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      data: { object: sub('active') },
    });
    expect(await s.account()).toMatchObject({ plan: 'pro', status: 'past_due' });
  });

  it('customer.subscription.created sets trialing Pro', async () => {
    const s = await setup();
    s.st.subs['sub_1'] = sub('trialing');
    await s.send({
      id: 'evt_c',
      type: 'customer.subscription.created',
      data: { object: sub('x') },
    });
    expect(await s.account()).toMatchObject({ plan: 'pro', status: 'trialing' });
  });

  it('customer.subscription.deleted turns Pro off', async () => {
    const s = await setup();
    s.st.subs['sub_1'] = sub('active');
    await s.send({
      id: 'evt_3',
      type: 'customer.subscription.created',
      data: { object: sub('active') },
    });
    s.st.subs['sub_1'] = sub('canceled');
    await s.send({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: sub('canceled') },
    });
    expect(await s.account()).toMatchObject({ plan: 'free', status: 'canceled' });
  });

  it('invoice.payment_failed reads the subscription from the invoice parent', async () => {
    const s = await setup();
    s.st.subs['sub_1'] = sub('past_due');
    await s.send({
      id: 'evt_5',
      type: 'invoice.payment_failed',
      data: {
        object: {
          object: 'invoice',
          customer: 'cus_1',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        },
      },
    });
    expect(await s.account()).toMatchObject({ status: 'past_due' });
  });

  it('a subscription to another price does not grant Pro', async () => {
    const s = await setup();
    s.st.subs['sub_1'] = sub('active', 'price_something_else');
    await s.send({
      id: 'evt_6',
      type: 'customer.subscription.updated',
      data: { object: sub('x') },
    });
    expect(await s.account()).toMatchObject({ plan: 'free', status: 'active' });
    expect((await getOverview(s.d)).entitled).toBe(false);
  });

  it('is idempotent: a replayed event id is acknowledged and not processed again', async () => {
    const s = await setup();
    const ev = { id: 'evt_7', type: 'customer.subscription.updated', data: { object: sub('a') } };
    expect((await s.send(ev)).status).toBe(200);
    s.st.subs['sub_1'] = sub('canceled');
    const again = await s.send(ev);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(await s.account()).toMatchObject({ status: 'active' });
    expect(s.st.calls.filter((c) => c.method === 'subscriptions.retrieve')).toHaveLength(1);
    const n = await s.db.prepare('SELECT COUNT(*) AS n FROM stripe_events').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('returns 500 and does not record the event when processing fails, so Stripe retries', async () => {
    const s = await setup();
    delete s.st.subs['sub_1'];
    const res = await s.send({
      id: 'evt_8',
      type: 'customer.subscription.updated',
      data: { object: sub('active') },
    });
    expect(res.status).toBe(500);
    const n = await s.db.prepare('SELECT COUNT(*) AS n FROM stripe_events').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('acknowledges and records other event types without acting', async () => {
    const s = await setup();
    const res = await s.send({ id: 'evt_9', type: 'charge.succeeded', data: { object: {} } });
    expect(res.status).toBe(200);
    expect(s.st.calls).toHaveLength(0);
  });
});
