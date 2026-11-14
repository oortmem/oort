import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type Edit,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { Env } from './io.js';
import { Refusal } from './util.js';

/**
 * MCP config entries for the agent hosts `oort connect` knows. Paths and
 * shapes come from each host's own docs (see docs/cli.md for the sources):
 * - Claude Desktop: `claude_desktop_config.json` under the app's config dir, `mcpServers`.
 * - Claude Code: `~/.claude.json`, top-level `mcpServers` (user scope).
 * - Codex: `$CODEX_HOME/config.toml` (default `~/.codex`), `[mcp_servers.<name>]`.
 * - Cursor: `~/.cursor/mcp.json`, `mcpServers`, `type: "stdio"` required.
 * - Gemini CLI: `~/.gemini/settings.json`, `mcpServers`.
 * - VS Code: `mcp.json` in the default profile's User dir, `servers`, `type: "stdio"`.
 *
 * Only an entry named `oort` that this module would write (or wrote from an
 * older install path) is ever changed; any other `oort` entry is the user's
 * own and is refused. Everything else in the file is kept, with its
 * formatting and comments: a JSON edit replaces only the text of the `oort`
 * property (located with jsonc-parser's syntax tree), and the Codex TOML
 * block is replaced as text; either result is re-parsed to prove nothing
 * else changed.
 */

export const HOSTS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'gemini',
  'vscode',
] as const;
export type Host = (typeof HOSTS)[number];

export const isHost = (s: string): s is Host => (HOSTS as readonly string[]).includes(s);

export const HOST_LABEL: Record<Host, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  vscode: 'VS Code',
};

export const SERVER_NAME = 'oort';

export interface HostContext {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
}

/** `%APPDATA%` on Windows (falling back to its default under the home directory). */
const appData = (hc: HostContext): string =>
  hc.env['APPDATA'] || path.join(hc.home, 'AppData', 'Roaming');

/** The per-user application config dir: macOS Application Support, Windows %APPDATA%, else ~/.config. */
function appConfigDir(hc: HostContext): string {
  if (hc.platform === 'darwin') return path.join(hc.home, 'Library', 'Application Support');
  if (hc.platform === 'win32') return appData(hc);
  return path.join(hc.home, '.config');
}

const codexHome = (hc: HostContext): string => hc.env['CODEX_HOME'] || path.join(hc.home, '.codex');

/** The host's user-level MCP config file. */
export function hostConfigPath(host: Host, hc: HostContext): string {
  switch (host) {
    case 'claude-desktop':
      return path.join(appConfigDir(hc), 'Claude', 'claude_desktop_config.json');
    case 'claude-code':
      return path.join(hc.home, '.claude.json');
    case 'codex':
      return path.join(codexHome(hc), 'config.toml');
    case 'cursor':
      return path.join(hc.home, '.cursor', 'mcp.json');
    case 'gemini':
      return path.join(hc.home, '.gemini', 'settings.json');
    case 'vscode':
      return path.join(appConfigDir(hc), 'Code', 'User', 'mcp.json');
  }
}

/** The directory whose presence means the host is installed (its config file may not exist yet). */
function hostMarkerDir(host: Host, hc: HostContext): string {
  switch (host) {
    case 'claude-code':
      return path.join(hc.home, '.claude');
    case 'codex':
      return codexHome(hc);
    default:
      return path.dirname(hostConfigPath(host, hc));
  }
}

/** Hosts that look installed for this user, in `HOSTS` order. */
export function detectHosts(hc: HostContext): Host[] {
  return HOSTS.filter((h) =>
    fs.statSync(hostMarkerDir(h, hc), { throwIfNoEntry: false })?.isDirectory(),
  );
}

/** The key holding the servers map. */
const serversKey = (host: Host): string =>
  host === 'codex' ? 'mcp_servers' : host === 'vscode' ? 'servers' : 'mcpServers';

