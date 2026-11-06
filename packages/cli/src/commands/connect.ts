import * as os from 'node:os';
import { agentHome, resolveHome, setAgentStar } from '@oortmem/core';
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
import { readCloudSettings } from '../cloud.js';
import { emit, jsonMode } from '../output.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, echo, tilde, type Ctx } from '../util.js';
import { hookCommandPath } from './install.js';

/** Where the host starts stdio servers, which decides the memory scope. */
function scopeNote(host: Host): string {
  if (host === 'vscode' || host === 'cursor') {
    return `the open workspace folder (${HOST_LABEL[host]} fills in --project \${workspaceFolder}), plus global memories`;
  }
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
        `Unknown host ${echo(a)}; expected one of ${HOSTS.join(', ')}. ChatGPT and claude.ai web need a remote MCP URL, which arrives with Oort Cloud.`,
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
    const how = c.via === 'claude-cli' ? ' (through `claude mcp add --scope user`)' : '';
    out += `${ui.ok(`${c.created ? 'Created' : 'Updated'} ${show(c.file)}${how}: ${label} starts \`${cmd} mcp\`.`)}\n`;
    rows.push(['scope', scopeNote(c.host)], ['next', RELOAD[c.host]]);
  } else {
    const how = c.via === 'claude-cli' ? ' (through `claude mcp remove --scope user`)' : '';
    out += `${ui.ok(`Removed the oort entry from ${show(c.file)}${how}.`)}\n`;
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

/**
 * The memory lines `connect` prints for a host (CON-62): it acts as its own agent, reads the
 * person's Planet and its own Star, and writes new memories to one of them.
 */
function memoryRows(host: Host, star: boolean): [string, string][] {
  return [
    ['agent', `${host} (reads your Planet and its own Star; no other agent reads that Star)`],
    [
      'memory',
      star
        ? `new memories stay in Star ${host}, private to ${HOST_LABEL[host]} (\`oort connect ${host} --no-star\` to share them on your Planet)`
        : `new memories go to your Planet, shared by your agents (\`oort connect ${host} --star\` to keep them private)`,
    ],
  ];
}

/**
 * `oort connect <host...> [--dry-run] [--star | --no-star]` /
 * `oort disconnect <host...> [--dry-run]`. `--star` records in `$OORT_HOME/agents.json` that the
 * host's new memories stay in its own Star; `--no-star` turns that off; neither leaves it.
 */
export async function connectCommand(
  action: 'connect' | 'disconnect',
  args: string[],
  opts: { dryRun?: boolean; star?: boolean },
  ctx: Ctx,
): Promise<number> {
  const hosts = hostArgs(args);
  if (action === 'connect' && opts.star === true) {
    // Oort Cloud has no Stars yet: a Star agent there would save to the shared Planet.
    if (readCloudSettings(resolveHome(ctx.io.env)).store === 'cloud') {
      throw new Refusal(
        'This machine uses Oort Cloud, which has no Stars yet: --star would have nowhere private to save. Run `oort cloud use --local` first, or connect without --star.',
        { code: 'refused' },
      );
    }
  }
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
  const oortHome = resolveHome(ctx.io.env);
  const changes: Record<string, unknown>[] = [];
  for (const host of hosts) {
    const c =
      action === 'connect'
        ? connectHost(host, hc, cmd, { dryRun })
        : disconnectHost(host, hc, cmd, { dryRun });
    ctx.io.out(describeChange(ui, c, cmd, { dryRun, home: hc.home }));
    changes.push(changeJson(c));
    if (action !== 'connect') continue;
    let star = agentHome(oortHome, host) === 'star';
    if (opts.star !== undefined && opts.star !== star) {
      if (!dryRun) setAgentStar(oortHome, host, opts.star);
      star = opts.star;
      ctx.io.out(
        `${ui.ok(`${HOST_LABEL[host]} ${star ? 'now keeps its new memories in its own Star' : 'now writes new memories to your Planet'}${dryRun ? ' (dry run: not saved)' : ''}.`)}\n`,
      );
    }
    ctx.io.out(ui.kv(memoryRows(host, star), { indent: 2 }));
    changes[changes.length - 1]!['memory'] = star ? 'star' : 'planet';
  }
  if (jsonMode(ctx)) emit(ctx, { action, dryRun, command: cmd, changes });
  return 0;
}

/** A change as `oort.v1` data: the file, whether it changed, the key diff, backups. */
export function changeJson(c: Change): Record<string, unknown> {
  return {
    host: c.host,
    action: c.action,
    file: c.file,
    changed: c.changed,
    created: c.created,
    diff: c.diff,
    backup: c.backup ?? null,
    previous: c.previous ?? null,
    via: c.via ?? 'file',
  };
}
