import type { McpServer, RegisteredResource, RegisteredTool } from '@modelcontextprotocol/server';
import type { ToolName } from './tools.js';

/**
 * In-chat widgets (MCP Apps, `@modelcontextprotocol/ext-apps`). A widget-enabled tool names a
 * `ui://` resource in `_meta.ui.resourceUri`; a host that renders MCP Apps reads that resource
 * and shows it in a sandboxed iframe, fed the tool's own result. The tool result itself does not
 * change, so every other host keeps the plain JSON text it always had.
 */

/** The MCP Apps extension id a client declares under `capabilities.extensions`. */
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** The MIME type of an MCP Apps HTML resource. */
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
/** The deprecated flat tool `_meta` key some hosts still read; ext-apps' registerAppTool sets both. */
const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri';

export const WIDGETS = {
  recall: {
    uri: 'ui://oort/recall-card.html',
    title: 'Oort recall card',
    description: 'The memories a recall returned: tier, dates and why each was picked.',
  },
  memory: {
    uri: 'ui://oort/memory-card.html',
    title: 'Oort memory card',
    description: 'One memory with its history, or the facts a remember call saved.',
  },
} as const;
export type WidgetName = keyof typeof WIDGETS;

/** Which widget renders which tool's result. Every other tool stays text only. */
export const TOOL_WIDGETS: Partial<Record<ToolName, WidgetName>> = {
  recall: 'recall',
  explain: 'memory',
  remember: 'memory',
};

/**
 * The widgets need nothing from the network: no fetches, no remote scripts, styles or fonts.
 * Empty lists keep the host's default block-all policy.
 */
const RESOURCE_UI_META = {
  ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
} as const;

/**
 * Whether the client renders MCP Apps, from its declared capabilities:
 * - `yes` / `no` when it declared them (stdio sessions, and 2026-07-28 requests, which carry
 *   them on every request);
 * - `unknown` on a stateless 2025-era HTTP request, which carries none (`initialize` went to an
 *   earlier instance). Widgets are offered then: hosts ignore `_meta` they don't understand,
 *   and the text result is unchanged.
 */
export type UiSupport = 'yes' | 'no' | 'unknown';
export function uiSupport(capabilities: unknown): UiSupport {
  if (capabilities === undefined || capabilities === null) return 'unknown';
  const ext = (capabilities as { extensions?: Record<string, unknown> }).extensions?.[
    UI_EXTENSION_ID
  ] as { mimeTypes?: unknown } | undefined;
  return Array.isArray(ext?.mimeTypes) && ext.mimeTypes.includes(UI_MIME_TYPE) ? 'yes' : 'no';
}

/**
 * The widget's HTML document: styles and scripts inline, nothing loaded from elsewhere.
 * `runtime` defaults to the bundled ext-apps runtime; tests pass a stand-in host. The sources
 * (about 580 kB, mostly the runtime) load on first use, so starting a server stays cheap.
 */
export async function widgetHtml(name: WidgetName, runtime?: string): Promise<string> {
  const src = await import('./widgets.generated.js');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${WIDGETS[name].title}</title>`,
    `<style>${src.WIDGET_CSS}</style>`,
    '</head>',
    '<body>',
    '<main id="root"></main>',
    `<script type="module">${runtime ?? src.EXT_APPS_RUNTIME}\n${src.WIDGET_COMMON}\n${src.WIDGET_SCRIPTS[name]}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Registers the widget resources and links them from their tools. Both are shown unless the
 * client declared it can't render MCP Apps; the check runs per listing, so one server instance
 * answers each client by its own capabilities.
 */
export function attachWidgets(
  server: McpServer,
  tools: ReadonlyMap<ToolName, RegisteredTool>,
): void {
  // getClientCapabilities is backfilled per request on 2026-07-28 traffic and set by initialize
  // on a 2025-era session; a stateless 2025-era request leaves it undefined.
  const shown = (): boolean => uiSupport(server.server.getClientCapabilities()) !== 'no';

  for (const name of Object.keys(WIDGETS) as WidgetName[]) {
    const w = WIDGETS[name];
    const resource: RegisteredResource = server.registerResource(
      w.title,
      w.uri,
      {
        title: w.title,
        description: w.description,
        mimeType: UI_MIME_TYPE,
        _meta: RESOURCE_UI_META,
      },
      async () => ({
        contents: [
          {
            uri: w.uri,
            mimeType: UI_MIME_TYPE,
            text: await widgetHtml(name),
            _meta: RESOURCE_UI_META,
          },
        ],
      }),
    );
    Object.defineProperty(resource, 'enabled', { get: shown, configurable: true });
  }

  for (const [tool, name] of Object.entries(TOOL_WIDGETS) as [ToolName, WidgetName][]) {
    const registered = tools.get(tool);
    if (registered === undefined) continue;
    const uri = WIDGETS[name].uri;
    const meta = { ui: { resourceUri: uri }, [LEGACY_RESOURCE_URI_KEY]: uri };
    Object.defineProperty(registered, '_meta', {
      get: () => (shown() ? meta : undefined),
      configurable: true,
    });
  }
}