/**
 * The placeholder Cursor and VS Code replace with the open workspace's folder
 * (both document `${workspaceFolder}` in `mcp.json`), so the server's scope is
 * that workspace's project. The other hosts get no extra args.
 */
export const WORKSPACE_FOLDER = '${workspaceFolder}';

const takesWorkspaceFolder = (host: Host): boolean => host === 'cursor' || host === 'vscode';

/**
 * The entry `oort connect` writes: the bin's realpath, started as `oort mcp --agent <host>`, so
 * each host acts as its own agent (CON-62): one shared Planet, a Star of its own.
 */
export function serverEntry(host: Host, cmd: string): Record<string, unknown> {
  const agent = ['--agent', host];
  const base = {
    command: cmd,
    args: takesWorkspaceFolder(host)
      ? ['mcp', ...agent, '--project', WORKSPACE_FOLDER]
      : ['mcp', ...agent],
  };
  // Cursor and VS Code document `type` as required; Claude Code writes it for stdio servers.
  return host === 'cursor' || host === 'vscode' || host === 'claude-code'
    ? { type: 'stdio', ...base }
    : base;
}

/**
 * Entries earlier versions wrote, still recognised as Oort's own (and replaced on connect): no
 * agent (before CON-62), and for the workspace hosts no `--project` either.
 */
function olderEntries(host: Host, cmd: string): Record<string, unknown>[] {
  const current = serverEntry(host, cmd);
  return takesWorkspaceFolder(host)
    ? [
        { ...current, args: ['mcp', '--project', WORKSPACE_FOLDER] },
        { ...current, args: ['mcp'] },
      ]
    : [{ ...current, args: ['mcp'] }];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Ours: exactly what `serverEntry` writes, for this install path or any
 * older one (an `oort` or `oortmem` bin, or a package's `oort/dist/main.js` or
 * `oortmem/dist/main.js`). Anything
 * else under the name `oort` (a URL, extra args, env) is the user's own.
 */
function isOurs(host: Host, v: unknown, cmd: string): boolean {
  if (!isObject(v) || typeof v['command'] !== 'string') return false;
  const c = v['command'];
  const oortPath =
    c === cmd ||
    /(?:^|[\\/])oort(?:mem)?$/.test(c) ||
    /[\\/]oort(?:mem)?[\\/]dist[\\/]main\.js$/.test(c);
  if (!oortPath) return false;
  const mine = withoutEmptyEnv({ ...v, command: cmd });
  return [serverEntry(host, cmd), ...olderEntries(host, cmd)].some((e) =>
    isDeepStrictEqual(mine, e),
  );
}

/** `claude mcp add` writes `env: {}` for a stdio server; an empty env changes nothing. */
function withoutEmptyEnv(v: Record<string, unknown>): Record<string, unknown> {
  const { env, ...rest } = v;
  return isObject(env) && Object.keys(env).length === 0 ? rest : v;
}

/** `current` already is `want` (ignoring an empty `env`). */
const same = (current: unknown, want: Record<string, unknown> | undefined): boolean =>
  current === undefined || want === undefined
    ? current === want
    : isObject(current) && isDeepStrictEqual(withoutEmptyEnv(current), want);

export interface Change {
  host: Host;
  action: 'connect' | 'disconnect';
  file: string;
  changed: boolean;
  /** The file did not exist and was created. */
  created: boolean;
  /** Key-level lines (`+ key`, `- key`, `~ key`); never a value. */
  diff: string[];
  /** The file as it was before Oort first changed it (written once, never overwritten). */
  backup?: string;
  /** The file as it was just before this change. */
  previous?: string;
  /** How the entry was written: Oort's own file edit, or `claude mcp add/remove --scope user`. */
  via?: 'file' | 'claude-cli';
}

/** Dotted key paths of every leaf under `v`, prefixed with `prefix`. */
function leaves(v: unknown, prefix: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (isObject(v)) {
    for (const [k, x] of Object.entries(v))
      for (const [p, y] of leaves(x, `${prefix}.${k}`)) out.set(p, y);
    if (Object.keys(v).length === 0) out.set(prefix, {});
  } else if (v !== undefined) {
    out.set(prefix, v);
  }
  return out;
}

function keyDiff(before: unknown, after: unknown, prefix: string): string[] {
  const a = leaves(before, prefix);
  const b = leaves(after, prefix);
  const lines: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) lines.push(`+ ${k}`);
    else if (!isDeepStrictEqual(a.get(k), v)) lines.push(`~ ${k}`);
  }
  for (const k of a.keys()) if (!b.has(k)) lines.push(`- ${k}`);
  return lines;
}

