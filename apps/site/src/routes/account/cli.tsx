import { createFileRoute, redirect } from '@tanstack/react-router';
import { AuthShell, NotConfigured } from '@/components/account/AuthShell';
import { CliApprove } from '@/components/account/CliApprove';
import { approveCliFn, getOverviewFn, getSessionFn, lookupCliFn } from '@/server/account-fns';

// The page carries no session id: the user types the code their terminal shows (review I3, I4).
export const Route = createFileRoute('/account/cli')({
  beforeLoad: async () => {
    const s = await getSessionFn();
    if (s.configured && !s.signedIn) {
      throw redirect({ to: '/signin', search: { redirect_url: '/account/cli' } });
    }
    return { configured: s.configured };
  },
  loader: async ({ context }) => (context.configured ? getOverviewFn() : null),
  head: () => ({
    meta: [{ title: 'Approve CLI sign-in | Oort' }, { name: 'robots', content: 'noindex' }],
  }),
  component: CliPage,
});

function CliPage() {
  const data = Route.useLoaderData();
  return (
    <AuthShell wide>
      {data === null ? (
        <NotConfigured what="CLI sign-in" />
      ) : (
        <div className="iris-border rounded-3xl bg-card p-8">
          <CliApprove
            entitled={data.ok && data.value.entitled}
            today={new Date().toISOString().slice(0, 10)}
            lookup={(code) => lookupCliFn({ data: { code } })}
            approve={async (code) => {
              const r = await approveCliFn({ data: { code } });
              return r.ok ? null : r.error;
            }}
          />
        </div>
      )}
    </AuthShell>
  );
}
