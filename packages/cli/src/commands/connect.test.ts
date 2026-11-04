import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harness } from '../../test/helpers.js';

describe('oort connect (in process)', () => {
  it('connect.unknown-host-is-a-usage-error-listing-hosts', async () => {
    const h = harness();
    const r = await h.run(['connect', 'chatgpt']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('claude-code, claude-desktop, codex, cursor, gemini, vscode');
    expect(r.io.stderr).toMatch(/remote MCP|Oort Cloud/);
  });

  it('connect.refuses-when-not-running-as-the-bin', async () => {
    const h = harness();
    const r = await h.run(['connect', 'cursor']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toMatch(/not running as its bin/);
    expect(fs.existsSync(path.join(h.root, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('connect.disconnect-works-without-the-bin', async () => {
    const h = harness();
    const file = path.join(h.root, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stale = {
      mcpServers: {
        oort: { type: 'stdio', command: '/gone/node_modules/oort/dist/main.js', args: ['mcp'] },
        other: { command: 'x' },
      },
    };
    fs.writeFileSync(file, JSON.stringify(stale, null, 2));
    const r = await h.run(['disconnect', 'cursor']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toMatch(/^oort disconnect cursor/);
    expect(r.io.stdout).toContain('- mcpServers.oort.command');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { other: { command: 'x' } },
    });
  });
});
