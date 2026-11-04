import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

export const Route = createFileRoute('/legal/subprocessors')({
  head: () => ({
    meta: [{ title: 'Subprocessors (draft) | Oort Cloud' }, { name: 'robots', content: 'noindex' }],
  }),
  component: Page,
});

function Page() {
  void legal;
  void Contact;
  return (
    <LegalPage title="Subprocessors">
      <p>
        These companies process personal data for the Oort website on behalf of{' '}
        <strong>{legal.entity}</strong>.
      </p>
      <ul>
        <li>
          <strong>Cloudflare, Inc.</strong>: hosting, the early-access list (D1) and, when switched
          on, cookieless Web Analytics. Transfers outside the EU rely on Standard Contractual
          Clauses.
        </li>
      </ul>
      <p>
        Cloudflare is the only subprocessor for the site today. Google Fonts serves the typeface
        directly to your browser and is not a processor of our data. We will update this list before
        adding another, and publish the hosted-service list before Oort Cloud opens.
      </p>
    </LegalPage>
  );
}
