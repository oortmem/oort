import { sqliteD1 } from '../../../../relay/src/test/d1-sqlite';
import type { AccountDeps } from '@/server/account';
import type { StripeLike, SubscriptionLike } from '@/server/stripe';

export { sqliteD1 };

export const T0 = new Date('2026-11-04T10:00:00Z');

/** A Stripe stand-in that records every call and never touches the network. */
export function fakeStripe(subs: Record<string, SubscriptionLike> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  let n = 0;
  const stripe: StripeLike = {
    customers: {
      async create(params) {
        calls.push({ method: 'customers.create', params });
        return { id: `cus_${++n}` };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.push({ method: 'checkout.sessions.create', params });
          return { url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          calls.push({ method: 'billingPortal.sessions.create', params });
          return { url: 'https://billing.stripe.com/p/session/test_1' };
        },
      },
    },
    subscriptions: {
      async retrieve(id) {
        calls.push({ method: 'subscriptions.retrieve', params: id });
        const s = subs[id];
        if (!s) throw new Error('No such subscription');
        return s;
      },
    },
  };
  return { stripe, calls, subs };
}

export function deps(over: Partial<AccountDeps> & { userId?: string | null } = {}) {
  const db = over.db ?? sqliteD1();
  const s = fakeStripe();
  let userId: string | null = over.userId === undefined ? 'user_1' : over.userId;
  let now = T0;
  const d: AccountDeps = {
    db,
    getAuth: async () => ({ userId }),
    stripe: () => s.stripe,
    now: () => now,
    origin: 'https://oortcloud.dev',
    pricePro: 'price_pro_test',
    ...over,
  };
  return {
    d,
    db,
    stripe: s,
    signOut: () => (userId = null),
    signInAs: (id: string) => (userId = id),
    at: (t: Date) => (now = t),
  };
}
