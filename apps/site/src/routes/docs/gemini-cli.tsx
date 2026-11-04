import { createFileRoute } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage } from '@/components/docs/DocsPage';
import { BIN, HostGuide, KeysLine } from '@/components/docs/HostGuide';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/gemini-cli')({
  head: () => docsHead('/docs/gemini-cli'),
  component: Page,
});

function Page() {
  return (
    <DocsPage to="/docs/gemini-cli" lede={<p>Add Oort to Gemini CLI.</p>}>
      <HostGuide
        host="gemini"
        name="Gemini CLI"
        restart="Exit Gemini CLI and start it again in your project."
        check={
          <>
            <Cmd caption="Gemini CLI" prompt=">">
              /mcp
            </Cmd>
            <p>
              You should see <code>oort</code> and its tools.
            </p>
          </>
        }
        file="~/.gemini/settings.json"
        entry={`{
  "mcpServers": {
    "oort": {
      "command": "${BIN}",
      "args": ["mcp"]
    }
  }
}`}
      />

      <h2>Which memories it sees</h2>
      <p>
        Gemini CLI starts the server in the folder you run it from, so memories follow your
        project.
      </p>

      <Note title="Keys">
        <KeysLine />
      </Note>
    </DocsPage>
  );
}
