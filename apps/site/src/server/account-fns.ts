import { createServerFn } from '@tanstack/react-start';
import {
  AccountError,
  approveCli,
  createKey,
  getOverview,
  openPortal,
  revokeKey,
  startCheckout,
  type AccountDeps,
} from './account';
import { toResult } from './result';

/**
 * Server functions for /account and /account/cli. Each one builds its dependencies on the
 * server and the action itself calls Clerk's server-side `auth()` before touching an account.
 */
async function accountDeps(): Promise<AccountDeps> {
  const [{ env }, { auth }, { getRequest }] = await Promise.all([
    import('cloudflare:workers'),
    import('@clerk/tanstack-react-start/server'),
    import('@tanstack/react-start/server'),
  ]);
  if (!env.CLERK_SECRET_KEY) throw new AccountError('Accounts are not set up in this build yet.');
  return {
    db: env.ACCOUNTS_DB,
    getAuth: async () => {
      const a = await auth();
      return { userId: a.isAuthenticated ? a.userId : null };
    },
    stripe: () => {
      throw new AccountError('Billing is not set up yet.');
    },
    origin: new URL(getRequest().url).origin,
    pricePro: env.STRIPE_PRICE_PRO ?? '',
  };
}

/** Like accountDeps, with a real Stripe client when billing secrets are set. */
async function billingDeps(): Promise<AccountDeps> {
  const [d, { env }, { createStripe }] = await Promise.all([
    accountDeps(),
    import('cloudflare:workers'),
    import('./stripe'),
  ]);
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_PRO) {
    throw new AccountError('Billing is not set up yet.');
  }
  const { stripe } = await createStripe(env.STRIPE_SECRET_KEY);
  return { ...d, stripe: () => stripe };
}

export const getSessionFn = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ env }, { auth }] = await Promise.all([
    import('cloudflare:workers'),
    import('@clerk/tanstack-react-start/server'),
  ]);
  if (!env.CLERK_SECRET_KEY) return { configured: false, signedIn: false };
  const a = await auth();
  return { configured: true, signedIn: a.isAuthenticated };
});

export const getOverviewFn = createServerFn({ method: 'GET' }).handler(() =>
  toResult(async () => getOverview(await accountDeps())),
);

export const createKeyFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ name: String((d as { name?: unknown } | null)?.name ?? '') }))
  .handler(({ data }) => toResult(async () => createKey(await accountDeps(), data.name)));

export const revokeKeyFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: String((d as { id?: unknown } | null)?.id ?? '') }))
  .handler(({ data }) => toResult(async () => revokeKey(await accountDeps(), data.id)));

export const startCheckoutFn = createServerFn({ method: 'POST' }).handler(() =>
  toResult(async () => startCheckout(await billingDeps())),
);

export const openPortalFn = createServerFn({ method: 'POST' }).handler(() =>
  toResult(async () => openPortal(await billingDeps())),
);

export const approveCliFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({
    session: String((d as { session?: unknown } | null)?.session ?? ''),
  }))
  .handler(({ data }) => toResult(async () => approveCli(await accountDeps(), data.session)));
