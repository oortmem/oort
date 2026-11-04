import { createFileRoute } from '@tanstack/react-router';
import { DocsPage } from '@/components/docs/DocsPage';
import { BIN, HostGuide, KeysLine } from '@/components/docs/HostGuide';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/cursor')({
  head: () => docsHead('/docs/cursor'),
  component: Page,
});

function Page() {
  return (
    <DocsPage to="/docs/cursor" lede={<p>Add Oort to Cursor. Each workspace gets its own memories.</p>}>
      <HostGuide
        host="cursor"
        name="Cursor"
        restart="Quit Cursor, then open your project again."
        check={
          <p>
            Open Settings, then MCP. <code>oort</code> should be listed with its tools.
          </p>
        }
        file="~/.cursor/mcp.json"
        entry={`{
  "mcpServers": {
    "oort": {
      "type": "stdio",
      "command": "${BIN}",
      "args": ["mcp", "--project", "\${workspaceFolder}"]
    }
  }
}`}
      />

      <h2>Which memories it sees</h2>
      <p>
        Cursor fills in <code>{'${workspaceFolder}'}</code> with the folder you have open. Oort
        then uses that project's memories, plus your global ones.
      </p>

      <Note title="Keys">
        <KeysLine />
      </Note>
    </DocsPage>
  );
}
