import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeIo, harness } from '../../test/helpers.js';
import { createKeychain } from '../keychain.js';
import { mcpCommand } from './mcp.js';

describe('oort mcp --project', () => {
  const run = async (project: string | undefined) => {
    const h = harness();
    const dirs: string[] = [];
    const inner = h.wire;
    h.wire = async (cwd, o) => {
      dirs.push(cwd);
      return inner(cwd, o);
    };
    const io = fakeIo({ cwd: h.cwd });
    const code = await mcpCommand(
      project === undefined ? {} : { project },
      { io, wire: h.wire, keychain: createKeychain({ platform: 'none' }) },
      async () => {},
    );
    return { code, io, dirs, h };
  };

  it('mcp.project-scopes-to-the-given-directory', async () => {
    const h = harness();
    const repo = path.join(h.root, 'repo');
    fs.mkdirSync(repo);
    const r = await run(repo);
    expect(r.code).toBe(0);
    expect(r.dirs).toEqual([repo]);
  });

  it('mcp.an-unfilled-workspace-folder-falls-back-to-the-start-directory', async () => {
    for (const p of ['${workspaceFolder}', '']) {
      const r = await run(p);
      expect(r.code, p).toBe(0);
      expect(r.dirs, p).toEqual([r.h.cwd]);
      expect(r.io.stderr, p).toContain('did not fill in');
    }
  });

  it('mcp.a-missing-project-directory-is-refused', async () => {
    await expect(run('/no/such/dir/for/oort')).rejects.toThrow(/not a directory/);
  });
});
