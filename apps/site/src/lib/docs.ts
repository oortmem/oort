/** The setup guides under /docs, in sidebar order. One entry per route file in routes/docs. */
export interface DocsPageMeta {
  to: string;
  title: string;
  /** Shorter name for the sidebar and footer. */
  nav: string;
  group: DocsGroup;
  summary: string;
  planned?: boolean;
}

export type DocsGroup = 'Start' | 'Agents' | 'Build' | 'Keys and privacy' | 'Help';

export const docsGroups: DocsGroup[] = ['Start', 'Agents', 'Build', 'Keys and privacy', 'Help'];

export const docsPages: DocsPageMeta[] = [
  {
    to: '/docs',
    title: 'Setup guides',
    nav: 'Overview',
    group: 'Start',
    summary: 'Pick your agent and get memory working.',
  },
  {
    to: '/docs/quickstart',
    title: 'Quickstart: Claude Code in 2 minutes',
    nav: 'Quickstart',
    group: 'Start',
    summary: 'Install the CLI, run setup, restart Claude Code.',
  },
  {
    to: '/docs/claude-desktop',
    title: 'Claude Desktop',
    nav: 'Claude Desktop',
    group: 'Agents',
    summary: 'Add Oort to the Claude app on your computer.',
  },
  {
    to: '/docs/codex',
    title: 'Codex',
    nav: 'Codex',
    group: 'Agents',
    summary: 'Add Oort to the Codex CLI and IDE extension.',
  },
  {
    to: '/docs/cursor',
    title: 'Cursor',
    nav: 'Cursor',
    group: 'Agents',
    summary: 'Add Oort to Cursor, scoped to each workspace.',
  },
  {
    to: '/docs/gemini-cli',
    title: 'Gemini CLI',
    nav: 'Gemini CLI',
    group: 'Agents',
    summary: 'Add Oort to Gemini CLI.',
  },
  {
    to: '/docs/vscode',
    title: 'VS Code',
    nav: 'VS Code',
    group: 'Agents',
    summary: 'Add Oort to VS Code, scoped to each workspace.',
  },
  {
    to: '/docs/mcp-clients',
    title: 'Any MCP client',
    nav: 'Any MCP client',
    group: 'Agents',
    summary: 'A stdio config any MCP host can run.',
  },
  {
    to: '/docs/chatgpt-and-claude-web',
    title: 'ChatGPT and claude.ai',
    nav: 'ChatGPT and claude.ai',
    group: 'Agents',
    summary: 'Web and mobile chat apps need Oort Cloud.',
    planned: true,
  },
  {
    to: '/docs/frameworks',
    title: 'Any agent framework',
    nav: 'Agent frameworks',
    group: 'Build',
    summary: 'Vercel AI SDK, LangGraph, OpenAI Agents SDK, Mastra and your own code.',
  },
  {
    to: '/docs/pro',
    title: 'Oort Pro',
    nav: 'Oort Pro',
    group: 'Keys and privacy',
    summary: 'No API keys. Sign in once with oort login.',
  },
  {
    to: '/docs/own-keys',
    title: 'Bring your own keys',
    nav: 'Bring your own keys',
    group: 'Keys and privacy',
    summary: 'Use your own Voyage AI, TypeSafe and Anthropic keys.',
  },
  {
    to: '/docs/privacy',
    title: 'Privacy: what leaves your machine',
    nav: 'Privacy',
    group: 'Keys and privacy',
    summary: 'What is sent where, for each mode.',
  },
  {
    to: '/docs/troubleshooting',
    title: 'Troubleshooting',
    nav: 'Troubleshooting',
    group: 'Help',
    summary: 'Run oort doctor, then the common fixes.',
  },
];

export function docsMeta(to: string): DocsPageMeta {
  const meta = docsPages.find((p) => p.to === to);
  if (!meta) throw new Error(`No docs page ${to}`);
  return meta;
}

/** The page title in the browser tab. */
export function docsHead(to: string) {
  const meta = docsMeta(to);
  return {
    meta: [{ title: `${meta.title} | Oort docs` }, { name: 'description', content: meta.summary }],
  };
}
