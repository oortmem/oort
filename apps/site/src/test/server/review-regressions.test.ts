// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { MAX_LIVE_KEYS, approveCli, getOverview, startCheckout } from '@/server/account';
import { handleCliCreate, handleCliPoll } from '@/server/cli-session';
import type { SubscriptionLike } from '@/server/stripe';
import { handleStripeWebhook } from '@/server/stripe-webhook';
import { safeRedirect } from '@/lib/clerk';
import { deps, fakeStripe } from './fakes';

/**
 * The independent review's site proofs (review-pro/proofs/site-review.test.ts), inverted: each
 * one asserted a flaw at 63e6187 and now asserts the fixed behaviour.
 */

const SECRET = 'whsec_test_secret';
const real = new Stripe('sk_test_offline_never_used');
const crypto = Stripe.createSubtleCryptoProvider();
const sub = (id: string, status: string): SubscriptionLike => ({
  id,
  customer: 'cus_1',
  status,
  metadata: {},
  items: { data: [{ price: { id: 'price_pro_test' }, current_period_end: 1_798_000_000 }] },
});
let evn = 0;
async function setup() {
  const s = deps();
  await startCheckout(s.d);
  const st = fakeStripe({});
  const send = async (type: string, object: Record<string, unknown>) => {
    const payload = JSON.stringify({ id: `evt_${++evn}`, object: 'event', type, data: { object } });
    const header = await real.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: SECRET,
      cryptoProvider: crypto,
    });
    return handleStripeWebhook(
      new Request('https://x/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': header },
        body: payload,
      }),
      {
        db: s.db,
        stripe: st.stripe,
        pricePro: 'price_pro_test',
        verify: (b, sig) => real.webhooks.constructEventAsync(b, sig, SECRET, undefined, crypto),
      },
    );
  };
  return { ...s, st, send };
}

describe('review I2: entitlement comes from all of the customer’s subscriptions', () => {
  it('a past_due user is sent to the Portal, and a cancelled old sub never removes Pro', async () => {
    const s = await setup();
    s.st.subs['sub_old'] = sub('sub_old', 'past_due');
    await s.send('invoice.payment_failed', { customer: 'cus_1', subscription: 'sub_old' });
    expect((await getOverview(s.d)).entitled).toBe(false);
    // A non-ended subscription exists, so Checkout refuses and sends the user to the Portal.
    s.d.stripe = () => s.st.stripe;
    const before = s.st.calls.filter((c) => c.method === 'checkout.sessions.create').length;
    const r = await startCheckout(s.d);
    expect(r).toEqual({ url: 'https://billing.stripe.com/p/session/test_1', portal: true });
    expect(s.st.calls.filter((c) => c.method === 'checkout.sessions.create')).toHaveLength(before);
    // Even if a second subscription exists (bought before this fix, or two tabs at once)...
    s.st.subs['sub_new'] = sub('sub_new', 'active');
    await s.send('checkout.session.completed', {
      client_reference_id: 'x',
      customer: 'cus_1',
      subscription: 'sub_new',
    });
    expect((await getOverview(s.d)).entitled).toBe(true);
    // ...Stripe giving up on the old one leaves the paying user on Pro.
    s.st.subs['sub_old'] = sub('sub_old', 'canceled');
    await s.send('customer.subscription.deleted', { id: 'sub_old', customer: 'cus_1' });
    const o = await getOverview(s.d);
    expect(o.entitled).toBe(true);
    expect(o.plan).toBe('pro');
    expect(o.status).toBe('active');
  });
});

const b64 = (b: Buffer) => b.toString('base64url');
function cliSecret() {
  const raw = randomBytes(32);
  return { secret: b64(raw), challenge: b64(createHash('sha256').update(raw).digest()) };
}

function cli(s: ReturnType<typeof deps>) {
  const create = async (challenge: string) => {
    const res = await handleCliCreate(
      new Request('https://oortcloud.dev/api/cli/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge, os: 'macOS', host: 'laptop' }),
      }),
      {
        db: s.db,
        now: s.d.now!,
        allow: async () => true,
        origin: 'https://oortcloud.dev',
        country: 'SE',
      },
    );
    return { res, body: (await res.json()) as { user_code: string; verification_uri: string } };
  };
  const poll = (secret: string) =>
    handleCliPoll(
      new Request('https://oortcloud.dev/api/cli/session/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      }),
      { db: s.db, now: s.d.now! },
    );
  return { create, poll };
}

describe('review I3/I4: CLI login', () => {
  it('the approve URL carries no secret, and only the CLI holding S collects the key', async () => {
    const s = deps();
    const c = cli(s);
    const victim = cliSecret();
    const { body } = await c.create(victim.challenge);
    expect(body.verification_uri).toBe('https://oortcloud.dev/account/cli');
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect((await c.poll(victim.secret)).status).toBe(202);
    await approveCli(s.d, body.user_code);
    // An observer of the page, the code or the challenge cannot poll the key out.
    for (const guess of [victim.challenge, body.user_code, cliSecret().secret]) {
      expect((await c.poll(guess)).status).not.toBe(200);
    }
    const mine = await c.poll(victim.secret);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { key: string }).key).toMatch(/^oort_sk_/);
  });
});

describe('review I5: the poll is read-only', () => {
  it('polling 200 unknown secrets writes nothing and answers 404', async () => {
    const s = deps();
    const c = cli(s);
    for (let i = 0; i < 200; i++) expect((await c.poll(cliSecret().secret)).status).toBe(404);
    const n = await s.db.prepare('SELECT COUNT(*) AS n FROM cli_sessions').first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe('review C1: MAX_LIVE_KEYS holds on the CLI path', () => {
  it('the login past the limit gets a clear error, and no key is minted', async () => {
    const s = deps();
    const c = cli(s);
    let last: Response | undefined;
    for (let i = 0; i < MAX_LIVE_KEYS + 1; i++) {
      const sec = cliSecret();
      const { body } = await c.create(sec.challenge);
      if (i < MAX_LIVE_KEYS) {
        await approveCli(s.d, body.user_code);
      } else {
        // The page refuses too, but the poll is the line that holds: approve it behind its back.
        await s.db
          .prepare(
            "UPDATE cli_sessions SET account_id = (SELECT id FROM accounts), approved_at = 'x'",
          )
          .run();
      }
      last = await c.poll(sec.secret);
    }
    expect(last!.status).toBe(409);
    expect(((await last!.json()) as { error: string }).error).toMatch(
      /revoke a key at .*\/account/i,
    );
    const n = await s.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL')
      .first<{ n: number }>();
    expect(n!.n).toBe(MAX_LIVE_KEYS);
  });
});

describe('review M5: safeRedirect', () => {
  it('refuses a tab-smuggled protocol-relative URL', () => {
    const v = '/\t/evil.example';
    expect(new URL(v, 'https://oortcloud.dev').origin).toBe('https://evil.example');
    expect(safeRedirect(v)).toBe('/account');
  });
});
