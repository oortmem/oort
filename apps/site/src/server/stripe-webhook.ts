import type { D1DatabaseLike } from './d1';
import type { StripeEventLike, StripeLike, SubscriptionLike } from './stripe';

/** The events the Stripe webhook endpoint subscribes to (spec §4). */
export const WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

const ENDED = new Set(['canceled', 'incomplete_expired']);

export interface WebhookDeps {
  db: D1DatabaseLike;
  stripe: Pick<StripeLike, 'subscriptions'>;
  /** `stripe.webhooks.constructEventAsync` with the webhook secret and SubtleCrypto. */
  verify: (payload: string, signature: string) => Promise<StripeEventLike>;
  pricePro: string;
  now?: () => Date;
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });
const obj = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
const idOf = (x: unknown): string | null =>
  typeof x === 'string' ? x : typeof obj(x)['id'] === 'string' ? (obj(x)['id'] as string) : null;

/** Lower is better: the subscription that decides the account's plan and status. */
const RANK: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  unpaid: 3,
  incomplete: 4,
  paused: 5,
  canceled: 8,
  incomplete_expired: 9,
};
const rank = (s: SubscriptionLike) => RANK[s.status] ?? 7;

function periodEndOf(sub: SubscriptionLike): number | null {
  const ends = [sub.current_period_end, ...sub.items.data.map((i) => i.current_period_end)].filter(
    (n): n is number => typeof n === 'number',
  );
  return ends.length > 0 ? Math.max(...ends) : null;
}

/** The best subscription: live before ended, then the later period end. */
function best(subs: SubscriptionLike[]): SubscriptionLike | undefined {
  return [...subs].sort(
    (a, b) => rank(a) - rank(b) || (periodEndOf(b) ?? 0) - (periodEndOf(a) ?? 0),
  )[0];
}

/**
 * Recomputes the account from every subscription of the customer, not from the one the event is
 * about: a past_due or cancelled old subscription must never hide a newer active one. The hinted
 * subscription is read directly as well, in case the list lags behind.
 */
async function syncCustomer(
  customerHint: string | null,
  subHint: string | null,
  d: WebhookDeps,
): Promise<void> {
  const hinted = subHint ? await d.stripe.subscriptions.retrieve(subHint) : undefined;
  const customer = customerHint ?? (hinted ? idOf(hinted.customer) : null);
  if (!customer) throw new Error('event without customer');
  const listed = (await d.stripe.subscriptions.list({ customer, status: 'all', limit: 100 })).data;
  const subs = hinted ? [hinted, ...listed.filter((x) => x.id !== hinted.id)] : listed;

  const pro = subs.filter((x) => x.items.data.some((i) => i.price.id === d.pricePro));
  const chosen = best(pro) ?? best(subs);
  const plan = chosen && pro.includes(chosen) && !ENDED.has(chosen.status) ? 'pro' : 'free';
  const status = chosen?.status ?? 'none';
  const end = chosen ? periodEndOf(chosen) : null;
  const periodEnd = end === null ? null : new Date(end * 1000).toISOString();

  const r = await d.db
    .prepare(
      'UPDATE accounts SET plan = ?, status = ?, current_period_end = ? WHERE stripe_customer_id = ?',
    )
    .bind(plan, status, periodEnd, customer)
    .run();
  const accountId = subs.map((x) => x.metadata?.['account_id']).find((x) => x);
  if (r.meta.changes === 0 && accountId) {
    await d.db
      .prepare(
        'UPDATE accounts SET stripe_customer_id = ?, plan = ?, status = ?, current_period_end = ? WHERE id = ? AND stripe_customer_id IS NULL',
      )
      .bind(customer, plan, status, periodEnd, accountId)
      .run();
  }
}

async function apply(event: StripeEventLike, d: WebhookDeps): Promise<void> {
  const o = obj(event.data.object);
  const customer = idOf(o['customer']);
  switch (event.type) {
    case 'checkout.session.completed': {
      const accountId =
        typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
      if (accountId && customer) {
        await d.db
          .prepare(
            'UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)',
          )
          .bind(customer, accountId, customer)
          .run();
      }
      const sub = idOf(o['subscription']);
      if (sub || customer) await syncCustomer(customer, sub, d);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = idOf(o);
      if (sub || customer) await syncCustomer(customer, sub, d);
      return;
    }
    case 'invoice.payment_failed': {
      const parent = obj(obj(o['parent'])['subscription_details']);
      const sub = idOf(parent['subscription']) ?? idOf(o['subscription']);
      if (sub || customer) await syncCustomer(customer, sub, d);
      return;
    }
  }
}

/** POST /api/stripe/webhook: verifies the signature, then applies each event id once. */
export async function handleStripeWebhook(request: Request, d: WebhookDeps): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return reply(400, { error: 'Missing Stripe-Signature header.' });
  const payload = await request.text();
  let event: StripeEventLike;
  try {
    event = await d.verify(payload, signature);
  } catch {
    return reply(400, { error: 'Invalid signature.' });
  }

  const seen = await d.db
    .prepare('SELECT id FROM stripe_events WHERE id = ?')
    .bind(event.id)
    .first();
  if (seen) return reply(200, { received: true, duplicate: true });

  try {
    if (WEBHOOK_EVENTS.has(event.type)) await apply(event, d);
  } catch {
    // Not recorded, so Stripe retries. No payload is logged.
    return reply(500, { error: 'Webhook processing failed.' });
  }
  await d.db
    .prepare(
      'INSERT INTO stripe_events (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
    )
    .bind(event.id, (d.now ?? (() => new Date()))().toISOString())
    .run();
  return reply(200, { received: true });
}
