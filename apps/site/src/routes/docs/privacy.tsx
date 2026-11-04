import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/privacy')({
  head: () => docsHead('/docs/privacy'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/privacy"
      lede={
        <p>
          Your memories always stay on your machine. What else leaves it depends on which mode you
          use.
        </p>
      }
    >
      <FlowDiagram
        title="What stays and what leaves"
        desc="Your agent and oort run on your machine, and memories are stored there. Only the text a model needs leaves, and only with keys or Oort Pro: straight to the providers with your own keys, or through the Oort Pro relay."
        nodes={[
          { label: 'Your agent', sub: 'on your machine' },
          { label: 'oort', sub: 'memories stay here', tone: 'oort' },
          { label: 'Model providers', sub: 'only with keys or Pro', tone: 'remote' },
        ]}
        machine={[0, 1]}
      />

      <h2>By mode</h2>
      <DocsTable
        head={['Mode', 'What leaves your machine', 'Who sees it']}
        rows={[
          [
            <strong>No keys</strong>,
            'Nothing. Recall matches on words only, and new memories are not saved.',
            'No one.',
          ],
          [
            <Link to="/docs/own-keys">
              <strong>Your own keys</strong>
            </Link>,
            'The text a model needs to save or recall a memory.',
            'Voyage AI, TypeSafe and Anthropic, under your accounts. Nothing reaches us.',
          ],
          [
            <Link to="/docs/pro">
              <strong>Oort Pro</strong>
            </Link>,
            'The same text, through relay.oortcloud.dev.',
            'The same providers. Our relay passes requests on and stores none of their content.',
          ],
        ]}
      />

      <h2>What each provider gets</h2>
      <DocsTable
        head={['Provider', 'Gets', 'When']}
        rows={[
          [
            'TypeSafe',
            'The text Oort is about to save.',
            'To decide whether and how to keep it.',
          ],
          ['Anthropic', 'The same text.', 'So Claude Haiku can write the short memory.'],
          [
            'Voyage AI',
            'The memory text. On recall, your search text and the candidate memories.',
            'To turn text into vectors, and to rank results.',
          ],
        ]}
      />
      <p>
        Secrets are scrubbed before a turn is saved. A turn that is only a secret is skipped. To
        see what the scrubber would remove, without saving anything:
      </p>
      <Cmd>{'oort observe --dry-run --user "my key is ..." --assistant "ok"'}</Cmd>

      <h2>Oort Pro</h2>
      <ul>
        <li>
          The relay swaps your Oort key for ours and forwards the request. It does not store or
          log what you send or what comes back.
        </li>
        <li>It keeps only monthly counts of saves and recalls, and when each key was last used.</li>
        <li>
          Your account and billing live with Clerk and Stripe. The{' '}
          <Link to="/legal/privacy">privacy notice</Link> lists every subprocessor.
        </li>
      </ul>

      <h2>Importing past sessions</h2>
      <p>
        <code>oort import claude-code</code> sends past turns through the same path as new ones. It
        prints an estimate first and asks before it starts.
      </p>

      <h2>Your memories, your control</h2>
      <Cmd>
        {
          '# every memory, as JSON Lines\noort export --out memories.jsonl\n# delete one memory everywhere\noort forget <id>\n# delete every memory\nrm -r ~/.oort'
        }
      </Cmd>
      <p>
        Hosted memory in Oort Cloud is <PlannedBadge />. Nothing on this page sends memories to
        us.
      </p>
    </DocsPage>
  );
}
