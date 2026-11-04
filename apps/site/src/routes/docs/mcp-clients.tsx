import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd, Code } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Note, Step, Steps } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/mcp-clients')({
  head: () => docsHead('/docs/mcp-clients'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/mcp-clients"
      lede={
        <p>
          Any app that can start a local (stdio) MCP server can use Oort. You give it one command
          and one argument.
        </p>
      }
    >
      <FlowDiagram
        title="Any MCP client with Oort"
        desc="Your MCP client starts the command oort with the argument mcp. They talk over stdin and stdout on your machine, and memories stay in ~/.oort."
        nodes={[
          { label: 'Your MCP client', sub: 'starts the command' },
          { label: 'oort mcp', sub: 'stdin and stdout', tone: 'oort' },
          { label: 'Memory', sub: '~/.oort', tone: 'store' },
        ]}
        edges={['stdio', undefined]}
        machine={[0, 2]}
      />

      <Steps>
        <Step title="Install the CLI.">
          <Cmd>npm i -g oortmem</Cmd>
        </Step>
        <Step title="Find the full path of oort.">
          <Cmd>{'realpath "$(command -v oort)"'}</Cmd>
          <p>
            Use the full path, because many apps start servers without your shell's PATH. On
            Linux, <code>readlink -f</code> works too.
          </p>
        </Step>
        <Step title="Add this server to your client's config.">
          <Code caption="mcp config (JSON)">{`{
  "mcpServers": {
    "oort": {
      "command": "/abs/path/to/oort",
      "args": ["mcp"]
    }
  }
}`}</Code>
          <p>
            Paste the path from step 2 as <code>command</code>. Some clients name the top key{' '}
            <code>servers</code>, or want <code>"type": "stdio"</code> as well. Check your
            client's docs for its exact shape.
          </p>
        </Step>
        <Step title="Restart the client." />
      </Steps>

      <h2>Pin a project</h2>
      <p>
        The server uses the project of the folder it starts in, plus global memories. To choose a
        project yourself, add it to <code>args</code>:
      </p>
      <Code caption="args">{`"args": ["mcp", "--project", "/path/to/repo"]`}</Code>

      <h2>The tools</h2>
      <DocsTable
        head={['Tool', 'What it does']}
        rows={[
          [<code>recall</code>, 'Finds current facts for a question, with why each was picked.'],
          [<code>remember</code>, 'Saves one to five short facts the user stated or confirmed.'],
          [<code>forget</code>, 'Deletes one memory, permanently.'],
          [<code>pin</code>, 'Keeps a memory out of cold storage.'],
          [<code>explain</code>, 'Shows one memory, its decisions and what it replaced.'],
          [<code>list_recent</code>, 'Lists memories by when they changed, newest first.'],
          [<code>whoami</code>, 'Shows the mode, the project and the version. No account or email.'],
        ]}
      />
      <p>
        The server can never read another project's memories. No tool argument can change the
        scope. The full reference is in{' '}
        <a href="https://github.com/oortmem/oort/blob/main/docs/cli.md">docs/cli.md</a>.
      </p>

      <Note title="Web and mobile chat apps">
        <p>
          ChatGPT and claude.ai cannot start a server on your computer.{' '}
          <Link to="/docs/chatgpt-and-claude-web">Here is why, and what is planned.</Link>
        </p>
      </Note>
    </DocsPage>
  );
}
