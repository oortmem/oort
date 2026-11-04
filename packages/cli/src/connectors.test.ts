import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';
import {
  HOSTS,
  connectHost,
  detectHosts,
  disconnectHost,
  hostConfigPath,
  type Host,
  type HostContext,
} from './connectors.js';
import { Refusal } from './util.js';

const CMD = '/opt/oort/lib/node_modules/oort/dist/main.js';
const SECRET = ['sk', 'other', 'server', 'secret'].join('-');

function context(
  platform: NodeJS.Platform = 'darwin',
  env: Record<string, string> = {},
): HostContext {
  const home = path.join(tmpdir('oort-connect-'), 'home');
  fs.mkdirSync(home);
  return { home, env: { HOME: home, ...env }, platform };
}

/** A config with an unrelated server (holding a secret) and unrelated settings, in the host's own format. */
function seed(host: Host, file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text: string;
  if (host === 'codex') {
    text = [
      '# my codex config',
      'model = "gpt-6"',
      '',
      '[mcp_servers.github]',
      'command = "gh-mcp"',
      `env = { GITHUB_TOKEN = "${SECRET}" }`,
      '',
      '[profiles.fast]',
      'model = "gpt-6-mini" # inline comment',
      '',
    ].join('\n');
  } else {
    const key = host === 'vscode' ? 'servers' : 'mcpServers';
    text = [
      '{',
      host === 'vscode' ? '    // my servers' : null,
      '    "theme": "dark",',
      `    "${key}": {`,
      '        "github": {',
      '            "command": "gh-mcp",',
      `            "env": { "GITHUB_TOKEN": "${SECRET}" }`,
      '        }',
      '    }',
      '}',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }
  fs.writeFileSync(file, text, { mode: 0o644 });
  return text;
}

function read(host: Host, file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, 'utf8');
  return (host === 'codex' ? parseToml(text) : parseJsonc(text)) as Record<string, unknown>;
}

const serversKey = (host: Host): string =>
  host === 'codex' ? 'mcp_servers' : host === 'vscode' ? 'servers' : 'mcpServers';

const servers = (host: Host, cfg: Record<string, unknown>): Record<string, unknown> =>
  (cfg[serversKey(host)] ?? {}) as Record<string, unknown>;

