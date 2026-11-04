import { SignIn } from '@clerk/tanstack-react-start';
import { createFileRoute } from '@tanstack/react-router';
import { AuthShell, NotConfigured } from '@/components/account/AuthShell';
import { clerkEnabled, safeRedirect } from '@/lib/clerk';

type Search = { redirect_url?: string };

export const Route = createFileRoute('/signin')({
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s['redirect_url'] === 'string' ? { redirect_url: safeRedirect(s['redirect_url']) } : {},
  head: () => ({
    meta: [
      { title: 'Sign in | Oort' },
      { name: 'description', content: 'Sign in to your Oort account to manage Oort Pro.' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: SignInPage,
});

function SignInPage() {
  const { redirect_url } = Route.useSearch();
  const to = safeRedirect(redirect_url);
  return (
    <AuthShell>
      {clerkEnabled ? (
        <SignIn
          routing="hash"
          signUpUrl={`/signup?redirect_url=${encodeURIComponent(to)}`}
          fallbackRedirectUrl={to}
        />
      ) : (
        <NotConfigured what="Sign-in" />
      )}
    </AuthShell>
  );
}
