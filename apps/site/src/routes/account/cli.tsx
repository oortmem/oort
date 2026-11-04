import { createFileRoute, redirect } from '@tanstack/react-router';
import { AuthShell, NotConfigured } from '@/components/account/AuthShell';
import { CliApprove } from '@/components/account/CliApprove';
import { approveCliFn, getOverviewFn, getSessionFn } from '@/server/account-fns';

type Search = { session: string };

export const Route = createFileRoute('/account/cli')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    session: typeof s['session'] === 'string' ? s['session'] : '',
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
    meta: [{ title: 'Approve CLI sign-in | Oort' }, { name: 'robots', content: 'noindex' }],
  }),
  component: CliPage,
});

function CliPage() {
  const data = Route.useLoaderData();
  const { session } = Route.useSearch();
  return (
    <AuthShell wide>
      {data === null ? (
        <NotConfigured what="CLI sign-in" />
      ) : (
        <div className="iris-border rounded-3xl bg-card p-8">
          <CliApprove
            session={session}
            entitled={data.ok && data.value.entitled}
            today={new Date().toISOString().slice(0, 10)}
            approve={async () => {
              const r = await approveCliFn({ data: { session } });
              return r.ok ? null : r.error;
            }}
          />
        </div>
      )}
    </AuthShell>
  );
}
