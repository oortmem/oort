import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from './index.js';

// The install bundles under distribution/ are plain files hosts read directly from git, so these
// tests keep them consistent with the packages they describe.
const root = resolve(import.meta.dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const json = (p: string): Record<string, any> => JSON.parse(read(p)) as Record<string, any>;
const version = (json('packages/cli/package.json') as { version: string }).version;

describe('distribution', () => {
  it('distribution.skills-are-copies-of-the-package-skill', () => {
    const skill = read('packages/mcp/skill/oort-memory/SKILL.md');
    expect(read('distribution/claude-code/oort/skills/oort-memory/SKILL.md')).toBe(skill);
    expect(read('distribution/codex/oort/skills/oort-memory/SKILL.md')).toBe(skill);
  });

  it('distribution.versions-match-the-cli', () => {
    expect(json('distribution/claude-code/oort/.claude-plugin/plugin.json').version).toBe(version);
    expect(json('distribution/codex/oort/.codex-plugin/plugin.json').version).toBe(version);
    expect(json('distribution/claude-desktop/manifest.json').version).toBe(version);
    expect(json('.claude-plugin/marketplace.json').version).toBe(version);
  });

  it('distribution.marketplace-names-match-the-plugins', () => {
    const cc = json('.claude-plugin/marketplace.json');
    expect(cc.plugins.map((p: { name: string }) => p.name)).toEqual([
      json('distribution/claude-code/oort/.claude-plugin/plugin.json').name,
    ]);
    expect(cc.plugins[0].source).toBe('./distribution/claude-code/oort');
    const cx = json('.agents/plugins/marketplace.json');
    expect(cx.plugins[0].name).toBe(json('distribution/codex/oort/.codex-plugin/plugin.json').name);
    expect(cx.plugins[0].source).toMatchObject({
      source: 'git-subdir',
      path: 'distribution/codex/oort',
    });
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
    // `share` is offered only by the remote connector, to a grant with memory.share (CON-64).
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(
      TOOL_NAMES.filter((n) => n !== 'share'),
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
