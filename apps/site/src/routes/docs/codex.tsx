import { createFileRoute } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage } from '@/components/docs/DocsPage';
import { BIN, HostGuide, KeysLine } from '@/components/docs/HostGuide';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/codex')({
  head: () => docsHead('/docs/codex'),
  component: Page,
});

function Page() {
  return (
    <DocsPage to="/docs/codex" lede={<p>Add Oort to the Codex CLI and the Codex IDE extension.</p>}>
      <HostGuide
        host="codex"
        name="Codex"
        restart="Close Codex and start it again in your project."
        check={
          <>
            <Cmd>codex mcp list</Cmd>
            <p>
              You should see <code>oort</code> in the list.
            </p>
          </>
        }
        file="~/.codex/config.toml"
        entry={`[mcp_servers.oort]
command = "${BIN}"
args = ["mcp"]`}
      />

      <h2>Notes</h2>
      <ul>
        <li>
          If you set <code>CODEX_HOME</code>, Oort writes <code>$CODEX_HOME/config.toml</code>{' '}
          instead.
        </li>
        <li>
          Oort replaces only the <code>[mcp_servers.oort]</code> block and checks that every
          other table is unchanged.
        </li>
        <li>
          Codex starts the server in the folder you run it from, so memories follow your project.
        </li>
      </ul>

      <Note title="Keys">
        <KeysLine />
      </Note>
    </DocsPage>
  );
}
