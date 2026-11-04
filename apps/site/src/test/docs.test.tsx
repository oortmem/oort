import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docsPages } from '@/lib/docs';
import { routeTree } from '@/routeTree.gen';
import { SiteFooter, SiteNav } from '@/components/site/SiteNav';

type RouteModule = { Route: { options: { component?: unknown } } };

const modules = import.meta.glob<RouteModule>('../routes/docs/*.tsx', { eager: true });

/** `../routes/docs/index.tsx` is /docs, `../routes/docs/cursor.tsx` is /docs/cursor. */
const routes = Object.entries(modules).map(([file, mod]) => {
  const name = file
    .split('/')
    .at(-1)!
    .replace(/\.tsx$/, '');
  return { file, url: name === 'index' ? '/docs' : `/docs/${name}`, mod };
});

/** Renders one page component inside a throwaway router, so its links work. */
async function page(mod: RouteModule) {
  const Component = mod.Route.options.component as () => React.JSX.Element;
  const root = createRootRoute({ component: () => <Outlet /> });
  const index = createRoute({ getParentRoute: () => root, path: '/', component: Component });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const r = render(<RouterProvider router={router} />);
  await screen.findAllByRole('heading', { level: 1 });
  return r.container;
}

async function renderIn(node: React.JSX.Element) {
  const root = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const r = render(<RouterProvider router={router} />);
  await screen.findAllByRole('link');
  return r.container;
}

const EM_DASH = String.fromCharCode(0x2014);
const CLI_MD = readFileSync(join(import.meta.dirname, '../../../../docs/cli.md'), 'utf8');

/** Parents whose second word must be one cli.md names (`keys set`, `connect cursor`). */
const NESTED = ['keys', 'project', 'connect', 'disconnect', 'install', 'uninstall', 'import'];

const COMMAND = /(?:^|[\s`'"([$])oort[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/gm;

function commandsIn(text: string): [string, string | undefined][] {
  return [...text.matchAll(COMMAND)].map((m) => [m[1]!, m[2]]);
}

/** Every command docs/cli.md documents as built: inline code and code blocks, minus Planned. */
function cliCommands() {
  const built = CLI_MD.split('## Planned (not in this build)')[0]!;
  const fence = /```[a-z]*\n([\s\S]*?)```/g;
  const code = [
    ...[...built.matchAll(fence)].map((m) => m[1]!),
    ...[...built.replace(fence, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!),
  ].join('\n');
  const top = new Set<string>();
  const nested = new Map<string, Set<string>>();
  for (const [first, second] of commandsIn(code)) {
    top.add(first);
    if (second) nested.set(first, (nested.get(first) ?? new Set()).add(second));
  }
  // Hosts come from the `oort connect` table: `| \`cursor\` | \`~/.cursor/mcp.json\` | ...`.
  const connect = built.split('## `oort connect')[1]!.split('\n## ')[0]!;
  const hosts = [...connect.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]!);
  for (const parent of ['connect', 'disconnect']) {
    for (const h of hosts) nested.get(parent)!.add(h);
  }
  return { top, nested, hosts };
}

afterEach(() => cleanup());

