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
        <strong>We set no cookies.</strong> The Oort website does not use cookies, local tracking or
        advertising pixels, so there is no cookie banner.
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
