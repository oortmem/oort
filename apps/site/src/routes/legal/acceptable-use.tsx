import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

export const Route = createFileRoute('/legal/acceptable-use')({
  head: () => ({
    meta: [
      { title: 'Acceptable use (draft) | Oort Cloud' },
      {
        name: 'description',
        content: 'What you may and may not do with Oort, Oort Pro and the relay.',
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: Page,
});

function Page() {
  void legal;
  void Contact;
  return (
    <LegalPage title="Acceptable use">
      <p>
        This policy applies to the Oort website and its early-access form. Run by{' '}
        <strong>{legal.entity}</strong>. Report problems to <Contact />.
      </p>
      <h2>Please do not</h2>
      <ul>
        <li>Submit email addresses that are not yours, or use the form to send spam.</li>
        <li>Run automated scans, load tests or scraping that harm the site.</li>
        <li>Try to get around rate limits or access what you are not meant to.</li>
        <li>Use the site to break the law or harm others.</li>
      </ul>
      <h2>What happens</h2>
      <p>
        We may block traffic that breaks this policy. If you find a security problem, tell us at{' '}
        <Contact /> before making it public.
      </p>
      <h2>Hosted service</h2>
      <p>A fuller acceptable use policy for hosted Oort Cloud will be published before it opens.</p>
    </LegalPage>
  );
}