interface Loaded {
  text: string;
  existed: boolean;
  mode: number;
}

function load(file: string): Loaded {
  try {
    return {
      text: fs.readFileSync(file, 'utf8'),
      existed: true,
      mode: fs.statSync(file).mode & 0o777,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { text: '', existed: false, mode: 0o600 };
    throw e;
  }
}

const backupPath = (file: string): string => `${file}.oort-backup`;
const previousPath = (file: string): string => `${file}.oort-prev`;

function copyOwnerOnly(from: string, to: string): void {
  fs.copyFileSync(from, to);
  if (process.platform !== 'win32') fs.chmodSync(to, 0o600);
}

/** Replaces `file` (its target, when it is a symlink) atomically, keeping its mode. */
function save(file: string, data: string, loaded: Loaded): Pick<Change, 'backup' | 'previous'> {
  const out: Pick<Change, 'backup' | 'previous'> = {};
  if (loaded.existed) {
    if (!fs.existsSync(backupPath(file))) copyOwnerOnly(file, backupPath(file));
    copyOwnerOnly(file, previousPath(file));
    out.backup = backupPath(file);
    out.previous = previousPath(file);
  } else {
    // Only a missing directory is created; an existing one keeps its permissions.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const target = loaded.existed ? fs.realpathSync(file) : file;
  const tmp = `${target}.oort-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', loaded.mode);
  try {
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
      if (process.platform !== 'win32') fs.fchmodSync(fd, loaded.mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return out;
}

/** The servers-map key existed in the pre-Oort original (the backup). No backup: Oort created the file. */
function originalHadKey(file: string, read: (text: string) => Json, key: string): boolean {
  try {
    return key in read(fs.readFileSync(backupPath(file), 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- JSON hosts

const readJson =
  (file: string) =>
  (text: string): Json => {
    if (text.trim() === '') return {};
    const errors: ParseError[] = [];
    const v: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      throw new Refusal(
        `${file} is not valid JSON (${first === undefined ? 'parse error' : `${printParseErrorCode(first.error)} at offset ${first.offset}`}); fix it, then run this again.`,
      );
    }
    if (!isObject(v)) throw new Refusal(`${file} is not a JSON object; not changed.`);
    return v;
  };

interface Style {
  /** One indentation level, as the file already uses it (default two spaces). */
  unit: string;
  eol: string;
}

function styleOf(text: string): Style {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m?.[1] ?? '  ';
  return { unit: indent.startsWith('\t') ? '\t' : indent, eol };
}

/** `value` as JSON whose first line sits at `depth` levels (later lines are indented to match). */
const pretty = (value: unknown, depth: number, s: Style): string =>
  JSON.stringify(value, null, s.unit)
    .split('\n')
    .join(s.eol + s.unit.repeat(depth));

const propertyNamed = (obj: Node, name: string): Node | undefined =>
  obj.children?.find((p) => p.children?.[0]?.value === name);

/**
 * The edit that sets `name` to `value` in object `obj`, whose properties sit
 * at `depth`. Only the property's own text is written; siblings are not reflowed.
 */
function setProperty(obj: Node, name: string, value: unknown, depth: number, s: Style): Edit {
  const existing = propertyNamed(obj, name)?.children?.[1];
  if (existing !== undefined) {
    return { offset: existing.offset, length: existing.length, content: pretty(value, depth, s) };
  }
  const line = `${s.eol}${s.unit.repeat(depth)}${JSON.stringify(name)}: ${pretty(value, depth, s)}`;
  const props = obj.children ?? [];
  const last = props[props.length - 1];
  if (last === undefined) {
    // `{}` or `{ }`: replace the inside.
    return {
      offset: obj.offset + 1,
      length: obj.length - 2,
      content: `${line}${s.eol}${s.unit.repeat(depth - 1)}`,
    };
  }
  return { offset: last.offset + last.length, length: 0, content: `,${line}` };
}

/** The edit that removes property `name` from `obj`, with its separating comma. */
function removeProperty(obj: Node, name: string): Edit | undefined {
  const props = obj.children ?? [];
  const i = props.findIndex((p) => p.children?.[0]?.value === name);
  const p = props[i];
  if (p === undefined) return undefined;
  if (props.length === 1) return { offset: obj.offset + 1, length: obj.length - 2, content: '' };
  const prev = props[i - 1];
  if (prev !== undefined) {
    const from = prev.offset + prev.length;
    return { offset: from, length: p.offset + p.length - from, content: '' };
  }
  const next = props[i + 1] as Node;
  return { offset: p.offset, length: next.offset - p.offset, content: '' };
}

export interface ChangeOptions {
  /** Work out the change and its diff, but write nothing. */
  dryRun?: boolean;
}

function jsonChange(
  host: Host,
  action: 'connect' | 'disconnect',
  file: string,
  cmd: string,
  opts: ChangeOptions,
): Change {
  const loaded = load(file);
  const read = readJson(file);
  const cfg = read(loaded.text);
  const key = serversKey(host);
  const servers = cfg[key];
  if (servers !== undefined && !isObject(servers)) {
    throw new Refusal(`${file}: "${key}" is not an object; not changed.`);
  }
  const current = servers?.[SERVER_NAME];
  const result: Change = { host, action, file, changed: false, created: false, diff: [] };
  if (current !== undefined && !isOurs(host, current, cmd)) {
    throw new Refusal(
      `${file} already has an MCP server named "${SERVER_NAME}" that oort did not write; remove or rename it, then run this again.`,
    );
  }
  const want = action === 'connect' ? serverEntry(host, cmd) : undefined;
  if (same(current, want)) return result;
  const style = styleOf(loaded.text);
  const base = loaded.text.trim() === '' ? '{}' : loaded.text;
  const root = parseTree(base) as Node;
  const serversNode = findNodeAtLocation(root, [key]);
  let edit: Edit | undefined;
  if (want !== undefined) {
    edit =
      serversNode === undefined
        ? setProperty(root, key, { [SERVER_NAME]: want }, 1, style)
        : setProperty(serversNode, SERVER_NAME, want, 2, style);
  } else if (serversNode !== undefined) {
    // A servers map Oort created goes again once it would be empty.
    const created = Object.keys(servers ?? {}).length === 1 && !originalHadKey(file, read, key);
    edit = created ? removeProperty(root, key) : removeProperty(serversNode, SERVER_NAME);
  }
  let text = edit === undefined ? base : applyEdits(base, [edit]);
  if (loaded.text.trim() === '' && !text.endsWith(style.eol)) text += style.eol;
  // Prove the edit touched nothing but our entry.
  const after = read(text);
  const { [SERVER_NAME]: _ours, ...others } = (isObject(after[key]) ? after[key] : {}) as Json;
  const { [SERVER_NAME]: _was, ...othersBefore } = (servers ?? {}) as Json;
  const { [key]: _s1, ...restAfter } = after;
  const { [key]: _s2, ...restBefore } = cfg;
  if (!isDeepStrictEqual(others, othersBefore) || !isDeepStrictEqual(restAfter, restBefore)) {
    throw new Refusal(`Could not edit ${file} safely; add the entry by hand (see docs/cli.md).`);
  }
  Object.assign(result, opts.dryRun === true ? {} : save(file, text, loaded), {
    changed: true,
    created: !loaded.existed,
    diff: keyDiff(current, want, `${key}.${SERVER_NAME}`),
    via: 'file',
  });
  return result;
}

// ---------------------------------------------------------------- Claude Code CLI

/** The `claude` executable on `PATH`, if any (not on Windows, where it is a `.cmd` shim). */
export function claudeOnPath(hc: HostContext): string | undefined {
  if (hc.platform === 'win32') return undefined;
  for (const dir of (hc.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'claude');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Claude Code rewrites `~/.claude.json` itself, so when its CLI is on PATH
 * the entry goes through `claude mcp add --scope user` (and `remove`) rather
 * than a file edit that a running Claude Code could overwrite. Oort still
 * reads the file first, to refuse an entry it did not write and to print the
 * diff, and backs it up before `claude` runs.
 */
function claudeCliChange(
  action: 'connect' | 'disconnect',
  file: string,
  cmd: string,
  claude: string,
  hc: HostContext,
  opts: ChangeOptions,
): Change {
  const host: Host = 'claude-code';
  const loaded = load(file);
  const read = readJson(file);
  const cfg = read(loaded.text);
  const servers = cfg['mcpServers'];
  if (servers !== undefined && !isObject(servers)) {
    throw new Refusal(`${file}: "mcpServers" is not an object; not changed.`);
  }
  const current = servers?.[SERVER_NAME];
  const result: Change = {
    host,
    action,
    file,
    changed: false,
    created: false,
    diff: [],
    via: 'claude-cli',
  };
  if (current !== undefined && !isOurs(host, current, cmd)) {
    throw new Refusal(
      `${file} already has an MCP server named "${SERVER_NAME}" that oort did not write; remove or rename it, then run this again.`,
    );
  }
  const want = action === 'connect' ? serverEntry(host, cmd) : undefined;
  if (same(current, want)) return result;
  const diff = keyDiff(
    isObject(current) ? withoutEmptyEnv(current) : current,
    want,
    `mcpServers.${SERVER_NAME}`,
  );
  Object.assign(result, { changed: true, created: !loaded.existed, diff });
  if (opts.dryRun === true) return result;
  if (loaded.existed) {
    if (!fs.existsSync(backupPath(file))) copyOwnerOnly(file, backupPath(file));
    copyOwnerOnly(file, previousPath(file));
    result.backup = backupPath(file);
    result.previous = previousPath(file);
  }
  const entryArgs = serverEntry(host, cmd)['args'] as string[];
  const run = (args: string[]): void => {
    const r = spawnSync(claude, args, {
      env: hc.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 60_000,
    });
    if (r.status !== 0) {
      throw new Refusal(
        `\`claude ${args.slice(0, 5).join(' ')}\` failed (${r.status === null ? (r.error?.name ?? 'signal') : `exit ${r.status}`}); run it yourself: claude mcp add --scope user ${SERVER_NAME} -- ${cmd} ${entryArgs.join(' ')}`,
      );
    }
  };
  if (current !== undefined) run(['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  if (want !== undefined)
    run(['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', cmd, ...entryArgs]);
  // Check that claude wrote what we meant.
  const after = read(load(file).text)['mcpServers'];
  if (!same(isObject(after) ? after[SERVER_NAME] : undefined, want)) {
    throw new Refusal(
      `\`claude mcp\` did not leave the expected oort entry in ${file}; check \`claude mcp list\`.`,
    );
  }
  return result;
}

// ---------------------------------------------------------------- Codex TOML

/** Plain data: smol-toml builds null-prototype objects and TomlDate values. */
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

const readToml =
  (file: string) =>
  (text: string): Json => {
    try {
      return plain(parseToml(text));
    } catch (e) {
      const line = (e as { line?: number }).line;
      throw new Refusal(
        `${file} is not valid TOML${line !== undefined ? ` (line ${line})` : ''}; fix it, then run this again.`,
      );
    }
  };

const TABLE_HEADER = /^\s*\[/;
const OORT_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:oort|"oort"|'oort')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;

/**
 * Line ranges `[start, end)` of `[mcp_servers.oort]` and its sub-tables:
 * from the header to the next table header, not counting the blank lines
 * just before that header.
 */
function oortBlocks(lines: string[]): [number, number][] {
  const blocks: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OORT_HEADER.test(lines[i] ?? '')) continue;
    let end = i + 1;
    while (end < lines.length && !TABLE_HEADER.test(lines[end] ?? '')) end++;
    while (end > i + 1 && (lines[end - 1] ?? '').trim() === '') end--;
    blocks.push([i, end]);
    i = end - 1;
  }
  return blocks;
}

