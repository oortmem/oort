import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd } from '@/components/docs/CodeBlock';
import { DocsPage } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { PlannedBadge } from '@/components/site/PlannedBadge';
import { docsGroups, docsHead, docsPages } from '@/lib/docs';

export const Route = createFileRoute('/docs/')({
  head: () => docsHead('/docs'),
  component: Page,
});

function Page() {
  return (
    <DocsPage
      to="/docs"
      lede={
        <p>
          Oort gives your agent a long-term memory that lives on your machine. Pick your agent
          below. Most guides are three steps.
        </p>
      }
    >
      <FlowDiagram
        title="How Oort connects"
        desc="Your agent starts the oort mcp server on your machine. The server reads and writes memories in the Oort store in your home folder."
        nodes={[
          { label: 'Your agent', sub: 'Claude Code, Cursor, ...' },
          { label: 'oort mcp', sub: 'local MCP server', tone: 'oort' },
          { label: 'Memory', sub: '~/.oort', tone: 'store' },
        ]}
        edges={['stdio', undefined]}
        machine={[0, 2]}
      />

      <h2>The short version</h2>
      <p>Install the CLI, then run setup. It finds your agents and connects them.</p>
      <Cmd>{'npm i -g oortmem\noort setup'}</Cmd>
      <p>
        You need Node.js 22.15 or newer. The package is <code>oortmem</code>, and the command it
        installs is <code>oort</code>.
      </p>

      {docsGroups
        .filter((g) => g !== 'Start')
        .map((group) => (
          <section key={group}>
            <h2 className="mt-14 text-2xl font-semibold text-foreground">{group}</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {docsPages
                .filter((p) => p.group === group)
                .map((p) => (
                  <li key={p.to}>
                    <Link
                      to={p.to as '/'}
                      className="plain block h-full rounded-xl border border-border bg-card/40 px-4 py-3 transition-colors hover:bg-card"
                    >
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        {p.nav}
                        {p.planned && <PlannedBadge />}
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {p.summary}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        ))}
    </DocsPage>
  );
}