describe('connector config paths', () => {
  it('connect.paths-per-host-and-platform', () => {
    const home = '/Users/a';
    const mac: HostContext = { home, env: {}, platform: 'darwin' };
    expect(hostConfigPath('claude-desktop', mac)).toBe(
      '/Users/a/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(hostConfigPath('claude-code', mac)).toBe('/Users/a/.claude.json');
    expect(hostConfigPath('codex', mac)).toBe('/Users/a/.codex/config.toml');
    expect(hostConfigPath('codex', { ...mac, env: { CODEX_HOME: '/x/codex' } })).toBe(
      '/x/codex/config.toml',
    );
    expect(hostConfigPath('cursor', mac)).toBe('/Users/a/.cursor/mcp.json');
    expect(hostConfigPath('gemini', mac)).toBe('/Users/a/.gemini/settings.json');
    expect(hostConfigPath('vscode', mac)).toBe(
      '/Users/a/Library/Application Support/Code/User/mcp.json',
    );
    const linux: HostContext = { home: '/home/a', env: {}, platform: 'linux' };
    expect(hostConfigPath('claude-desktop', linux)).toBe(
      '/home/a/.config/Claude/claude_desktop_config.json',
    );
    expect(hostConfigPath('vscode', linux)).toBe('/home/a/.config/Code/User/mcp.json');
    const win: HostContext = {
      home: 'C:\\Users\\a',
      env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
      platform: 'win32',
    };
    expect(hostConfigPath('claude-desktop', win)).toBe(
      path.join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'),
    );
    expect(hostConfigPath('vscode', win)).toBe(
      path.join('C:\\Users\\a\\AppData\\Roaming', 'Code', 'User', 'mcp.json'),
    );
  });

  it('connect.detects-installed-hosts-by-their-directories', () => {
    const hc = context();
    expect(detectHosts(hc)).toEqual([]);
    fs.mkdirSync(path.join(hc.home, '.claude'));
    fs.mkdirSync(path.join(hc.home, '.codex'));
    fs.mkdirSync(path.join(hc.home, 'Library', 'Application Support', 'Claude'), {
      recursive: true,
    });
    expect(detectHosts(hc).sort()).toEqual(['claude-code', 'claude-desktop', 'codex']);
  });
});

describe.each<Host>([...HOSTS])('oort connect %s', (host) => {
  it(`connect.${host}-adds-entry-keeps-the-rest-and-is-idempotent`, () => {
    const hc = context();
    const file = hostConfigPath(host, hc);
    const original = seed(host, file);
    const before = read(host, file);

    const c = connectHost(host, hc, CMD);
    expect(c.changed).toBe(true);
    expect(c.file).toBe(file);
    const after = read(host, file);
    const entry = servers(host, after)['oort'] as Record<string, unknown>;
    expect(entry['command']).toBe(CMD);
    // Cursor and VS Code fill in ${workspaceFolder}, so the scope is the open workspace.
    expect(entry['args']).toEqual(
      host === 'cursor' || host === 'vscode' ? ['mcp', '--project', '${workspaceFolder}'] : ['mcp'],
    );
    if (['cursor', 'vscode', 'claude-code'].includes(host)) expect(entry['type']).toBe('stdio');
    // Everything else is untouched.
    const { oort: _o, ...rest } = servers(host, after);
    expect(rest).toEqual(servers(host, before));
    expect({ ...after, [serversKey(host)]: rest }).toEqual(before);
    // Formatting and comments of the rest survive.
    const text = fs.readFileSync(file, 'utf8');
    if (host === 'codex') {
      expect(text).toContain('# my codex config');
      expect(text).toContain('model = "gpt-6-mini" # inline comment');
    } else {
      expect(text).toContain('\n    "theme": "dark",');
      expect(text).toContain('\n        "github": {');
      // A sibling's inline object is not reflowed.
      expect(text).toContain(`"env": { "GITHUB_TOKEN": "${SECRET}" }`);
      expect(text).toContain('\n        "oort": {\n            "');
      if (host === 'vscode') expect(text).toContain('// my servers');
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    // One-time backup of the original, and the state before this change.
    expect(fs.readFileSync(`${file}.oort-backup`, 'utf8')).toBe(original);
    expect(c.backup).toBe(`${file}.oort-backup`);
    // The diff names keys only: never a value, never another server's secret.
    expect(c.diff.join('\n')).toContain('oort');
    expect(c.diff.join('\n')).not.toContain(SECRET);
    expect(c.diff.join('\n')).not.toContain(CMD);

    const again = connectHost(host, hc, CMD);
    expect(again.changed).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);

    const d = disconnectHost(host, hc, CMD);
    expect(d.changed).toBe(true);
    expect(read(host, file)).toEqual(before);
    // Byte for byte: the edit only ever touched the oort entry's own text.
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(disconnectHost(host, hc, CMD).changed).toBe(false);
  });

  it(`connect.${host}-creates-a-missing-file-owner-only`, () => {
    const hc = context();
    const file = hostConfigPath(host, hc);
    expect(fs.existsSync(file)).toBe(false);
    const c = connectHost(host, hc, CMD);
    expect(c.created).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.oort-backup`)).toBe(false);
    expect((servers(host, read(host, file))['oort'] as { command: string }).command).toBe(CMD);
    disconnectHost(host, hc, CMD);
    expect(read(host, file)).toEqual({});
  });

  it(`connect.${host}-updates-an-entry-from-before-the-workspace-folder-args`, () => {
    if (host !== 'cursor' && host !== 'vscode') return;
    const hc = context();
    const file = hostConfigPath(host, hc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const key = host === 'vscode' ? 'servers' : 'mcpServers';
    fs.writeFileSync(
      file,
      JSON.stringify({ [key]: { oort: { type: 'stdio', command: CMD, args: ['mcp'] } } }),
    );
    const c = connectHost(host, hc, CMD);
    expect(c.changed).toBe(true);
    expect(c.diff.join('\n')).toMatch(/args/);
    expect((servers(host, read(host, file))['oort'] as { args: string[] }).args).toEqual([
      'mcp',
      '--project',
      '${workspaceFolder}',
    ]);
    expect(disconnectHost(host, hc, CMD).changed).toBe(true);
  });

  it(`connect.${host}-replaces-a-stale-oort-entry-and-refuses-a-foreign-one`, () => {
    const hc = context();
    const file = hostConfigPath(host, hc);
    connectHost(host, hc, '/old/place/node_modules/oort/dist/main.js');
    expect(connectHost(host, hc, '/older/lib/node_modules/oortmem/dist/main.js').changed).toBe(
      true,
    );
    const moved = connectHost(host, hc, CMD);
    expect(moved.changed).toBe(true);
    expect(moved.diff.join('\n')).toMatch(/~ .*oort\.command/);
    expect((servers(host, read(host, file))['oort'] as { command: string }).command).toBe(CMD);

    // An "oort" entry someone wrote by hand (a remote URL here) is theirs: never touched.
    const other = context();
    const otherFile = hostConfigPath(host, other);
    fs.mkdirSync(path.dirname(otherFile), { recursive: true });
    const foreign =
      host === 'codex'
        ? '[mcp_servers.oort]\nurl = "https://mcp.oortcloud.dev/mcp"\n'
        : `{"${serversKey(host)}": {"oort": {"url": "https://mcp.oortcloud.dev/mcp"}}}\n`;
    fs.writeFileSync(otherFile, foreign);
    expect(() => connectHost(host, other, CMD)).toThrow(Refusal);
    expect(() => disconnectHost(host, other, CMD)).toThrow(Refusal);
    expect(fs.readFileSync(otherFile, 'utf8')).toBe(foreign);
    expect(fs.existsSync(`${otherFile}.oort-backup`)).toBe(false);
  });

  it(`connect.${host}-refuses-an-unparseable-file`, () => {
    const hc = context();
    const file = hostConfigPath(host, hc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = host === 'codex' ? '[mcp_servers\nnope' : '{"mcpServers": {';
    fs.writeFileSync(file, broken);
    expect(() => connectHost(host, hc, CMD)).toThrow(Refusal);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });
});

describe('oort connect, edge cases', () => {
  it('connect.writes-through-a-symlinked-config', () => {
    const hc = context();
    const file = hostConfigPath('cursor', hc);
    const real = path.join(hc.home, 'dotfiles', 'mcp.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(real, '{}\n');
    fs.symlinkSync(real, file);
    connectHost('cursor', hc, CMD);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toContain(CMD);
  });

  it('connect.codex-refuses-an-oort-entry-it-cannot-edit-in-place', () => {
    const hc = context();
    const file = hostConfigPath('codex', hc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const inline = `mcp_servers = { oort = { command = "${CMD}", args = ["mcp"] } }\n`;
    fs.writeFileSync(file, inline);
    expect(() => disconnectHost('codex', hc, CMD)).toThrow(/edit .* by hand/);
    expect(fs.readFileSync(file, 'utf8')).toBe(inline);
  });

  it('connect.servers-container-that-is-not-an-object-is-refused', () => {
    const hc = context();
    const file = hostConfigPath('gemini', hc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"mcpServers": []}');
    expect(() => connectHost('gemini', hc, CMD)).toThrow(/mcpServers/);
  });
});
