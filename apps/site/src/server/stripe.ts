import type Stripe from 'stripe';

/** The parts of a Stripe Subscription the webhook reads (API version 2026-10-28). */
export interface SubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  metadata?: Record<string, string> | null;
  /** Older API versions only; newer ones put it on each item. */
  current_period_end?: number;
  items: { data: { price: { id: string }; current_period_end?: number }[] };
}

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: unknown };
}

/** The slice of the Stripe SDK the site uses, so tests can use a fake that never calls Stripe. */
export interface StripeLike {
  customers: {
    create(params: { metadata: Record<string, string> }): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  subscriptions: { retrieve(id: string): Promise<SubscriptionLike> };
}

/**
 * The real Stripe client for Workers: fetch for HTTP and SubtleCrypto for webhook signatures
 * (`constructEventAsync`, because SubtleCrypto is async only).
 */
export async function createStripe(secretKey: string): Promise<{
  stripe: StripeLike;
  verify: (payload: string, signature: string, secret: string) => Promise<StripeEventLike>;
}> {
  const { default: StripeSdk } = await import('stripe');
  const s = new StripeSdk(secretKey, { httpClient: StripeSdk.createFetchHttpClient() });
  const crypto = StripeSdk.createSubtleCryptoProvider();
  return {
    stripe: {
      customers: { create: (p) => s.customers.create(p) },
      checkout: { sessions: { create: (p) => s.checkout.sessions.create(p) } },
      billingPortal: { sessions: { create: (p) => s.billingPortal.sessions.create(p) } },
      subscriptions: {
        retrieve: async (id) => (await s.subscriptions.retrieve(id)) as unknown as SubscriptionLike,
      },
    },
    verify: async (payload, signature, secret) =>
      (await s.webhooks.constructEventAsync(
        payload,
        signature,
        secret,
        undefined,
        crypto,
      )) as unknown as StripeEventLike,
  };
}
