import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TOOL_NAMES } from '@oortmem/mcp';
import { VERSION } from '@oortmem/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';

/** The built bin: an MCP host starts `oort mcp` as a process, so this does too. */
const BIN = path.join(import.meta.dirname, '..', 'dist', 'main.js');

beforeAll(() => {
  if (!fs.existsSync(BIN)) throw new Error(`${BIN} is missing: run \`pnpm build\` first`);
});

/**
 * A conformance smoke test of `oort mcp` as any host sees it (CON-18): the initialize handshake,
 * tools/list with a schema and annotations per tool, ping, tool calls that succeed, a tool error
 * reported as a result, and an unknown tool refused. Run with the official MCP client.
 */
describe('oort mcp conformance smoke', () => {
  it('mcp.initialize-list-call-over-stdio', async () => {
    const root = tmpdir('oort-mcp-');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const transport = new StdioClientTransport({
      command: BIN,
      args: ['mcp', '--agent', 'cursor'],
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        OORT_HOME: path.join(home, '.oort'),
        OORT_NO_KEYCHAIN: '1',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'oort-conformance', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'oort', version: VERSION });
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      expect(client.getInstructions()).toContain('recall');
      expect(await client.ping()).toEqual({});

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ['recall', 'remember', 'forget', 'pin', 'explain', 'list_recent', 'whoami']) {
        expect(names).toContain(n);
      }
      for (const t of tools) {
        expect((TOOL_NAMES as readonly string[]).includes(t.name)).toBe(true);
        expect(t.inputSchema.type).toBe('object');
        expect(typeof t.description).toBe('string');
        expect(typeof t.annotations?.readOnlyHint).toBe('boolean');
      }

      const recall = await client.callTool({ name: 'recall', arguments: { query: 'auth port' } });
      expect(recall.isError).not.toBe(true);
      expect((recall.content as { type: string }[])[0]?.type).toBe('text');
      const recent = await client.callTool({ name: 'list_recent', arguments: {} });
      expect(recent.isError).not.toBe(true);
      const whoami = await client.callTool({ name: 'whoami', arguments: {} });
      const who = JSON.parse((whoami.content as { text: string }[])[0]?.text ?? '{}') as {
        agent?: unknown;
      };
      expect(who.agent).toBe('cursor');

      // A tool that fails answers with isError, not a protocol error.
      const missing = await client.callTool({
        name: 'explain',
        arguments: { id: '00000000-0000-0000-0000-000000000000' },
      });
      expect(missing.isError).toBe(true);

      // Invalid arguments and an unknown tool never succeed.
      const bad = await client
        .callTool({ name: 'recall', arguments: { query: 42 } })
        .catch((e: unknown) => ({ isError: true, thrown: e }));
      expect(bad.isError).toBe(true);
      const unknown = await client
        .callTool({ name: 'no_such_tool', arguments: {} })
        .catch((e: unknown) => ({ isError: true, thrown: e }));
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