function tomlChange(
  action: 'connect' | 'disconnect',
  file: string,
  cmd: string,
  opts: ChangeOptions,
): Change {
  const host: Host = 'codex';
  const loaded = load(file);
  const read = readToml(file);
  const cfg = read(loaded.text);
  const servers = cfg['mcp_servers'];
  if (servers !== undefined && !isObject(servers)) {
    throw new Refusal(`${file}: "mcp_servers" is not a table; not changed.`);
  }
  const current = servers?.[SERVER_NAME];
  const result: Change = { host, action, file, changed: false, created: false, diff: [] };
  if (current !== undefined && !isOurs(host, current, cmd)) {
    throw new Refusal(
      `${file} already has an MCP server named "${SERVER_NAME}" that oort did not write; remove or rename it, then run this again.`,
    );
  }
  const want = action === 'connect' ? serverEntry(host, cmd) : undefined;
  if (same(current, want)) return result;

  const eol = loaded.text.includes('\r\n') ? '\r\n' : '\n';
  const lines = loaded.text.split(/\r?\n/);
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  const block =
    want === undefined
      ? []
      : stringifyToml({ mcp_servers: { [SERVER_NAME]: want } })
          .trimEnd()
          .split('\n');
  const blocks = oortBlocks(lines);
  let next: string[];
  if (blocks.length === 0) {
    next =
      lines.length === 0 || want === undefined ? [...lines, ...block] : [...lines, '', ...block];
  } else {
    next = [...lines];
    for (const [start, end] of [...blocks].reverse()) {
      const replacement = start === blocks[0]?.[0] ? block : [];
      next.splice(start, end - start, ...replacement);
      // A block removed from the end takes its separating blank line with it.
      if (
        replacement.length === 0 &&
        start === next.length &&
        (next[start - 1] ?? '').trim() === ''
      ) {
        next.splice(start - 1, 1);
      }
    }
  }
  const text =
    next.length === 0 ? '' : next.join(eol) + (trailingNewline || !loaded.existed ? eol : '');
  // Prove the edit touched nothing but our entry (an inline or dotted-key
  // `oort` entry cannot be edited as a block, so it fails here).
  const after = read(text);
  const expected: Json = { ...cfg };
  const nextServers: Json = { ...servers };
  if (want === undefined) delete nextServers[SERVER_NAME];
  else nextServers[SERVER_NAME] = want;
  if (Object.keys(nextServers).length > 0) expected['mcp_servers'] = nextServers;
  else delete expected['mcp_servers'];
  if (!isDeepStrictEqual(after, expected)) {
    throw new Refusal(
      `${file} defines mcp_servers.${SERVER_NAME} in a form oort cannot edit as a block; edit [mcp_servers.${SERVER_NAME}] by hand (see docs/cli.md).`,
    );
  }
  Object.assign(result, opts.dryRun === true ? {} : save(file, text, loaded), {
    changed: true,
    created: !loaded.existed,
    diff: keyDiff(current, want, `mcp_servers.${SERVER_NAME}`),
    via: 'file',
  });
  return result;
}

