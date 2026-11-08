import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOL_NAMES } from './index.js';

// The install bundles under distribution/ are plain files hosts read directly from git, so these
// tests keep them consistent with the packages they describe.
const root = resolve(import.meta.dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const json = (p: string): Record<string, any> => JSON.parse(read(p)) as Record<string, any>;
const version = (json('packages/cli/package.json') as { version: string }).version;

interface Plugin {
  name: string;
  dir: string;
  manifest: string;
}
/** Every plugin a marketplace lists, with its directory and manifest. */
const claudePlugins = (): Plugin[] =>
  json('.claude-plugin/marketplace.json').plugins.map((e: { name: string; source: string }) => {
    const dir = e.source.slice(2);
    return { name: e.name, dir, manifest: `${dir}/.claude-plugin/plugin.json` };
  });
const codexPlugins = (): Plugin[] =>
  json('.agents/plugins/marketplace.json').plugins.map(
    (e: { name: string; source: { path: string } }) => ({
      name: e.name,
      dir: e.source.path,
      manifest: `${e.source.path}/.codex-plugin/plugin.json`,
    }),
  );
// The keys each documented format names; an unknown one is a typo Claude Code silently drops.
const CLAUDE_MARKETPLACE_KEYS = ['$schema', 'name', 'version', 'description', 'owner', 'plugins'];
const CLAUDE_ENTRY_KEYS = ['name', 'source', 'description', 'category', 'keywords', 'tags'];
const CLAUDE_PLUGIN_KEYS = [
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
];
const CODEX_INTERFACE_REQUIRED = [
  'displayName',
  'shortDescription',
  'longDescription',
  'developerName',
  'category',
  'capabilities',
  'composerIcon',
  'logo',
];

describe('distribution', () => {
  it('distribution.skills-are-copies-of-the-package-skill', () => {
    const skill = read('packages/mcp/skill/oort-memory/SKILL.md');
    expect(read('distribution/claude-code/oort/skills/oort-memory/SKILL.md')).toBe(skill);
    expect(read('distribution/codex/oort/skills/oort-memory/SKILL.md')).toBe(skill);
  });

  it('distribution.versions-match-the-cli', () => {
    for (const p of [...claudePlugins(), ...codexPlugins()]) {
      expect(json(p.manifest).version, p.manifest).toBe(version);
    }
    expect(json('distribution/claude-desktop/manifest.json').version).toBe(version);
    expect(json('.claude-plugin/marketplace.json').version).toBe(version);
  });

  it('distribution.marketplace-names-match-the-plugins', () => {
    const cc = json('.claude-plugin/marketplace.json');
    expect(cc.plugins.map((p: { name: string }) => p.name)).toEqual(['oort', 'oort-dev']);
    for (const p of claudePlugins()) expect(json(p.manifest).name, p.manifest).toBe(p.name);
    expect(cc.plugins[0].source).toBe('./distribution/claude-code/oort');
    const cx = json('.agents/plugins/marketplace.json');
    expect(cx.plugins.map((p: { name: string }) => p.name)).toEqual(['oort', 'oort-dev']);
    for (const p of codexPlugins()) expect(json(p.manifest).name, p.manifest).toBe(p.name);
    expect(cx.plugins[0].source).toMatchObject({
      source: 'git-subdir',
      path: 'distribution/codex/oort',
    });
  });

  // The required fields and rules of code.claude.com/docs/en/plugins/marketplace-reference and
  // manifest-reference (checked 2026-11-06). `claude plugin validate .` is the full check.
  it('distribution.claude-marketplace-and-plugins-follow-the-documented-format', () => {
    const m = json('.claude-plugin/marketplace.json');
    const id = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    expect(m.name).toMatch(id);
    expect(m.name).not.toContain('..');
    expect(m.owner.name).toBeTruthy();
    expect(m.description).toBeTruthy();
    expect(Object.keys(m).filter((k) => !CLAUDE_MARKETPLACE_KEYS.includes(k))).toEqual([]);
    for (const e of m.plugins) {
      expect(e.name).toMatch(id);
      expect(e.source).toMatch(/^\.\/[^\\]+$/);
      expect(e.source).not.toContain('..');
      expect(e.description, e.name).toBeTruthy();
      expect(e.keywords, e.name).toEqual(expect.arrayContaining(['oort']));
      expect(Object.keys(e).filter((k) => !CLAUDE_ENTRY_KEYS.includes(k))).toEqual([]);
    }
    for (const p of claudePlugins()) {
      const pj = json(p.manifest);
      expect(pj.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(pj.name).not.toMatch(/^(claude|anthropic|anthropics|cc-plugin)-/);
      expect(pj.description, p.manifest).toBeTruthy();
      expect(pj.author.name, p.manifest).toBeTruthy();
      expect(() => new URL(pj.homepage), p.manifest).not.toThrow();
      expect(Object.keys(pj).filter((k) => !CLAUDE_PLUGIN_KEYS.includes(k))).toEqual([]);
      // Components sit at the plugin root in their default places, never in .claude-plugin/.
      expect(readdirSync(join(root, p.dir, '.claude-plugin')).sort()).toEqual([
        'icon.png',
        'plugin.json',
      ]);
    }
  });

  // The Codex compatibility manifest (.codex-plugin/plugin.json) and marketplace entry fields of
  // developers.openai.com/codex/plugins/build and plugins/deploy/submission (checked 2026-11-06).
  it('distribution.codex-marketplace-and-plugins-follow-the-documented-format', () => {
    const m = json('.agents/plugins/marketplace.json');
    expect(m.name).toBe(json('.claude-plugin/marketplace.json').name);
    expect(m.interface.displayName).toBeTruthy();
    for (const e of m.plugins) {
      expect(e.source).toEqual({
        source: 'git-subdir',
        url: 'https://github.com/oortmem/oort.git',
        path: `distribution/codex/${e.name}`,
      });
      expect(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']).toContain(
        e.policy.installation,
      );
      expect(['ON_INSTALL', 'ON_USE']).toContain(e.policy.authentication);
      expect(e.category, e.name).toBeTruthy();
    }
    for (const p of codexPlugins()) {
      const pj = json(p.manifest);
      for (const k of ['name', 'version', 'description'])
        expect(pj[k], `${p.name} ${k}`).toBeTruthy();
      expect(pj.author.name).toBeTruthy();
      expect(pj.skills).toBe('./skills/');
      const ui = pj.interface;
      for (const k of CODEX_INTERFACE_REQUIRED)
        expect(ui[k], `${p.name} interface.${k}`).toBeDefined();
      expect(ui.displayName.length).toBeLessThanOrEqual(30);
      expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
      expect(Array.isArray(ui.capabilities)).toBe(true);
      // Every path is ./-relative, inside the plugin, and exists.
      for (const rel of [pj.skills, pj.mcpServers, pj.hooks, ui.composerIcon, ui.logo]) {
        if (rel === undefined) continue;
        expect(rel).toMatch(/^\.\/(?!.*\.\.)/);
        expect(existsSync(join(root, p.dir, rel)), `${p.dir}/${rel}`).toBe(true);
      }
    }
  });

  it('distribution.servers-run-oort-mcp-and-hooks-run-oort-hook', () => {
    for (const p of [
      'distribution/claude-code/oort/.mcp.json',
      'distribution/codex/oort/.mcp.json',
    ]) {
      expect(json(p).mcpServers.oort, p).toEqual({ type: 'stdio', command: 'oort', args: ['mcp'] });
    }
    const cc = json('distribution/claude-code/oort/hooks/hooks.json').hooks;
    expect(Object.keys(cc).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    const cx = json('distribution/codex/oort/hooks/hooks.json').hooks;
    // Codex's Stop payload points at a Codex transcript, which `oort hook Stop` does not parse.
    expect(Object.keys(cx).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    for (const [event, groups] of Object.entries({ ...cc, ...cx }) as [string, any[]][]) {
      for (const g of groups) {
        expect(g.hooks, event).toEqual([{ type: 'command', command: `oort hook ${event}` }]);
      }
    }
  });

  // The MCP Registry entry (server.json, modelcontextprotocol.io/registry, checked 2026-11-08). The
  // registry accepts it only when its name equals the published package's mcpName, so the two move
  // together, and it lists the release the version bump names.
  it('distribution.mcp-registry-server-json-matches-the-cli', () => {
    const s = json('server.json');
    const cli = json('packages/cli/package.json');
    expect(s.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/,
    );
    expect(s.name).toBe('io.github.oortmem/oort');
    expect(cli.mcpName).toBe(s.name);
    expect(s.version).toBe(version);
    expect(s.description.length).toBeLessThanOrEqual(100);
    expect(s.packages).toHaveLength(1);
    const npm = s.packages[0];
    expect(npm).toMatchObject({
      registryType: 'npm',
      identifier: cli.name,
      version,
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', value: 'mcp' }],
    });
    // The same settings the Claude Desktop bundle passes to `oort mcp`, all optional.
    const env = npm.environmentVariables as { name: string; isRequired: boolean }[];
    expect(env.map((e) => e.name).sort()).toEqual(
      Object.keys(json('distribution/claude-desktop/manifest.json').server.mcp_config.env).sort(),
    );
    for (const e of env) expect(e.isRequired, e.name).toBe(false);
    expect(s.remotes).toEqual([{ type: 'streamable-http', url: 'https://mcp.oortcloud.dev/mcp' }]);
  });

  it('distribution.mcpb-manifest-runs-the-bundled-cli-and-holds-no-secrets', () => {
    const m = json('distribution/claude-desktop/manifest.json');
    expect(m.manifest_version).toBe('0.3');
    expect(m.server).toMatchObject({
      type: 'node',
      entry_point: 'server/node_modules/oortmem/dist/main.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/node_modules/oortmem/dist/main.js', 'mcp'],
      },
    });
    // `share` is offered only by the remote connector, to a grant with memory.share (CON-64);
    // the judgment tools (CON-71) only by the local server, which is what the bundle runs.
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(
      ALL_TOOL_NAMES.filter((n) => n !== 'share'),
    );
    // Every env value comes from a user setting; key settings are sensitive and optional.
    for (const [k, v] of Object.entries(m.server.mcp_config.env as Record<string, string>)) {
      expect(v, k).toMatch(/^\$\{user_config\.[a-z_]+\}$/);
    }
    for (const [k, opt] of Object.entries(m.user_config as Record<string, any>)) {
      if (k.endsWith('_key')) expect([opt.sensitive, opt.required], k).toEqual([true, false]);
    }
  });
});
