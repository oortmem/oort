import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact, VatLine } from '@/components/site/LegalPage';
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
  return (
    <LegalPage title="Privacy notice">
      <p>
        This notice explains what the Oort website and Oort Pro collect. Both are run by{' '}
        <strong>{legal.entity}</strong>, {legal.address}, {legal.country}. We are the controller of
        the data described here. Contact us at <Contact />.
      </p>
      <VatLine />

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Early-access list.</strong> If you join, we store your email address, the date and
          which page you used (home or pricing). We store no IP address and no browser details.
        </li>
        <li>
          <strong>Your account.</strong> When you sign in, Clerk keeps your sign-in details: your
          email address, and your name and picture if you use GitHub or Google. Our database keeps
          your Clerk user id and when the account was created.
        </li>
        <li>
          <strong>Billing.</strong> When you subscribe, Stripe collects your payment details,
          billing address and email, and a tax id if you give one. We never see your card number.
          Our database keeps your Stripe customer id, your plan, the subscription status and the
          renewal date.
        </li>
        <li>
          <strong>Oort Pro keys and usage.</strong> For each key: the first 12 characters, a one-way
          hash of the key, the name you gave it, and when it was created, last used and revoked. For
          each month: how many saves and recalls you used, and how many embedding inputs, rerank
          calls and Jev calls the relay passed on. Numbers only, no content.
        </li>
        <li>
          <strong>CLI sign-in.</strong> When you run <code>oort login</code>, we keep a one-way hash
          of the request's secret, a short code, when it started and was approved, the country
          Cloudflare reports for the request (not the IP address), and the operating system and
          computer name the CLI sends, so the approve page can show you which computer asked. An
          hourly job deletes each request once it is an hour old.
        </li>
        <li>
          <strong>Requests and logs.</strong> Cloudflare runs our website and the relay, so it
          necessarily sees your IP address, browser details and approximate location to answer each
          request. We have turned off Cloudflare&apos;s request logs for both. Our own code logs
          only a status code and how long a request took: no IP address, path, headers or content.
          We do not store your IP address anywhere.
        </li>
        <li>
          <strong>Aggregate visit counts.</strong> When switched on, Cloudflare Web Analytics counts
          page views without cookies and without following you across sites. We see totals, not
          people.
        </li>
        <li>
          <strong>Sign-in cookies.</strong> Clerk sets cookies that keep you signed in. They are
          strictly necessary; see <a href="/legal/cookies">cookies</a>. The console is still a demo
          with sample data and sends nothing to us.
        </li>
      </ul>
      <p>
        To stop abuse we count requests for about a minute: per IP address on the early-access form
        and when <code>oort login</code> starts a sign-in, per key and per account on the relay, and
        failed relay sign-ins per IP address. The counters live in memory or in Cloudflare&apos;s
        rate limiter and expire on their own; we never save them.
      </p>

      <h2>What leaves your machine with Oort Pro</h2>
      <p>In plain words:</p>
      <ul>
        <li>
          <strong>Your memories stay on your computer.</strong> They live in the Oort store on your
          machine. Oort Pro does not copy them to us.
        </li>
        <li>
          <strong>To save a memory,</strong> the Oort engine sends the text it is saving to TypeSafe
          (Jev decides whether and how to keep it), to Anthropic (Claude Haiku writes the short
          memory) and to Voyage AI (to turn it into a vector).
        </li>
        <li>
          <strong>To recall,</strong> it sends your search text to Voyage AI to turn it into a
          vector, and the search text with the candidate memories to Voyage AI to rank them.
        </li>
        <li>
          <strong>Our relay passes these requests on.</strong> They go through relay.oortcloud.dev,
          which swaps your Oort key for ours and forwards them. The relay does not store or log what
          you send or what comes back. It keeps only the monthly counts and when each key was last
          used.
        </li>
        <li>
          <strong>Each provider</strong> processes the request to answer it, under its own API
          terms.
        </li>
        <li>
          <strong>With your own keys instead of Pro,</strong> the same requests go straight from
          your machine to the providers, and nothing reaches us.
        </li>
      </ul>

      <h2>Why we use it, and our legal basis</h2>
      <ul>
        <li>
          Early-access list: to tell you when Oort Cloud opens. Basis: your <strong>consent</strong>{' '}
          (GDPR Article 6(1)(a)), given when you tick the box. You can withdraw it at any time.
        </li>
        <li>
          Account, keys, usage counts and the relay: to provide Oort Pro to you. Basis:{' '}
          <strong>our contract</strong> with you (Article 6(1)(b)).
        </li>
        <li>
          Invoices and payment records: to meet bookkeeping law. Basis:{' '}
          <strong>legal obligation</strong> (Article 6(1)(c)).
        </li>
        <li>
          Request logs, rate limits and aggregate analytics: to keep the service safe and know which
          pages are useful. Basis: our <strong>legitimate interest</strong> (Article 6(1)(f)).
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          Early-access list: until Oort Cloud opens plus 12 months, or until you ask us to remove
          you, whichever is first.
        </li>
        <li>
          Account, keys and usage counts: while your account exists. We delete them within 30 days
          after you ask us to close it.
        </li>
        <li>Invoices and payment records: 7 years, as Swedish bookkeeping law requires.</li>
        <li>CLI sign-in requests: at most about two hours.</li>
        <li>
          Status-and-timing logs and aggregate analytics: as long as Cloudflare keeps them, then
          gone.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can ask for access to your data, correction, erasure, a copy to take elsewhere, or to
        object to its use, and you can withdraw consent. Write to <Contact /> from the email on your
        account or on the list. You can also complain to the Swedish supervisory authority,{' '}
        {legal.authority.name}, at <a href={legal.authority.url}>{legal.authority.url}</a>, or to
        the authority in your own country.
      </p>

      <h2>Who receives it, and transfers</h2>
      <p>
        Our processors are Cloudflare, Clerk, Stripe, Voyage AI, TypeSafe and Anthropic. The{' '}
        <a href="/legal/subprocessors">subprocessor list</a> says what each one does. Some process
        data outside your country. Where they do, transfers rely on the EU Standard Contractual
        Clauses, or on the EU-US Data Privacy Framework where the company is certified. We do not
        sell your data and we do not share it for advertising.
      </p>

      <h2>Hosted Oort Cloud</h2>
      <p>
        Hosted Oort Cloud is not open yet. Its terms and data processing agreement will be published
        before it opens.
      </p>
    </LegalPage>
  );
}
