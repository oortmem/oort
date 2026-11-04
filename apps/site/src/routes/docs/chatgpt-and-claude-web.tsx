import { createFileRoute, Link } from '@tanstack/react-router';
import { DocsPage } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/chatgpt-and-claude-web')({
  head: () => docsHead('/docs/chatgpt-and-claude-web'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs/chatgpt-and-claude-web"
      lede={
        <p>
          <strong>Planned: needs Oort Cloud.</strong> Oort does not work in ChatGPT or in
          claude.ai on the web or on your phone yet.
        </p>
      }
    >
      <FlowDiagram
        title="Why ChatGPT and claude.ai cannot reach Oort today"
        desc="ChatGPT and claude.ai run on servers on the internet. Oort runs on your machine with no web address, so they cannot connect to it."
        nodes={[
          { label: 'ChatGPT, claude.ai', sub: 'run on the internet', tone: 'remote' },
          { label: 'oort mcp', sub: 'no web address', tone: 'oort' },
        ]}
        edges={['cannot reach']}
        blocked={[0]}
        machine={[1, 1]}
      />

      <h2>Why</h2>
      <p>
        ChatGPT and claude.ai do not run on your computer. They run on servers on the internet,
        even when you use them in a phone app. They can only use an MCP server that also lives on
        the internet, at a web address.
      </p>
      <p>
        Oort runs on your computer. Your agent starts it and talks to it directly, with no web
        address in between. That keeps your memories on your machine, and it also means a website
        cannot reach it.
      </p>

      <h2>What is planned</h2>
      <p>
        Oort Cloud will give you a web address for your memory that you can add to ChatGPT and
        claude.ai. It is not built yet. Join the waitlist and we will email you once it opens.
      </p>
      <p>
        <Link
          to="/"
          hash="early-access"
          className="plain inline-block rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          Join the Oort Cloud waitlist
        </Link>
      </p>

      <h2>What works today</h2>
      <ul>
        <li>
          <Link to="/docs/claude-desktop">Claude Desktop</Link>, the Claude app on your computer.
        </li>
        <li>
          <Link to="/docs/quickstart">Claude Code</Link>, <Link to="/docs/codex">Codex</Link>,{' '}
          <Link to="/docs/cursor">Cursor</Link>, <Link to="/docs/gemini-cli">Gemini CLI</Link> and{' '}
          <Link to="/docs/vscode">VS Code</Link>.
        </li>
        <li>
          <Link to="/docs/mcp-clients">Any MCP client</Link> that can start a local server.
        </li>
      </ul>

      <Note kind="planned" title="Oort Cloud">
        <p>Hosted memory with a web address is a later phase. Nothing on this page works yet.</p>
      </Note>
    </DocsPage>
  );
}
