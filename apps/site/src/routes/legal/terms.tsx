import { createFileRoute } from '@tanstack/react-router';
import { LegalPage, Contact, GeneralContact, VatLine } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

export const Route = createFileRoute('/legal/terms')({
  head: () => ({
    meta: [
      { title: 'Terms of use (draft) | Oort Cloud' },
      {
        name: 'description',
        content: 'The terms for using oortcloud.dev and the open-source Oort software.',
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <LegalPage title="Terms of use">
      <p>
        These terms cover your use of the Oort website, run by <strong>{legal.entity}</strong>,{' '}
        {legal.address}, {legal.country}. Questions: <GeneralContact />. Privacy and data requests:{' '}
        <Contact />.
      </p>
      <VatLine />
      <h2>The site</h2>
      <p>
        The site describes Oort, an open-source agent memory engine, and is where you manage an Oort
        account. The console demo uses sample data. Features marked Planned or Concept are not built
        yet. The Oort Pro price is set out in the Oort Pro terms. Prices shown for hosted Oort
        Cloud, which is Planned, are a proposal and may change.
      </p>
      <h2>Open source software</h2>
      <p>
        The Oort code is licensed under Apache 2.0 in its repository. That license, not these terms,
        governs the code.
      </p>
      <h2>Your use of the site</h2>
      <p>
        Use the site lawfully and follow the{' '}
        <a href="/legal/acceptable-use">acceptable use policy</a>. Do not try to break, overload or
        probe it.
      </p>
      <h2>No warranty</h2>
      <p>
        The site and demos are provided as they are. To the extent the law allows, we are not liable
        for loss from using them. Nothing here limits liability that cannot be limited by law.
      </p>
      <h2>Changes and law</h2>
      <p>
        We may update these terms and will change the date above. They are governed by the law of{' '}
        {legal.country}.
      </p>
      <h2>Oort Pro and hosted Oort Cloud</h2>
      <p>
        Oort Pro, the paid subscription, has its own{' '}
        <a href="/legal/terms-of-service">Oort Pro terms of service</a>, which apply when you
        subscribe. Terms and a data processing agreement for hosted Oort Cloud will be published
        before it opens. Neither is part of these terms.
      </p>
    </LegalPage>
  );
}
