import { createFileRoute } from '@tanstack/react-router';
import { Code } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { BIN, HostGuide, KeysLine } from '@/components/docs/HostGuide';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/claude-desktop')({
  head: () => docsHead('/docs/claude-desktop'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/claude-desktop"
      lede={<p>Add Oort to the Claude app on your Mac, Windows or Linux computer.</p>}
    >
      <HostGuide
        host="claude-desktop"
        name="Claude Desktop"
        restart="Quit Claude Desktop fully, then open it again. Closing the window is not enough."
        check={
          <p>
            Start a new chat and ask: "What do you remember about me?" Claude can now call
            Oort's <code>recall</code> tool. Allow it when Claude asks.
          </p>
        }
        file="claude_desktop_config.json"
        entry={`{
  "mcpServers": {
    "oort": {
      "command": "${BIN}",
      "args": ["mcp"]
    }
  }
}`}
      />

      <h2>Where the file is</h2>
      <DocsTable
        head={['System', 'File']}
        rows={[
          ['macOS', <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>],
          ['Windows', <code>%APPDATA%\Claude\claude_desktop_config.json</code>],
          ['Linux', <code>~/.config/Claude/claude_desktop_config.json</code>],
        ]}
      />

      <h2>Which memories it sees</h2>
      <p>
        Claude Desktop does not start servers inside a project, so it usually sees your global
        memories. To give it one project, add that folder to <code>args</code>:
      </p>
      <Code caption="claude_desktop_config.json">{`"args": ["mcp", "--project", "/path/to/repo"]`}</Code>
      <p>
        Oort treats an entry you edit as yours from then on. <code>oort connect</code> and{' '}
        <code>oort disconnect</code> leave it alone.
      </p>

      <Note title="Keys">
        <KeysLine />
      </Note>
    </DocsPage>
  );
}
