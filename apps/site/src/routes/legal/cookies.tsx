import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

export const Route = createFileRoute('/legal/cookies')({
  head: () => ({
    meta: [{ title: 'Cookies (draft) | Oort Cloud' }, { name: 'robots', content: 'noindex' }],
  }),
  component: Page,
});

function Page() {
  void legal;
  void Contact;
  return (
    <LegalPage title="Cookies">
      <p>
        <strong>We set no advertising or tracking cookies</strong>, so there is no cookie banner.
      </p>
      <p>
        <strong>Sign-in cookies.</strong> When you sign in to your Oort account, Clerk, our sign-in
        provider, sets cookies that keep you signed in (for example <code>__session</code> and{' '}
        <code>__client_uat</code>). They are strictly necessary for the account pages, so they need
        no consent. If you never sign in, they are not set.
      </p>
      <p>
        When switched on, we use Cloudflare Web Analytics, which is cookieless. It counts page views
        in aggregate and does not follow you across sites.
      </p>
      <p>
        Fonts are served from our own site, not from a third party. Questions: <Contact />.
      </p>
    </LegalPage>
  );
}
