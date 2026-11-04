import { SignUp } from '@clerk/tanstack-react-start';
import { createFileRoute } from '@tanstack/react-router';
import { AuthShell, NotConfigured } from '@/components/account/AuthShell';
import { clerkEnabled, safeRedirect } from '@/lib/clerk';

type Search = { redirect_url?: string };

export const Route = createFileRoute('/signup')({
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s['redirect_url'] === 'string' ? { redirect_url: safeRedirect(s['redirect_url']) } : {},
  head: () => ({
    meta: [
      { title: 'Create an account | Oort' },
      { name: 'description', content: 'Create an Oort account for Oort Pro.' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: SignUpPage,
});

function SignUpPage() {
  const { redirect_url } = Route.useSearch();
  const to = safeRedirect(redirect_url);
  return (
    <AuthShell>
      {clerkEnabled ? (
        <SignUp
          routing="hash"
          signInUrl={`/signin?redirect_url=${encodeURIComponent(to)}`}
          fallbackRedirectUrl={to}
        />
      ) : (
        <NotConfigured what="Sign-up" />
      )}
    </AuthShell>
  );
}
