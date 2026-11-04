import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

export const Route = createFileRoute('/legal/subprocessors')({
  head: () => ({
    meta: [
      { title: 'Subprocessors (draft) | Oort Cloud' },
      {
        name: 'description',
        content:
          'The companies that process data for Oort: Cloudflare, Clerk, Stripe, Voyage AI, TypeSafe and Anthropic.',
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <LegalPage title="Subprocessors">
      <p>
        These companies process personal data for the Oort website and Oort Pro on behalf of{' '}
        <strong>{legal.entity}</strong>. Transfers outside the EU rely on the EU Standard
        Contractual Clauses, or on the EU-US Data Privacy Framework where the company is certified.
      </p>
      <ul>
        <li>
          <strong>Cloudflare</strong>: hosting for the site and the Oort Pro relay, the databases
          (the early-access list, and accounts with key hashes and monthly counts), rate limiting,
          request logs without bodies, and, when switched on, cookieless Web Analytics.
        </li>
        <li>
          <strong>Clerk</strong>: sign-in and user accounts (email address, and name and picture if
          you sign in with GitHub or Google).
        </li>
        <li>
          <strong>Stripe</strong>: payments, subscriptions, tax, invoices and the billing portal.
        </li>
        <li>
          <strong>Voyage AI</strong>: embeddings and rerank for Oort Pro requests. It receives the
          text being saved or searched, in transit.
        </li>
        <li>
          <strong>TypeSafe</strong>: Jev decisions for Oort Pro requests. It receives the text being
          saved, in transit.
        </li>
        <li>
          <strong>Anthropic</strong>: Claude Haiku writes memories for Oort Pro requests. It
          receives the text being saved, in transit.
        </li>
      </ul>
      <p>
        Voyage AI, TypeSafe and Anthropic only see requests you send with Oort Pro. With your own
        keys, the engine on your machine talks to them directly and we are not involved. We will
        update this list before adding another subprocessor. Questions: <Contact />.
      </p>
    </LegalPage>
  );
}
