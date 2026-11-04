import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Step, Steps } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/troubleshooting')({
  head: () => docsHead('/docs/troubleshooting'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/troubleshooting"
      lede={
        <p>
          Start with <code>oort doctor</code>. It checks your setup and prints a fix for each
          problem it finds.
        </p>
      }
    >
      <FlowDiagram
        title="oort doctor"
        desc="oort doctor checks your keys, hooks, connected agents, the memory store and the Oort Pro relay. For each failed check it prints the command that fixes it."
        nodes={[
          { label: 'oort doctor', sub: 'run it first', tone: 'oort' },
          { label: 'Checks', sub: 'keys, hooks, store, relay' },
          { label: 'Fixes', sub: 'one per failure', tone: 'store' },
        ]}
      />

      <Steps>
        <Step title="Run the checks.">
          <Cmd>oort doctor</Cmd>
          <p>
            It looks at your keys (only whether they are set, never their values), the Claude Code
            hooks, each connected agent, the memory store, and whether the Oort Pro relay answers.
          </p>
        </Step>
        <Step title="Run the fix it prints for each failure." />
        <Step title="Run oort doctor again until every check passes." />
      </Steps>

      <h2>Common fixes</h2>

      <h3>oort: command not found</h3>
      <Cmd>{'node --version\nnpm i -g oortmem'}</Cmd>
      <p>Oort needs Node.js 22.15 or newer. Then open a new terminal.</p>

      <h3>My agent does not list oort</h3>
      <p>
        Quit the agent fully and start it again. If it is still missing, connect it again. This is
        safe to repeat: it says "already connected" when nothing needs to change.
      </p>
      <Cmd>oort connect cursor</Cmd>
      <DocsTable
        head={['Agent', 'Where to look']}
        rows={[
          ['Claude Code, Gemini CLI', <code>/mcp</code>],
          ['Codex', <code>codex mcp list</code>],
          ['Cursor', 'Settings, then MCP'],
          ['VS Code', 'MCP: List Servers'],
        ]}
      />

      <h3>oort connect refuses to edit a file</h3>
      <p>
        Exit code 2 means Oort will not touch that file. Either the file is not valid JSON, or it
        already has an <code>oort</code> entry that you wrote yourself. Fix the JSON, or rename
        your entry, then connect again. Oort keeps the original file next to it, ending in{' '}
        <code>.oort-backup</code>, and the state before its last change in{' '}
        <code>.oort-prev</code>.
      </p>

      <h3>"lexical-only recall"</h3>
      <p>
        Oort has no keys, so it matches on words only and cannot save new memories. See which key
        is missing:
      </p>
      <Cmd>oort keys list</Cmd>
      <p>
        Then sign in with <code>oort login</code> (<Link to="/docs/pro">Oort Pro</Link>) or set{' '}
        <Link to="/docs/own-keys">your own keys</Link>, and restart your agents.
      </p>

      <h3>Claude Code started billing the API</h3>
      <p>
        <code>ANTHROPIC_API_KEY</code> is set in your shell. Remove it from your shell profile and
        store the key with <code>oort keys set anthropic</code> instead.
      </p>

      <h3>The wrong project's memories show up</h3>
      <p>
        The server uses the folder its agent starts it in. Pin a folder with{' '}
        <code>--project /path/to/repo</code> in the agent's <code>args</code>. If your repository
        names a project in <code>oort.config.json</code>, trust it once:
      </p>
      <Cmd>oort project link</Cmd>

      <h3>Setup fails in CI or a script</h3>
      <p>Without a terminal, setup asks nothing. Pass every answer as a flag:</p>
      <Cmd>oort setup --yes --agents claude-code --keys byo --import skip</Cmd>

      <h3>I need the full error</h3>
      <p>
        Add <code>--debug</code> to any command to print the stack trace.
      </p>

      <h2>Start over</h2>
      <Cmd>
        {
          'oort uninstall claude-code\noort disconnect cursor codex\noort keys rm voyage\n# deletes every memory\nrm -r ~/.oort'
        }
      </Cmd>
      <p>
        Still stuck? Open an issue on{' '}
        <a href="https://github.com/oortmem/oort/issues">GitHub</a>.
      </p>
    </DocsPage>
  );
}
