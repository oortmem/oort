import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  getUiCapability,
} from '@modelcontextprotocol/ext-apps/server';
import { InMemoryTransport, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_NAMES,
  TOOL_WIDGETS,
  UI_EXTENSION_ID,
  UI_MIME_TYPE,
  WIDGETS,
  createMcpServer,
  uiSupport,
  type MemoryBackend,
} from './index.js';
import { widgetHtml, type WidgetName } from './ui.js';

// A memory text no log line may ever carry.
const SECRET_TEXT = 'the vault combination is orbit-7731';

const recallOut = {
  memories: [
    {
      id: 'mem_01hx7a9k2c',
      text: SECRET_TEXT,
      type: 'semantic',
      tier: 'hot',
      valid_from: '2026-10-02T09:00:00.000Z',
      why: 'lexical #1, dense #2, rerank 0.91',
    },
    {
      id: 'mem_01hx7a9k2d',
      text: 'Deploys went through the old pipeline <img src=x onerror="alert(1)">',
      type: 'episodic',
      tier: 'cold',
      valid_from: '2026-03-01T00:00:00.000Z',
      valid_to: '2026-09-30T00:00:00.000Z',
      stale: true as const,
      why: 'dense #4',
    },
  ],
  mode: 'current',
};

const explainOut = {
  memory: {
    id: 'mem_01hx7a9k2c',
    text: SECRET_TEXT,
    type: 'semantic',
    tier: 'warm',
    pinned: true,
    status: 'current',
    valid_from: '2026-10-02T09:00:00.000Z',
    valid_to: null,
    salience: 0.8,
    activation: 1.2,
    source: 'claude-code',
    created_at: '2026-10-02T09:00:00.000Z',
  },
  decisions: [{ stage: 'gate', question: 'store?', answer: 'yes', probability: 0.93 }],
  chain: [
    {
      id: 'mem_01hx70000a',
      text: 'the vault combination was orbit-1111',
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_to: '2026-10-02T09:00:00.000Z',
      end_reason: 'superseded',
    },
  ],
};

function backend(): MemoryBackend {
  return {
    recall: async () => recallOut,
    remember: async () => ({
      results: [
        { fact: 0, outcome: 'added', id: 'mem_new0001' },
        { fact: 1, outcome: 'skipped', reason: 'not durable' },
      ],
    }),
    forget: async () => ({ forgotten: 'm1' }),
    pin: async () => ({ id: 'm1', pinned: true, changed: true }),
    explain: async () => explainOut,
    listRecent: async () => ({ memories: [] }),
    whoami: async () => ({ mode: 'test' }),
  };
}

const UI_CAPS = { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } };

/**
 * How a host reaches the server, and so what the server knows of its capabilities:
 * - `stdio`: a 2025-era session (`oort mcp` in a desktop host); `initialize` declares them.
 * - `http-modern`: 2026-07-28 requests on per-request servers (the remote connector); every
 *   request carries them.
 * - `http-legacy`: 2025-era stateless requests on per-request servers; none carry them.
 */
type Route = 'stdio' | 'http-modern' | 'http-legacy';
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of open.splice(0)) await close();
});

async function connect(route: Route, capabilities: Record<string, unknown>, widgets?: boolean) {
  const factory = () =>
    createMcpServer({ backend: backend(), ...(widgets !== undefined && { widgets }) });
  const client = new Client(
    { name: 'ui-test', version: '0.0.0' },
    {
      capabilities,
      ...(route === 'http-modern' && { versionNegotiation: { mode: { pin: '2026-07-28' } } }),
    },
  );
  if (route === 'stdio') {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(factory, { transport: serverSide });
    await client.connect(clientSide);
    open.push(async () => {
      await client.close();
      await handle.close();
    });
  } else {
    const handler = createMcpHandler(factory);
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    open.push(() => client.close());
  }
  return client;
}

const linked = (tools: { name: string; _meta?: Record<string, unknown> }[]) =>
  Object.fromEntries(
    tools
      .filter((t) => t._meta?.['ui'] !== undefined)
      .map((t) => [t.name, (t._meta?.['ui'] as { resourceUri?: string } | undefined)?.resourceUri]),
  );