describe('docs routes', () => {
  it('every page in the docs nav has a route file, and every route file is in the nav', () => {
    expect(routes.map((r) => r.url).sort()).toEqual(docsPages.map((p) => p.to).sort());
  });

  it('the app router matches every docs page', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    for (const p of docsPages) {
      const leaf = router.matchRoutes(p.to).at(-1)?.routeId ?? '';
      expect(leaf.replace(/\/$/, ''), p.to).toBe(p.to);
    }
  });

  it.each(routes.map((r) => [r.url, r] as const))('%s renders with its title', async (_, r) => {
    const container = await page(r.mod);
    const meta = docsPages.find((p) => p.to === r.url)!;
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(meta.title);
    expect(screen.getByRole('navigation', { name: 'Guides' })).toBeTruthy();
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it('every docs page has one illustration with a title and description', async () => {
    for (const r of routes) {
      const container = await page(r.mod);
      // Each diagram renders twice (wide and narrow); CSS shows one of them.
      const svgs = [...container.querySelectorAll('svg[role="img"]')];
      expect(svgs.length, r.url).toBeGreaterThan(0);
      for (const svg of svgs) {
        const labelled = svg.getAttribute('aria-labelledby')?.split(' ') ?? [];
        expect(svg.querySelector('title')?.id, r.url).toBe(labelled[0]);
        expect(svg.querySelector('desc')?.id, r.url).toBe(labelled[1]);
        expect(svg.querySelector('desc')?.textContent?.length, r.url).toBeGreaterThan(20);
      }
      cleanup();
    }
  });

  it('no docs source file contains an em dash', () => {
    const sources = import.meta.glob<string>(
      ['../routes/docs/*.tsx', '../components/docs/*.tsx', '../lib/docs.ts'],
      { eager: true, query: '?raw', import: 'default' },
    );
    expect(Object.keys(sources).length).toBeGreaterThan(routes.length);
    for (const [file, text] of Object.entries(sources)) {
      expect(text.includes(EM_DASH), file).toBe(false);
    }
  });
});

describe('docs commands', () => {
  it('parses the command list from docs/cli.md', () => {
    const { top, nested, hosts } = cliCommands();
    for (const c of ['setup', 'connect', 'mcp', 'recall', 'observe', 'keys', 'install']) {
      expect(top.has(c), c).toBe(true);
    }
    expect([...nested.get('keys')!].sort()).toEqual(['list', 'rm', 'set']);
    expect(hosts).toEqual(['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'vscode']);
  });

  it('every oort command shown in the docs exists in docs/cli.md', async () => {
    const { top, nested } = cliCommands();
    let seen = 0;
    for (const r of routes) {
      const container = await page(r.mod);
      const code = [...container.querySelectorAll('pre, code')].map((e) => e.textContent ?? '');
      for (const [first, second] of commandsIn(code.join('\n'))) {
        seen += 1;
        const shown = `oort ${first}${second ? ` ${second}` : ''} on ${r.url}`;
        expect(top.has(first), shown).toBe(true);
        if (NESTED.includes(first) && second) {
          expect(nested.get(first)?.has(second), shown).toBe(true);
        }
      }
      cleanup();
    }
    expect(seen).toBeGreaterThan(30);
  });

  it('every code block has a copy button that copies the code without the prompt', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const quick = routes.find((r) => r.url === '/docs/quickstart')!;
    await page(quick.mod);
    const blocks = screen.getAllByRole('figure');
    expect(blocks.length).toBeGreaterThan(2);
    for (const r of routes) {
      const container = await page(r.mod);
      for (const pre of container.querySelectorAll('pre')) {
        const figure = pre.closest('figure');
        expect(figure, `${r.url}: a pre outside a code figure`).not.toBeNull();
        expect(within(figure as HTMLElement).getByRole('button', { name: /copy/i })).toBeTruthy();
      }
      cleanup();
    }
    await page(quick.mod);
    const first = screen.getAllByRole('figure')[0]!;
    await act(async () => {
      fireEvent.click(within(first).getByRole('button', { name: /copy/i }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied.startsWith('$')).toBe(false);
    expect(first.querySelector('pre')?.textContent).toContain(copied);
    expect(within(first).getByRole('status').textContent).toMatch(/copied/i);
  });
});

describe('docs content', () => {
  const text = async (url: string) => {
    const r = routes.find((x) => x.url === url)!;
    return (await page(r.mod)).textContent ?? '';
  };

  it('the quickstart installs oortmem and runs setup', async () => {
    const t = await text('/docs/quickstart');
    expect(t).toContain('npm i -g oortmem');
    expect(t).toContain('npx oortmem setup');
    expect(t).toContain(
      'Under npx, setup first offers to install oortmem globally, so your agent configs point at a stable path.',
    );
    expect(t).toContain('oort setup');
  });

  it('Oort Pro has the price line, oort login and what leaves your machine', async () => {
    const t = await text('/docs/pro');
    expect(t).toContain('$19/month, VAT included where applicable');
    expect(t).toContain('oort login');
    expect(screen.getByRole('heading', { name: 'What leaves your machine' })).toBeTruthy();
    expect(t).toMatch(/does not store or log/);
  });

  it('bring your own keys warns against exporting ANTHROPIC_API_KEY globally', async () => {
    const t = await text('/docs/own-keys');
    expect(t).toContain('oort keys set anthropic');
    expect(t).toMatch(/Do not export ANTHROPIC_API_KEY/);
    for (const url of ['docs.voyageai.com', 'typesafe.ai', 'platform.claude.com']) {
      expect(t).toContain(url);
    }
  });

  it('ChatGPT and claude.ai are labelled Planned and link to the waitlist', async () => {
    const t = await text('/docs/chatgpt-and-claude-web');
    expect(t).toContain('Planned: needs Oort Cloud');
    expect(t).toMatch(/internet/);
    const join = screen.getByRole('link', { name: /waitlist/i });
    expect(join.getAttribute('href')).toBe('/#early-access');
  });

  it('the frameworks page covers four frameworks and your own code', async () => {
    await text('/docs/frameworks');
    for (const name of [
      'Vercel AI SDK',
      'LangGraph',
      'OpenAI Agents SDK',
      'Mastra',
      'Your own code',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
  });

  it('troubleshooting starts from oort doctor', async () => {
    const t = await text('/docs/troubleshooting');
    expect(t).toContain('oort doctor');
  });

  it('Cursor and VS Code pin the workspace folder as the project', async () => {
    for (const url of ['/docs/cursor', '/docs/vscode']) {
      expect(await text(url)).toContain('"--project", "${workspaceFolder}"');
      cleanup();
    }
  });
});

describe('docs in the site chrome', () => {
  it('the nav links to the docs', async () => {
    await renderIn(<SiteNav />);
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/docs');
  });

  it('the footer lists the guides', async () => {
    await renderIn(<SiteFooter />);
    expect(screen.getByRole('link', { name: 'Quickstart' }).getAttribute('href')).toBe(
      '/docs/quickstart',
    );
    expect(screen.getByRole('link', { name: 'Troubleshooting' }).getAttribute('href')).toBe(
      '/docs/troubleshooting',
    );
  });

  it('the home hero links to the setup guide', () => {
    const home = readFileSync(join(import.meta.dirname, '../routes/index.tsx'), 'utf8');
    expect(home).toMatch(/to="\/docs\/quickstart"[\s\S]{0,200}Read the setup guide/);
  });
});
