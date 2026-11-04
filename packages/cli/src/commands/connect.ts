import * as os from 'node:os';
import {
  HOSTS,
  HOST_LABEL,
  connectHost,
  disconnectHost,
  isHost,
  type Change,
  type Host,
  type HostContext,
} from '../connectors.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, echo, tilde, type Ctx } from '../util.js';
import { hookCommandPath } from './install.js';

/** Where the host starts stdio servers, which decides the memory scope. */
function scopeNote(host: Host): string {
  if (host === 'vscode') return 'the workspace folder VS Code starts it in, plus global memories';
  if (host === 'claude-desktop')
    return 'the directory Claude Desktop starts it in (not a project, so usually global)';
  return `the directory ${HOST_LABEL[host]} starts it in (usually your project), plus global memories; add "--project", "<dir>" to its args to pin one`;
}

const RELOAD: Record<Host, string> = {
  'claude-code': 'start a new Claude Code session; `/mcp` lists oort',
  'claude-desktop': 'quit and reopen Claude Desktop',
  codex: 'start a new Codex session; `codex mcp list` shows oort',
  cursor: 'reload Cursor; Settings > MCP lists oort',
  gemini: 'restart Gemini CLI; `/mcp` lists oort',
  vscode: 'run "MCP: List Servers" and start oort',
};

export function hostContext(ctx: Ctx): HostContext {
  return { home: ctx.io.env['HOME'] || os.homedir(), env: ctx.io.env, platform: process.platform };
}

export function hostArgs(args: string[]): Host[] {
  const hosts: Host[] = [];
  for (const a of args) {
    if (!isHost(a)) {
      throw new Refusal(
        `unknown host ${echo(a)}; expected one of ${HOSTS.join(', ')}. ChatGPT and claude.ai web need a remote MCP URL, which arrives with Oort Cloud.`,
      );
    }
    if (!hosts.includes(a)) hosts.push(a);
  }
  return hosts;
}

/** The lines a change prints: header, key diff, what was written and how to undo it. */
export function describeChange(
  ui: Ui,
  c: Change,
  cmd: string,
  opts: { dryRun?: boolean; home?: string } = {},
): string {
  const label = HOST_LABEL[c.host];
  const dryRun = opts.dryRun === true;
  const show = (p: string): string => tilde(p, opts.home ?? '');
  let out = ui.header(`${c.action} ${c.host}`, show(c.file));
  if (!c.changed) {
    out +=
      c.action === 'connect'
        ? `${ui.ok(`${label} is already connected; nothing changed.`)}\n`
        : `${ui.ok(`No oort entry in ${label}'s config; nothing changed.`)}\n`;
    return out;
  }
  for (const line of c.diff) {
    out += `${line.startsWith('+') ? ui.green(line) : line.startsWith('-') ? ui.red(line) : ui.yellow(line)}\n`;
  }
  if (dryRun) return `${out}${ui.dim('(dry run: nothing written)')}\n`;
  const rows: [string, string][] = [];
  if (c.action === 'connect') {
    out += `${ui.ok(`${c.created ? 'Created' : 'Updated'} ${show(c.file)}: ${label} starts \`${cmd} mcp\`.`)}\n`;
    rows.push(['scope', scopeNote(c.host)], ['next', RELOAD[c.host]]);
  } else {
    out += `${ui.ok(`Removed the oort entry from ${show(c.file)}.`)}\n`;
  }
  if (c.backup !== undefined)
    rows.push(['backup', `${show(c.backup)} (before Oort first changed it)`]);
  if (c.previous !== undefined)
    rows.push(['previous', `${show(c.previous)} (just before this change)`]);
  rows.push([
    'undo',
    c.action === 'connect' ? `oort disconnect ${c.host}` : `oort connect ${c.host}`,
  ]);
  return out + ui.kv(rows, { indent: 2 });
}

/** `oort connect <host...> [--dry-run]` / `oort disconnect <host...> [--dry-run]` */
export async function connectCommand(
  action: 'connect' | 'disconnect',
  args: string[],
  opts: { dryRun?: boolean },
  ctx: Ctx,
): Promise<number> {
  const hosts = hostArgs(args);
  // Disconnect also removes an entry from an older install path, so it never needs the bin.
  let cmd: string;
  try {
    cmd = hookCommandPath(ctx.io.entry);
  } catch (e) {
    if (action === 'connect') throw e;
    cmd = 'oort';
  }
  const hc = hostContext(ctx);
  const ui = uiFor(ctx.io);
  const dryRun = opts.dryRun === true;
  for (const host of hosts) {
    const c =
      action === 'connect'
        ? connectHost(host, hc, cmd, { dryRun })
        : disconnectHost(host, hc, cmd, { dryRun });
    ctx.io.out(describeChange(ui, c, cmd, { dryRun, home: hc.home }));
  }
  return 0;
}