describe('@oortmem/mcp widgets: the spec constants', () => {
  it('ui.constants-match-ext-apps', () => {
    expect(UI_EXTENSION_ID).toBe(EXTENSION_ID);
    expect(UI_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
    for (const caps of [UI_CAPS, {}, { extensions: { [UI_EXTENSION_ID]: {} } }]) {
      const theirs = getUiCapability(caps as never)?.mimeTypes?.includes(RESOURCE_MIME_TYPE);
      expect(uiSupport(caps)).toBe(theirs === true ? 'yes' : 'no');
    }
    expect(uiSupport(undefined)).toBe('unknown');
  });
});

describe.each<Route>(['stdio', 'http-modern', 'http-legacy'])(
  '@oortmem/mcp widgets (%s)',
  (route) => {
    it('ui.hosts-that-render-mcp-apps-get-the-widget-links-and-resources', async () => {
      const client = await connect(route, UI_CAPS);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      expect(linked(tools)).toEqual({
        recall: WIDGETS.recall.uri,
        remember: WIDGETS.memory.uri,
        explain: WIDGETS.memory.uri,
      });
      const recall = tools.find((t) => t.name === 'recall');
      expect(recall?._meta?.['ui/resourceUri']).toBe(WIDGETS.recall.uri);

      const { resources } = await client.listResources();
      expect(resources.map((r) => [r.uri, r.mimeType]).sort()).toEqual(
        [
          [WIDGETS.memory.uri, UI_MIME_TYPE],
          [WIDGETS.recall.uri, UI_MIME_TYPE],
        ].sort(),
      );
      for (const w of Object.values(WIDGETS)) {
        const read = await client.readResource({ uri: w.uri });
        const c = read.contents[0] as { mimeType?: string; text?: string; _meta?: unknown };
        expect(c.mimeType).toBe(UI_MIME_TYPE);
        expect(c.text).toMatch(/^<!doctype html>/);
        expect(c._meta).toEqual({
          ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
        });
      }
    });

    it.skipIf(route === 'http-legacy')('ui.hosts-without-mcp-apps-get-no-widgets', async () => {
      const client = await connect(route, {});
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      expect(tools.every((t) => t._meta === undefined)).toBe(true);
      const { resources } = await client.listResources();
      expect(resources).toEqual([]);
    });

    it('ui.tool-results-are-the-same-text-with-or-without-widgets', async () => {
      const withUi = await connect(route, UI_CAPS);
      const without = await connect(route, {});
      const calls = [
        { name: 'recall', arguments: { query: 'vault' } },
        { name: 'explain', arguments: { id: 'mem_01hx7a9k2c' } },
        { name: 'remember', arguments: { facts: ['a fact', 'hi'] } },
      ];
      for (const call of calls) {
        const a = await withUi.callTool(call);
        const b = await without.callTool(call);
        expect(a.content, call.name).toEqual(b.content);
        expect(a.structuredContent, call.name).toBeUndefined();
        expect(a.isError, call.name).toBeFalsy();
        expect(() => JSON.parse((a.content as { text: string }[])[0]?.text ?? '')).not.toThrow();
      }
    });
  },
);

describe('@oortmem/mcp widgets: serving', () => {
  it('ui.widgets-false-turns-them-off', async () => {
    const client = await connect('stdio', UI_CAPS, false);
    const { tools } = await client.listTools();
    expect(linked(tools)).toEqual({});
    const listed = await client.listResources().catch(() => ({ resources: [] }));
    expect(listed.resources).toEqual([]);
  });

  it('ui.a-stateless-request-without-capabilities-still-offers-the-widgets', async () => {
    // A 2025-era HTTP request on a per-request server: `initialize` went to another instance,
    // so the capabilities are unknown. `_meta` is ignored by hosts that don't know it.
    const handler = createMcpHandler(() => createMcpServer({ backend: backend() }));
    const res = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    const body = await res.text();
    const json = body.startsWith('{')
      ? JSON.parse(body)
      : JSON.parse(
          body
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6) ?? '{}',
        );
    expect(res.status).toBe(200);
    expect(linked(json.result.tools)).toEqual({
      recall: WIDGETS.recall.uri,
      remember: WIDGETS.memory.uri,
      explain: WIDGETS.memory.uri,
    });
  });

  it('ui.memory-text-never-reaches-the-logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const client = await connect('http-modern', UI_CAPS);
    await client.callTool({ name: 'recall', arguments: { query: 'vault' } });
    await client.callTool({ name: 'explain', arguments: { id: 'mem_01hx7a9k2c' } });
    await client.callTool({ name: 'remember', arguments: { facts: [SECRET_TEXT] } });
    for (const w of Object.values(WIDGETS)) await client.readResource({ uri: w.uri });
    const logged = [...spies, out, err].flatMap((s) => s.mock.calls).map((c) => String(c));
    expect(logged.filter((l) => l.includes('orbit-7731'))).toEqual([]);
  });
});

