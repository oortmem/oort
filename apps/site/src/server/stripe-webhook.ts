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

async function syncSubscription(subId: string, d: WebhookDeps): Promise<void> {
  // Read the live subscription rather than the event payload, so late or replayed events
  // cannot roll the status back.
  const sub: SubscriptionLike = await d.stripe.subscriptions.retrieve(subId);
  const customer = idOf(sub.customer);
  if (!customer) throw new Error('subscription without customer');
  const hasPro = sub.items.data.some((i) => i.price.id === d.pricePro);
  const plan = hasPro && !ENDED.has(sub.status) ? 'pro' : 'free';
  const ends = [sub.current_period_end, ...sub.items.data.map((i) => i.current_period_end)].filter(
    (n): n is number => typeof n === 'number',
  );
  const periodEnd = ends.length > 0 ? new Date(Math.max(...ends) * 1000).toISOString() : null;
  const r = await d.db
    .prepare(
      'UPDATE accounts SET plan = ?, status = ?, current_period_end = ? WHERE stripe_customer_id = ?',
    )
    .bind(plan, sub.status, periodEnd, customer)
    .run();
  const accountId = sub.metadata?.['account_id'];
  if (r.meta.changes === 0 && accountId) {
    await d.db
      .prepare(
        'UPDATE accounts SET stripe_customer_id = ?, plan = ?, status = ?, current_period_end = ? WHERE id = ? AND stripe_customer_id IS NULL',
      )
      .bind(customer, plan, sub.status, periodEnd, accountId)
      .run();
  }
}

async function apply(event: StripeEventLike, d: WebhookDeps): Promise<void> {
  const o = obj(event.data.object);
  switch (event.type) {
    case 'checkout.session.completed': {
      const accountId =
        typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
      const customer = idOf(o['customer']);
      if (accountId && customer) {
        await d.db
          .prepare(
            'UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)',
          )
          .bind(customer, accountId, customer)
          .run();
      }
      const sub = idOf(o['subscription']);
      if (sub) await syncSubscription(sub, d);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = idOf(o);
      if (sub) await syncSubscription(sub, d);
      return;
    }
    case 'invoice.payment_failed': {
      const parent = obj(obj(o['parent'])['subscription_details']);
      const sub = idOf(parent['subscription']) ?? idOf(o['subscription']);
      if (sub) await syncSubscription(sub, d);
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
