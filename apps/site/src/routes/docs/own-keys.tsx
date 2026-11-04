import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Note, Step, Steps } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/own-keys')({
  head: () => docsHead('/docs/own-keys'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/own-keys"
      lede={
        <p>
          Use your own provider accounts. Oort sends each request straight from your machine to the
          provider, and nothing reaches us.
        </p>
      }
    >
      <FlowDiagram
        title="Your own keys"
        desc="Your keys stay in the macOS Keychain on your machine. Oort reads them and calls Voyage AI, TypeSafe and Anthropic directly, with no Oort server in between."
        nodes={[
          { label: 'Keychain', sub: 'your keys' },
          { label: 'oort', sub: 'memories in ~/.oort', tone: 'oort' },
          { label: 'Model providers', sub: 'called directly', tone: 'remote' },
        ]}
        machine={[0, 1]}
      />

      <h2>The three keys</h2>
      <DocsTable
        head={['Provider', 'Used for', 'Get a key']}
        rows={[
          [
            <>
              <strong>Voyage AI</strong>
              <br />
              <code>voyage</code>
            </>,
            'Finding memories by meaning, and ranking them.',
            <a href="https://docs.voyageai.com/docs/api-key-and-installation">
              docs.voyageai.com
            </a>,
          ],
          [
            <>
              <strong>TypeSafe</strong>
              <br />
              <code>typesafe</code>
            </>,
            'Deciding whether and how to keep a fact.',
            <a href="https://typesafe.ai">typesafe.ai</a>,
          ],
          [
            <>
              <strong>Anthropic</strong>
              <br />
              <code>anthropic</code>
            </>,
            'Writing the short memory (Claude Haiku).',
            <a href="https://platform.claude.com/settings/keys">platform.claude.com</a>,
          ],
        ]}
      />

      <h2>Store them</h2>
      <Steps>
        <Step title="Create a key at each provider.">
          <p>Use the links in the table above.</p>
        </Step>
        <Step title="Store the Voyage AI key.">
          <Cmd>oort keys set voyage</Cmd>
          <p>
            The macOS Keychain asks for the key and hides what you type. It never lands in your
            shell history.
          </p>
        </Step>
        <Step title="Store the TypeSafe key.">
          <Cmd>oort keys set typesafe</Cmd>
        </Step>
        <Step title="Store the Anthropic key.">
          <Cmd>oort keys set anthropic</Cmd>
        </Step>
        <Step title="Check all three.">
          <Cmd>oort keys list</Cmd>
          <p>
            This shows where each key comes from: <code>keychain</code>, <code>env</code> or{' '}
            <code>missing</code>. It never prints a key.
          </p>
        </Step>
        <Step title="Restart your agents.">
          <p>The Oort server reads its keys when it starts.</p>
        </Step>
      </Steps>

      <Note kind="warning" title="Do not export ANTHROPIC_API_KEY globally">
        <p>
          Claude Code reads <code>ANTHROPIC_API_KEY</code> too. If you use Claude Code on a
          subscription and export that variable in your shell profile, Claude Code bills the API
          instead of your subscription. Store the key with <code>oort keys set anthropic</code>{' '}
          and leave the variable unset.
        </p>
      </Note>

      <h2>Environment variables</h2>
      <p>
        Oort also reads <code>VOYAGE_API_KEY</code>, <code>TYPESAFE_API_KEY</code> and{' '}
        <code>ANTHROPIC_API_KEY</code>. A set variable wins over the Keychain. The Keychain is
        macOS only for now, so use these on other systems. Keep the Anthropic one out of your
        shell profile there too.
      </p>
      <p>
        To make Oort ignore the Keychain, set <code>OORT_NO_KEYCHAIN=1</code>.
      </p>

      <h2>Remove a key</h2>
      <Cmd>oort keys rm voyage</Cmd>

      <h2>Without keys</h2>
      <p>
        Recall still works, matching on words only. Saving new memories needs all three keys, or{' '}
        <Link to="/docs/pro">Oort Pro</Link>.
      </p>
    </DocsPage>
  );
}
