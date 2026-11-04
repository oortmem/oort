import { createFileRoute } from '@tanstack/react-router';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { BIN, HostGuide, KeysLine } from '@/components/docs/HostGuide';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/vscode')({
  head: () => docsHead('/docs/vscode'),
  component: Page,
});

function Page() {
  return (
    <DocsPage to="/docs/vscode" lede={<p>Add Oort to VS Code. Each workspace gets its own memories.</p>}>
      <HostGuide
        host="vscode"
        name="VS Code"
        restart="Reload the window: open the Command Palette and run Developer: Reload Window."
        check={
          <p>
            Open the Command Palette and run <strong>MCP: List Servers</strong>.{' '}
            <code>oort</code> should be in the list.
          </p>
        }
        file="mcp.json (your user settings)"
        entry={`{
  "servers": {
    "oort": {
      "type": "stdio",
      "command": "${BIN}",
      "args": ["mcp", "--project", "\${workspaceFolder}"]
    }
  }
}`}
      />

      <h2>Where the file is</h2>
      <DocsTable
        head={['System', 'File']}
        rows={[
          ['macOS', <code>~/Library/Application Support/Code/User/mcp.json</code>],
          ['Windows', <code>%APPDATA%\Code\User\mcp.json</code>],
          ['Linux', <code>~/.config/Code/User/mcp.json</code>],
        ]}
      />

      <h2>Profiles</h2>
      <p>
        <code>oort connect</code> edits the default profile. A named profile keeps its own{' '}
        <code>mcp.json</code>. In that profile, run <strong>MCP: Open User Configuration</strong>{' '}
        and paste the entry above.
      </p>

      <Note title="Keys">
        <KeysLine />
      </Note>
    </DocsPage>
  );
}
