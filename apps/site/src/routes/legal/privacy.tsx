import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

export const Route = createFileRoute('/legal/privacy')({
  head: () => ({
    meta: [
      { title: 'Privacy notice (draft) | Oort Cloud' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: Page,
});

function Page() {
  void legal;
  void Contact;
  return (
    <LegalPage title="Privacy notice">
      <p>
        This notice explains what the Oort website collects. The website is run by{' '}
        <strong>{legal.entity}</strong>, {legal.address}, {legal.country}. We are the controller of
        the data described here. Contact us at <Contact />.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Early-access list.</strong> If you join, we store your email address, the date and
          which page you used (home or pricing). We store no IP address and no browser details.
        </li>
        <li>
          <strong>Aggregate visit counts.</strong> When switched on, Cloudflare Web Analytics counts
          page views without cookies and without following you across sites. We see totals, not
          people.
        </li>
        <li>
          <strong>Fonts.</strong> The typeface loads from Google Fonts, which sees your IP address
          when a page loads.
        </li>
        <li>
          <strong>Nothing else.</strong> The sign-in page and the console are demos. They create no
          account and send nothing to us. We set no cookies.
        </li>
      </ul>
      <p>
        To stop abuse we count requests per IP address in memory for about a minute. That count is
        never saved.
      </p>
      <h2>Why we use it, and our legal basis</h2>
      <p>
        We use your email only to tell you when Oort Cloud opens and to answer you about it. Our
        legal basis is your <strong>consent</strong> (GDPR Article 6(1)(a)), given when you tick the
        box on the form. You can withdraw it at any time. For aggregate analytics our basis is our
        legitimate interest in knowing which pages are useful.
      </p>
      <h2>How long we keep it</h2>
      <p>
        Until Oort Cloud opens plus 12 months, or until you ask us to remove you, whichever is
        first. Aggregate analytics are kept by Cloudflare under its own schedule.
      </p>
      <h2>Your rights</h2>
      <p>
        You can ask for access to your data, correction, erasure, or to object to its use, and you
        can withdraw consent. To remove your email, write to <Contact /> from that address and we
        will delete it. You can also complain to your local data protection supervisory authority.
      </p>
      <h2>Who receives it, and transfers</h2>
      <p>
        Cloudflare hosts the site and the list and acts as our processor. Cloudflare may process
        data outside your country. Where it does, transfers rely on the EU Standard Contractual
        Clauses. See the <a href="/legal/subprocessors">subprocessor list</a>. We do not sell your
        data and we do not share it for advertising.
      </p>
      <h2>Hosted service</h2>
      <p>
        Hosted Oort Cloud is not open yet. Its terms of service and data processing agreement will
        be published before it opens.
      </p>
    </LegalPage>
  );
}
