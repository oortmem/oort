import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Note, Step, Steps } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/quickstart')({
  head: () => docsHead('/docs/quickstart'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/quickstart"
      lede={
        <p>
          Give Claude Code a memory that stays on your machine. You need Node.js 22.15 or newer
          and Claude Code.
        </p>
      }
    >
      <FlowDiagram
        title="Claude Code with Oort"
        desc="Claude Code runs Oort's hooks and starts the oort mcp server on your machine. Both read and write memories in ~/.oort, also on your machine."
        nodes={[
          { label: 'Claude Code', sub: 'hooks and MCP' },
          { label: 'oort', sub: 'on your machine', tone: 'oort' },
          { label: 'Memory', sub: '~/.oort', tone: 'store' },
        ]}
        machine={[0, 2]}
      />

      <Steps>
        <Step title="Install the CLI.">
          <Cmd>npm i -g oortmem</Cmd>
          <p>
            This installs the <code>oort</code> command.
          </p>
        </Step>
        <Step title="Run setup.">
          <Cmd>oort setup</Cmd>
          <p>
            Setup finds Claude Code and asks how to pay for the models Oort uses. Pick{' '}
            <Link to="/docs/pro">Oort Pro</Link>, <Link to="/docs/own-keys">your own keys</Link>,
            or skip for now. It shows every change before it writes it, and every step can be
            skipped.
          </p>
        </Step>
        <Step title="Restart Claude Code in your project.">
          <Cmd caption="Claude Code" prompt=">">/mcp</Cmd>
          <p>
            Type <code>/mcp</code> in Claude Code. You should see <code>oort</code> in the list.
          </p>
        </Step>
        <Step title="Tell Claude something worth keeping.">
          <p>
            For example: "We deploy from the main branch with wrangler." Start a new session
            tomorrow and ask how you deploy. Oort recalls it.
          </p>
        </Step>
      </Steps>

      <p>Prefer one line? This runs the same wizard:</p>
      <Cmd>npx oortmem setup</Cmd>
      <p>
        Under npx, setup first offers to install <code>oortmem</code> globally, so your agent
        configs point at a stable path.
      </p>

      <h2>What setup changed</h2>
      <p>Setup lists every change at the end, with the command that undoes it.</p>
      <DocsTable
        head={['Change', 'Undo']}
        rows={[
          [
            <>
              Hooks in <code>~/.claude/settings.json</code>
            </>,
            <code>oort uninstall claude-code</code>,
          ],
          [
            <>
              The <code>oort</code> MCP server for Claude Code
            </>,
            <code>oort disconnect claude-code</code>,
          ],
          [<>A key in the Keychain</>, <code>oort keys rm voyage</code>],
        ]}
      />
      <p>
        The hooks recall memories before each prompt and save what matters after each reply. The
        MCP server gives Claude the <code>recall</code>, <code>remember</code> and{' '}
        <code>forget</code> tools as well. When the <code>claude</code> command is on your PATH,
        Oort adds the server with <code>claude mcp add --scope user</code>. Otherwise it edits{' '}
        <code>~/.claude.json</code>.
      </p>

      <h2>Set it up by hand</h2>
      <p>The same two pieces, without the wizard:</p>
      <Cmd>
        {
          '# recall before each prompt, save after each reply\noort install claude-code\n# the recall, remember and forget tools\noort connect claude-code'
        }
      </Cmd>

      <h2>Bring in past sessions</h2>
      <Cmd>oort import claude-code --since 14d</Cmd>
      <p>
        This reads your Claude Code transcripts from the last 14 days. It prints an estimate
        first, then asks before it writes anything.
      </p>

      <Note title="Memory follows the project">
        <p>
          Claude Code starts Oort in your project folder. Each project gets its own memories,
          plus global ones that apply everywhere.
        </p>
      </Note>
    </DocsPage>
  );
}