describe('@oortmem/mcp widgets: the HTML', () => {
  const pkg = join(import.meta.dirname, '..');
  const own = ['widget.css', 'common.js', 'recall.js', 'memory.js'].map((f) =>
    readFileSync(join(pkg, 'widgets', f), 'utf8'),
  );

  it('ui.widgets-load-nothing-from-the-network', async () => {
    for (const name of Object.keys(WIDGETS) as WidgetName[]) {
      const html = await widgetHtml(name);
      expect(html, name).not.toMatch(/<script[^>]+src=/i);
      expect(html, name).not.toMatch(/<link\b/i);
      expect(html, name).not.toMatch(/<iframe\b/i);
      // One inline module script: the runtime and the widget code, nothing else.
      expect(html.match(/<script\b/gi)?.length, name).toBe(1);
    }
    for (const src of own) {
      expect(src).not.toMatch(/@import|url\(/);
      expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(src).not.toMatch(/\beval\(|new Function/);
      expect(src).not.toMatch(/console\./);
      // The only URL is the SVG namespace, which is a name, not a fetch.
      expect(src.match(/https?:\/\/[^\s'"]+/g) ?? []).toEqual(
        src.includes('createElementNS') ? ['http://www.w3.org/2000/svg'] : [],
      );
    }
  });

  it('ui.each-widget-stays-under-150-kb-gzipped', async () => {
    for (const name of Object.keys(WIDGETS) as WidgetName[]) {
      expect(gzipSync(await widgetHtml(name)).length, name).toBeLessThan(150_000);
    }
  });

  it('ui.every-widget-tool-points-at-a-registered-widget', () => {
    for (const [tool, name] of Object.entries(TOOL_WIDGETS)) {
      expect(TOOL_NAMES as readonly string[]).toContain(tool);
      expect(Object.keys(WIDGETS)).toContain(name);
    }
  });
});

/**
 * A stand-in for the ext-apps runtime: the test plays the host, calling the handlers the widget
 * set on its App. jsdom runs no module scripts, so the one script runs as a classic script.
 */
const FAKE_RUNTIME = `globalThis.ExtApps = {
  applyDocumentTheme: (t) => document.documentElement.setAttribute('data-theme', t),
  applyHostStyleVariables: () => {},
  App: class { constructor() { globalThis.__app = this; }
    async connect() {}
    getHostContext() { return globalThis.__ctx; } },
};`;

async function mount(name: WidgetName, ctx: Record<string, unknown> = {}) {
  const html = (await widgetHtml(name, FAKE_RUNTIME)).replace('<script type="module">', '<script>');
  const dom = new JSDOM(
    html.replace('<head>', '<head><script>globalThis.__ctx = ' + JSON.stringify(ctx) + '</script>'),
    {
      runScripts: 'dangerously',
    },
  );
  const w = dom.window as unknown as {
    __app: { ontoolinput: (p: unknown) => void; ontoolresult: (r: unknown) => void };
    document: Document;
  };
  await new Promise((r) => setTimeout(r, 0));
  return {
    doc: w.document,
    input: (args: Record<string, unknown>) => w.__app.ontoolinput({ arguments: args }),
    result: (data: unknown, isError = false) =>
      w.__app.ontoolresult({
        content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
        ...(isError && { isError: true }),
      }),
  };
}

const textOf = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('@oortmem/mcp widgets: rendering', () => {
  it('ui.recall-card-shows-the-query-tiers-dates-and-why', async () => {
    const w = await mount('recall', { theme: 'dark', locale: 'en-US', timeZone: 'UTC' });
    w.input({ query: 'vault code' });
    expect(textOf(w.doc.querySelector('h1'))).toBe('“vault code”');
    expect(textOf(w.doc.querySelector('.pending'))).toBe('Searching memory…');
    w.result(recallOut);
    expect(w.doc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(textOf(w.doc.querySelector('.summary'))).toBe('2 memories · current');
    const items = [...w.doc.querySelectorAll('ol.items > li')];
    expect(items).toHaveLength(2);
    expect(textOf(items[0]?.querySelector('.text'))).toBe(SECRET_TEXT);
    expect(textOf(items[0]?.querySelector('.facts'))).toBe(
      'Photosphere · semantic · since Oct 2, 2026',
    );
    expect(textOf(items[0]?.querySelector('.why'))).toBe(
      'Why: matching words · similar meaning · relevance 0.91',
    );
    expect(items[1]?.classList.contains('ended')).toBe(true);
    expect(textOf(items[1]?.querySelector('.facts'))).toBe(
      'Oort Cloud · episodic · since Mar 1, 2026 · ended Sep 30, 2026 · may be outdated',
    );
    expect(items[1]?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-03-01T00:00:00.000Z',
    );
    // Memory text is text: markup in it never becomes elements.
    expect(w.doc.querySelector('img')).toBeNull();
    expect(textOf(items[1]?.querySelector('.text'))).toContain('<img src=x');
  });

  it('ui.recall-card-states-empty-abstained-and-error', async () => {
    const w = await mount('recall');
    w.input({ query: 'q' });
    w.result({ memories: [] });
    expect(textOf(w.doc.querySelector('.empty'))).toBe('No memories matched this query.');
    w.result({ memories: [], abstained: true, note: 'Answer without memory.' });
    expect(textOf(w.doc.querySelector('.empty'))).toBe('Nothing in memory answers this.');
    expect(w.doc.querySelector('.note')).toBeNull();
    w.result({ memories: [], note: 'Recall ran in a reduced mode.' });
    expect(textOf(w.doc.querySelector('.note'))).toBe('Recall ran in a reduced mode.');
    w.result("You didn't allow this assistant to read your memories.", true);
    expect(textOf(w.doc.querySelector('.error'))).toBe(
      "You didn't allow this assistant to read your memories.",
    );
  });

  it('ui.memory-card-explains-with-history-and-decisions', async () => {
    const w = await mount('memory', { theme: 'light', locale: 'en-US', timeZone: 'UTC' });
    w.input({ id: 'mem_01hx7a9k2c' });
    w.result(explainOut);
    expect(textOf(w.doc.querySelector('h1'))).toBe(SECRET_TEXT);
    expect(textOf(w.doc.querySelector('.facts'))).toBe(
      'Kuiper Belt · semantic · pinned · since Oct 2, 2026',
    );
    const chain = w.doc.querySelectorAll('.chain > li');
    expect(chain).toHaveLength(1);
    expect(textOf(chain[0]?.querySelector('.text'))).toBe('the vault combination was orbit-1111');
    expect(textOf(chain[0]?.querySelector('.facts'))).toBe(
      'since Jan 1, 2026 · replaced Oct 2, 2026 · mem_01hx',
    );
    expect(textOf(w.doc.querySelector('details > summary'))).toBe('How Oort decided');
    expect(textOf(w.doc.querySelector('details li'))).toBe('gate: store? → yes (93%)');
  });

  it('ui.memory-card-confirms-what-remember-saved', async () => {
    const w = await mount('memory', { locale: 'en-US' });
    w.input({ facts: ['The user prefers pnpm', 'hi'] });
    w.result({
      results: [
        { fact: 0, outcome: 'added', id: 'mem_new0001' },
        { fact: 1, outcome: 'skipped', reason: 'not durable' },
      ],
    });
    expect(textOf(w.doc.querySelector('h1'))).toBe('Saved 1 memory');
    const items = [...w.doc.querySelectorAll('ul.items > li')];
    expect(
      items.map((li) => [textOf(li.querySelector('.text')), textOf(li.querySelector('.facts'))]),
    ).toEqual([
      ['The user prefers pnpm', '✓ Saved · mem_new0'],
      ['hi', '– Not saved · not durable'],
    ]);
  });
});