/** Adds (or updates) the `oort` MCP entry in `host`'s user config. Idempotent. */
export function connectHost(
  host: Host,
  hc: HostContext,
  cmd: string,
  opts: ChangeOptions = {},
): Change {
  const file = hostConfigPath(host, hc);
  const claude = host === 'claude-code' ? claudeOnPath(hc) : undefined;
  if (claude !== undefined) return claudeCliChange('connect', file, cmd, claude, hc, opts);
  return host === 'codex'
    ? tomlChange('connect', file, cmd, opts)
    : jsonChange(host, 'connect', file, cmd, opts);
}

/** Removes the `oort` MCP entry Oort wrote; a missing file or entry changes nothing. */
export function disconnectHost(
  host: Host,
  hc: HostContext,
  cmd: string,
  opts: ChangeOptions = {},
): Change {
  const file = hostConfigPath(host, hc);
  if (!fs.existsSync(file)) {
    return { host, action: 'disconnect', file, changed: false, created: false, diff: [] };
  }
  const claude = host === 'claude-code' ? claudeOnPath(hc) : undefined;
  if (claude !== undefined) return claudeCliChange('disconnect', file, cmd, claude, hc, opts);
  return host === 'codex'
    ? tomlChange('disconnect', file, cmd, opts)
    : jsonChange(host, 'disconnect', file, cmd, opts);
}

