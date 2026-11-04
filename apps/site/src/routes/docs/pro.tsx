import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Note, Step, Steps } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/pro')({
  head: () => docsHead('/docs/pro'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/pro"
      lede={
        <>
          <p>
            Oort Pro runs the models Oort needs for you. You need no Voyage AI, TypeSafe or
            Anthropic keys. Your memories stay on your machine.
          </p>
          <p className="mt-3 font-mono text-sm text-foreground">
            $19/month, VAT included where applicable.
          </p>
        </>
      }
    >
      <FlowDiagram
        title="Oort Pro and the relay"
        desc="Your agent talks to oort on your machine, where memories are stored. When oort needs a model, it sends the request to the Oort Pro relay at relay.oortcloud.dev. The relay swaps your Oort key for ours and forwards the request to Voyage AI, TypeSafe or Anthropic. It stores none of it."
        nodes={[
          { label: 'Your agent', sub: 'Claude Code, Cursor, ...' },
          { label: 'oort', sub: 'memories in ~/.oort', tone: 'oort' },
          { label: 'Oort Pro relay', sub: 'stores nothing', tone: 'remote' },
          { label: 'Model providers', sub: 'Voyage AI, TypeSafe\nand Anthropic', tone: 'remote' },
        ]}
        machine={[0, 1]}
      />

      <Steps>
        <Step title="Subscribe on the pricing page.">
          <p>
            Sign in, open <Link to="/pricing">Pricing</Link> and choose Get Pro. Stripe handles
            the payment.
          </p>
        </Step>
        <Step title="Install the CLI.">
          <Cmd>npm i -g oortmem</Cmd>
        </Step>
        <Step title="Sign in from your terminal.">
          <Cmd>oort login</Cmd>
          <p>
            Your browser opens oortcloud.dev. Check that the code on the page matches the code in
            your terminal, then choose Approve. Oort stores your Oort key in the Keychain.
          </p>
        </Step>
        <Step title="Restart your agents.">
          <p>The Oort server reads its keys when it starts, so restart each agent once.</p>
        </Step>
      </Steps>

      <p>
        Setting up for the first time? Run <code>oort setup</code> after signing in. It connects
        your agents. To sign this machine out, run <code>oort logout</code>.
      </p>

      <h2>What leaves your machine</h2>
      <ul>
        <li>
          <strong>Your memories stay on your computer.</strong> They live in <code>~/.oort</code>.
          Oort Pro does not copy them to us.
        </li>
        <li>
          <strong>To save a memory,</strong> Oort sends the text it is saving to TypeSafe (to
          decide whether and how to keep it), to Anthropic (Claude Haiku writes the short memory)
          and to Voyage AI (to turn it into a vector).
        </li>
        <li>
          <strong>To recall,</strong> it sends your search text to Voyage AI, then the search text
          with the candidate memories to rank them.
        </li>
        <li>
          <strong>The relay passes these requests on.</strong> It swaps your Oort key for ours and
          forwards them. It does not store or log what you send or what comes back. It keeps only
          the monthly counts and when each key was last used.
        </li>
      </ul>
      <p>
        Secrets are scrubbed before a turn is saved. More detail by mode is on{' '}
        <Link to="/docs/privacy">Privacy</Link>, and the legal text is the{' '}
        <Link to="/legal/privacy">privacy notice</Link>.
      </p>

      <h2>What is included</h2>
      <ul>
        <li>25,000 saves and 50,000 recalls a month. A recall is one search.</li>
        <li>Every Oort feature that uses a model: meaning-based recall, rerank and the writer.</li>
        <li>
          Cancel any time in one click: open <Link to="/account">Account</Link>, then Manage
          billing.
        </li>
      </ul>
      <p>
        The <Link to="/legal/terms-of-service">Oort Pro terms</Link> cover the 14-day right of
        withdrawal and refunds.
      </p>

      <Note title="Prefer your own accounts?">
        <p>
          You can skip Pro and use <Link to="/docs/own-keys">your own keys</Link>. Then requests go
          straight to each provider, and nothing reaches us.
        </p>
      </Note>
    </DocsPage>
  );
}
