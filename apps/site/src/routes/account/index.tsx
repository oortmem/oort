import { SignOutButton } from '@clerk/tanstack-react-start';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AccountView, type AccountActions } from '@/components/account/AccountView';
import { NotConfigured } from '@/components/account/AuthShell';
import { SiteFooter, SiteNav } from '@/components/site/SiteNav';
import { clerkEnabled } from '@/lib/clerk';
import {
  createKeyFn,
  getOverviewFn,
  getSessionFn,
  openPortalFn,
  revokeKeyFn,
  startCheckoutFn,
} from '@/server/account-fns';

type Search = { checkout?: 'success' | 'cancel'; subscribe?: 'pro' };

export const Route = createFileRoute('/account/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s['checkout'] === 'success' || s['checkout'] === 'cancel'
      ? { checkout: s['checkout'] }
      : {}),
    ...(s['subscribe'] === 'pro' ? { subscribe: 'pro' as const } : {}),
  }),
  beforeLoad: async ({ location }) => {
    const s = await getSessionFn();
    if (s.configured && !s.signedIn) {
      throw redirect({ to: '/signin', search: { redirect_url: location.href } });
    }
    return { configured: s.configured };
  },
  loader: async ({ context }) => (context.configured ? getOverviewFn() : null),
  head: () => ({
    meta: [{ title: 'Your account | Oort' }, { name: 'robots', content: 'noindex' }],
  }),
  component: AccountPage,
});

const go = (url: string) => window.location.assign(url);

function AccountPage() {
  const data = Route.useLoaderData();
  const { checkout, subscribe } = Route.useSearch();
  const router = useRouter();
  const started = useRef(false);
  const [redirecting, setRedirecting] = useState(false);

  const actions: AccountActions = {
    subscribe: async () => {
      const r = await startCheckoutFn();
      if (!r.ok) return r.error;
      setRedirecting(true);
      go(r.value.url);
      return null;
    },
    manage: async () => {
      const r = await openPortalFn();
      if (!r.ok) return r.error;
      go(r.value.url);
      return null;
    },
    createKey: async (name) => {
      const r = await createKeyFn({ data: { name } });
      if (!r.ok) return r.error;
      await router.invalidate();
      return r.value;
    },
    revoke: async (id) => {
      const r = await revokeKeyFn({ data: { id } });
      await router.invalidate();
      return r.ok ? null : r.error;
    },
  };

  // Pricing "Get Pro" lands here with ?subscribe=pro: go straight on to Checkout.
  const entitled = data?.ok ? data.value.entitled : true;
  useEffect(() => {
    if (subscribe !== 'pro' || entitled || started.current) return;
    started.current = true;
    void actions.subscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, entitled]);

  const notice =
    checkout === 'success'
      ? 'Thank you. Pro turns on as soon as Stripe confirms the payment, usually within a minute. Refresh to see it.'
      : checkout === 'cancel'
        ? 'Checkout was cancelled. Nothing was charged.'
        : redirecting
          ? 'Opening Stripe Checkout...'
          : undefined;

  return (
    <div className="min-h-screen">
      <SiteNav />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-8 flex items-center justify-between gap-4">
          <h1 className="text-4xl font-semibold">Your account</h1>
          {clerkEnabled && data?.ok ? (
            <SignOutButton redirectUrl="/">
              <button type="button" className="text-sm text-muted-foreground underline">
                Sign out
              </button>
            </SignOutButton>
          ) : null}
        </div>
        {data === null ? (
          <NotConfigured what="Oort Pro" />
        ) : data.ok ? (
          <AccountView overview={data.value} actions={actions} {...(notice ? { notice } : {})} />
        ) : (
          <p role="alert" className="rounded-xl border border-ember/40 bg-ember/10 px-4 py-3">
            {data.error}
          </p>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