export interface HostStatus {
  host: Host;
  file: string;
  /**
   * `connected`: Oort's entry for this bin. `outdated`: Oort's entry, from
   * another install path or an older version. `broken`: Oort's entry, whose
   * command is not an executable file. `absent`: no `oort` entry (or no
   * file). `foreign`: an `oort` entry Oort did not write. `invalid`: the file
   * cannot be read as its format.
   */
  state: 'connected' | 'outdated' | 'broken' | 'absent' | 'foreign' | 'invalid';
  /** `outdated` only: the entry names no `--agent` (written before agents existed). */
  noAgent?: true;
  /**
   * `outdated` only: the entry is exactly what `oort connect` writes, but for another binary,
   * this one (another copy of oort, such as one `--this-copy` wrote).
   */
  otherCopy?: string;
  /** `connected` only: the binary the entry runs (doctor judges it: PR #78). */
  command?: string;
  /** Why the file is `invalid` (holds no config values). */
  message?: string;
}

const executable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Read-only: the state of `host`'s `oort` entry, for `oort doctor`. `cmd` is this bin, if known. */
export function inspectHost(host: Host, hc: HostContext, cmd?: string): HostStatus {
  const file = hostConfigPath(host, hc);
  const status = (state: HostStatus['state'], message?: string): HostStatus => ({
    host,
    file,
    state,
    ...(message !== undefined && { message }),
  });
  let loaded: Loaded;
  try {
    loaded = load(file);
  } catch (e) {
    return status(
      'invalid',
      `${file} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
  if (!loaded.existed) return status('absent');
  let cfg: Json;
  try {
    cfg = (host === 'codex' ? readToml(file) : readJson(file))(loaded.text);
  } catch (e) {
    if (e instanceof Refusal) return status('invalid', e.message);
    throw e;
  }
  const servers = cfg[serversKey(host)];
  if (servers !== undefined && !isObject(servers)) {
    return status(
      'invalid',
      `${file}: "${serversKey(host)}" is not ${host === 'codex' ? 'a table' : 'an object'}.`,
    );
  }
  const entry = servers?.[SERVER_NAME];
  if (entry === undefined) return status('absent');
  const command = isObject(entry) && typeof entry['command'] === 'string' ? entry['command'] : '';
  // Without this bin's path, only an oort-looking path counts as ours (never "\0").
  if (!isOurs(host, entry, cmd ?? '\u0000')) return status('foreign');
  if (!executable(command)) return status('broken');
  if (same(entry, serverEntry(host, cmd ?? command))) return { ...status('connected'), command };
  // An entry from before agents (no --agent) runs as an anonymous, Planet-only agent.
  const args = isObject(entry) && Array.isArray(entry['args']) ? entry['args'] : [];
  return {
    ...status('outdated'),
    ...(!args.includes('--agent') && { noAgent: true }),
    ...(same(entry, serverEntry(host, command)) && { otherCopy: command }),
  };
}
