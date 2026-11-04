import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact, GeneralContact, VatLine } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';
import { rates } from '@/lib/oort-data';

export const Route = createFileRoute('/legal/terms-of-service')({
  head: () => ({
    meta: [
      { title: 'Oort Pro terms of service (draft) | Oort Cloud' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: Page,
});

const pro = rates.managed.Pro;
const n = (x: number) => x.toLocaleString('en-US');

function Page() {
  return (
    <LegalPage title="Oort Pro terms of service">
      <p>
        These terms are the agreement between you and <strong>{legal.entity}</strong>,{' '}
        {legal.address}, {legal.country} ("we", "us") for Oort Pro. They apply when you subscribe.
        The <a href="/legal/terms">terms of use</a> cover the website itself. Questions:{' '}
        <GeneralContact />. Privacy and data requests: <Contact />.
      </p>
      <VatLine />

      <h2>1. What Oort Pro is</h2>
      <p>
        Oort Pro is a monthly subscription for the open source Oort engine that runs on your own
        computer. With Pro, the engine reaches the model services it needs through our relay at
        relay.oortcloud.dev, using our keys instead of yours: Voyage AI (embeddings and rerank),
        TypeSafe (Jev decisions) and Anthropic (Claude Haiku, to write memories).
      </p>
      <p>
        Your memories stay on your machine. We do not host, copy or keep them. The relay passes each
        request on and stores no content. The privacy notice explains{' '}
        <a href="/legal/privacy">what leaves your machine with Oort Pro</a>. Hosted Oort Cloud is a
        separate service that is not open yet.
      </p>

      <h2>2. Your account and keys</h2>
      <ul>
        <li>You need an Oort account to subscribe. Sign-in is provided by Clerk.</li>
        <li>
          An Oort key is shown once, when you create it. Keep it secret. Anyone with your key can
          use your Pro allowance.
        </li>
        <li>
          If a key is lost or exposed, revoke it on your <a href="/account">account page</a>. It
          stops working at once.
        </li>
        <li>We may revoke a key that is shared publicly or misused, and will tell you why.</li>
      </ul>

      <h2>3. Price, billing and tax</h2>
      <p>
        Oort Pro costs <strong>${pro.price} a month</strong>, plus VAT or sales tax where it
        applies, which Checkout shows before you pay. Stripe charges it in advance each month, from
        the day you subscribe, until you cancel. We may change the price with at least 30 days'
        notice by email before your next renewal, and you can cancel before the new price applies.
      </p>

      <h2>4. Included use and limits</h2>
      <p>
        Each calendar month (UTC) includes{' '}
        <strong>
          {n(pro.saves)} saves and {n(pro.recalls)} recalls
        </strong>
        . A save is one call that writes a memory. A recall is one search call (one rerank, or one
        search embedding). When you reach either amount, that part of Pro stops until the 1st of the
        next month. Nothing extra is charged: extra use is not billed today.
      </p>
      <p>
        Each key may send up to 60 requests every 10 seconds. The relay accepts only the models and
        request sizes Oort itself uses. We may change the included amounts with notice as in section
        3.
      </p>

      <h2>5. Cancel any time</h2>
      <p>
        Cancel any time, in one click, under Manage billing on your account page (the Stripe
        customer portal). There is no cancellation fee. Pro keeps working until the end of the month
        you paid for and then stops.
      </p>

      <h2>6. Your 14-day right of withdrawal</h2>
      <p>
        If you are a consumer in the EU or the EEA, you normally have 14 days to withdraw from a
        contract like this one. Oort Pro starts as soon as you subscribe. At Checkout you ask us to
        start right away, and you confirm that you understand you lose the right of withdrawal once
        the service has started.
      </p>
      <p>
        Our policy goes further than that: if you ask within 14 days of your first payment, we
        refund the unused part of that month, pro rata. Write to <GeneralContact /> from the email
        on your account, or cancel in Manage billing and then write to us.
      </p>

      <h2>7. Fair use</h2>
      <p>
        Follow the <a href="/legal/acceptable-use">acceptable use policy</a>. Do not try to get
        around the limits, resell or share access, or use the relay for anything other than the
        calls the Oort engine makes.
      </p>

      <h2>8. Availability</h2>
      <p>
        We work to keep Pro running but make no uptime promise today, and there is no SLA. The model
        providers can have outages of their own. We may pause the relay for maintenance or to stop
        abuse.
      </p>

      <h2>9. Liability</h2>
      <p>
        To the extent the law allows, our total liability to you is limited to what you paid us for
        Pro in the 12 months before the claim. Nothing in these terms limits your rights as a
        consumer or any liability that cannot be limited by law.
      </p>

      <h2>10. Ending Pro</h2>
      <p>
        We may end Oort Pro with at least 30 days' notice and refund any prepaid time you cannot
        use. We may suspend an account at once for serious misuse, and will tell you why.
      </p>

      <h2>11. Changes to these terms</h2>
      <p>
        We will email you at least 30 days before a change that matters to you takes effect, and
        change the date above. If you do not agree, you can cancel before it applies.
      </p>

      <h2>12. Law and complaints</h2>
      <p>
        These terms are governed by the law of {legal.country}. If you are a consumer, you keep the
        protection of the law where you live. Talk to us first at <GeneralContact />. Consumers in
        Sweden can also bring a dispute to the National Board for Consumer Disputes (ARN),{' '}
        <a href="https://www.arn.se">arn.se</a>.
      </p>
    </LegalPage>
  );
}
