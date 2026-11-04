import { Command, CommanderError } from 'commander';
import { VERSION } from '@oortmem/core';
import { connectCommand } from './commands/connect.js';
import { doctorCommand } from './commands/doctor.js';
import { consolidateCommand } from './commands/consolidate.js';
import { explainCommand } from './commands/explain.js';
import { exportCommand } from './commands/export.js';
import { forgetCommand } from './commands/forget.js';
import { hookCommand } from './commands/hook.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { keysListCommand, keysRmCommand, keysSetCommand } from './commands/keys.js';
import { loginCommand, logoutCommand, type LoginDeps } from './commands/login.js';
import { inspectCommand } from './commands/inspect.js';
import { installCommand } from './commands/install.js';
import { mcpCommand } from './commands/mcp.js';
import { observeCommand } from './commands/observe.js';
import { pinCommand } from './commands/pin.js';
import { projectLinkCommand, projectUnlinkCommand } from './commands/project.js';
import { recallCommand } from './commands/recall.js';
import { setupCommand, type SetupOptions } from './commands/setup.js';
import { statsCommand } from './commands/stats.js';
import type { Io } from './io.js';
import { keychainFor, type Keychain } from './keychain.js';
import {
  cloudExportCommand,
  cloudImportCommand,
  cloudStatusCommand,
  cloudUseCommand,
} from './commands/cloud.js';
import { Refusal, echo, type Ctx } from './util.js';
import { wire as defaultWire, type WireFn } from './wire.js';

function program(ctx: Ctx, setCode: (code: number) => void): Command {
  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<number | void>) =>
    async (...args: A): Promise<void> => {
      const code = await fn(...args);
      if (typeof code === 'number') setCode(code);
    };
  const p = new Command('oort')
    .description('Oort: tiered memory for coding agents.')
    .version(VERSION)
    .option('--debug', 'print stack traces for unexpected errors')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.io.out(s),
      writeErr: (s) => ctx.io.err(s),
      // Commander quotes the offending argument ('…'): scrub and clip it like our own refusals.
      outputError: (s, write) => write(s.replace(/'([^'\n]*)'/g, (_m, a: string) => echo(a))),
    })
    .showHelpAfterError('(run `oort --help` for usage)');

  p.command('setup')
    .description('interactive setup: agents, keys, connect, import, a quick check')
    .option('--yes', 'never ask: take every choice from the flags (detected agents by default)')
    .option('--agents <list>', 'detected, none, or a comma list: claude-code,codex,cursor,…')
    .option('--keys <mode>', 'byo, pro or skip')
    .option('--import <age>', 'skip, or import Claude Code sessions from this age: 14d, 30d')
    .option('--no-demo', 'skip the remember, recall and forget check')
    .option(
      '--install-global',
      'under npx: run `npm i -g oortmem` first (agents need a stable path)',
    )
    .action(run((o: SetupOptions) => setupCommand(o, ctx)));

  p.command('init')
    .description('write ~/.oort/config.json with defaults (never overwrites)')
    .option('--project', 'also write oort.config.json at the git root')
    .action(run((o: { project?: boolean }) => initCommand(o, ctx)));

  p.command('install')
    .description('install the Claude Code hooks')
    .argument('<harness>', 'claude-code')
    .option('--project', 'use <cwd>/.claude/settings.json instead of ~/.claude/settings.json')
    .action(run((h: string, o: { project?: boolean }) => installCommand('install', h, o, ctx)));

  p.command('uninstall')
    .description('remove the Claude Code hooks')
    .argument('<harness>', 'claude-code')
    .option('--project', 'use <cwd>/.claude/settings.json instead of ~/.claude/settings.json')
    .action(run((h: string, o: { project?: boolean }) => installCommand('uninstall', h, o, ctx)));

  p.command('connect')
    .description('add the oort MCP server to an agent host (backs up the file, prints the diff)')
    .argument('<hosts...>', 'claude-desktop, claude-code, codex, cursor, gemini or vscode')
    .option('--dry-run', 'print the diff without writing')
    .action(
      run((hosts: string[], o: { dryRun?: boolean }) => connectCommand('connect', hosts, o, ctx)),
    );

  p.command('disconnect')
    .description("remove the oort MCP server from an agent host's config")
    .argument('<hosts...>', 'claude-desktop, claude-code, codex, cursor, gemini or vscode')
    .option('--dry-run', 'print the diff without writing')
    .action(
      run((hosts: string[], o: { dryRun?: boolean }) =>
        connectCommand('disconnect', hosts, o, ctx),
      ),
    );

  p.command('hook')
    .description('run a Claude Code hook (reads the hook JSON on stdin; always exits 0)')
    .argument('<event>', 'UserPromptSubmit | Stop | SessionStart | drain')
    .allowExcessArguments()
    .action(run((event: string) => hookCommand(event, ctx)));

  p.command('mcp')
    .description(
      'run the local MCP server on stdin/stdout (agent hosts start it; see `oort connect`)',
    )
    .option('--project <dir>', 'scope to this directory instead of the one the host starts it in')
    .action(run((o: { project?: string }) => mcpCommand(o, ctx)));

  p.command('recall')
    .description('recall memories for a query, as injected into the prompt')
    .argument('<text>')
    .option('--json', 'print the full RecallResult as JSON')
    .option('--as-of <iso>', 'recall what was true at this time')
    .action(run((t: string, o: { json?: boolean; asOf?: string }) => recallCommand(t, o, ctx)));

  p.command('explain')
    .description("recall with each stage's ranks and scores")
    .argument('<query>')
    .option('--json', 'print each memory with its ranks and scores, and the timings, as JSON')
    .action(run((q: string, o: { json?: boolean }) => explainCommand(q, o, ctx)));

  p.command('observe')
    .description('run the write path on one observation (JSON on stdin, or --user/--assistant)')
    .option('--user <text>', 'the user turn')
    .option('--assistant <text>', 'the assistant turn')
    .option('--dry-run', 'only report what the scrubber would redact; touches nothing')
    .action(
      run((o: { user?: string; assistant?: string; dryRun?: boolean }) => observeCommand(o, ctx)),
    );

  p.command('inspect')
    .description('list current memories, or show one in full with its supersede chain')
    .argument('[id]', 'memory id or unique prefix')
    .option('--json', 'print JSON')
    .option('--limit <n>', 'rows to list', '50')
    .action(
      run((id: string | undefined, o: { json?: boolean; limit?: string }) =>
        inspectCommand(id, o, ctx),
      ),
    );

  p.command('stats')
    .description('counts per tier and validity, store sizes, queue, memory use')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => statsCommand(o, ctx)));

  p.command('consolidate')
    .description('expire, re-tier and evict memories')
    .action(run(() => consolidateCommand(ctx)));

  p.command('forget')
    .description('delete a memory everywhere')
    .argument('<id>', 'memory id or unique prefix')
    .option('--yes', 'do not ask')
    .action(run((id: string, o: { yes?: boolean }) => forgetCommand(id, o, ctx)));

  p.command('pin')
    .description('pin a memory (never sent to cold)')
    .argument('<id>', 'memory id or unique prefix')
    .action(run((id: string) => pinCommand(id, true, ctx)));

  p.command('unpin')
    .description('unpin a memory')
    .argument('<id>', 'memory id or unique prefix')
    .action(run((id: string) => pinCommand(id, false, ctx)));

  const project = p
    .command('project')
    .description('trust a project id for this repository (oort.config.json project.id)');
  project
    .command('link')
    .description('bind this repository to its configured project id, or to --id')
    .option('--id <id>', 'the project id to bind (default: project.id in oort.config.json)')
    .action(run((o: { id?: string }) => projectLinkCommand(o, ctx)));
  project
    .command('unlink')
    .description("remove this repository's binding (back to the derived id)")
    .action(run(() => projectUnlinkCommand(ctx)));

  const cloud = p
    .command('cloud')
    .description('Oort Cloud (Oort Pro): keep memories in your account instead of on this machine');
  cloud
    .command('use')
    .description('use Oort Cloud for hooks, MCP and every command (needs oort login and Pro)')
    .option('--local', 'switch back to the local store on this machine')
    .action(run((o: { local?: boolean }) => cloudUseCommand(o, ctx)));
  cloud
    .command('status')
    .description('which store this machine uses, the account, and import progress')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => cloudStatusCommand(o, ctx)));
  cloud
    .command('import')
    .description('upload the local store to Oort Cloud (resumable; safe to run again)')
    .option('--dry-run', 'show what would be uploaded and stop')
    .option('--yes', 'do not ask before uploading')
    .action(run((o: { dryRun?: boolean; yes?: boolean }) => cloudImportCommand(o, ctx)));
  cloud
    .command('export')
    .description('download every memory in your Oort Cloud account (v1 export format)')
    .option('--out <file>', 'write to a new file (0600) instead of stdout')
    .option('--force', 'with --out, overwrite an existing file (never a symlink)')
    .action(run((o: { out?: string; force?: boolean }) => cloudExportCommand(o, ctx)));

  p.command('doctor')
    .description(
      'check keys, hooks, MCP connectors, the store and the relay, with a fix per problem',
    )
    .option('--json', 'print every check as JSON')
    .action(run((o: { json?: boolean }) => doctorCommand(o, ctx)));

  p.command('login')
    .description(
      'sign in to Oort Pro in the browser and keep the Oort key in the Keychain (macOS) or credentials.json',
    )
    .option('--no-browser', 'print the sign-in URL instead of opening the browser')
    .action(run((o: { browser?: boolean }) => loginCommand(o, ctx)));

  p.command('logout')
    .description('remove the stored Oort key (it does not revoke the key)')
    .action(run(() => logoutCommand(ctx)));

  const keys = p
    .command('keys')
    .description(
      'provider keys in the macOS Keychain, or credentials.json elsewhere (voyage, typesafe, anthropic, oort)',
    );
  keys
    .command('set')
    .description('store a key; it is prompted for with the input hidden (never in argv or history)')
    .argument('<provider>', 'voyage, typesafe, anthropic or oort')
    .action(run((provider: string) => keysSetCommand(provider, ctx)));
  keys
    .command('list')
    .description('where each key comes from: keychain, env or missing (never the value)')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => keysListCommand(o, ctx)));
  keys
    .command('rm')
    .description('delete a stored key')
    .argument('<provider>', 'voyage, typesafe, anthropic or oort')
    .action(run((provider: string) => keysRmCommand(provider, ctx)));

  p.command('import')
    .description('import existing Claude Code transcripts (estimates first, then asks)')
    .argument('<harness>', 'claude-code')
    .option('--since <age>', 'only transcripts modified within this age: 12h, 30d, 2w')
    .option('--yes', 'do not ask before importing')
    .option('--estimate-only', 'print the estimate and stop')
    .option('--include-unresolved', 'import sessions whose project is gone as global memories')
    .option('--projects-dir <dir>', 'Claude Code projects directory (default ~/.claude/projects)')
    .action(
      run(
        async (
          harness: string,
          o: {
            since?: string;
            yes?: boolean;
            estimateOnly?: boolean;
            includeUnresolved?: boolean;
            projectsDir?: string;
          },
        ) => {
          if (harness !== 'claude-code') {
            throw new Refusal(`unknown harness ${echo(harness)}; Phase 1 supports claude-code.`);
          }
          return importCommand(o, ctx);
        },
      ),
    );

  p.command('export')
    .description('write every visible memory in the v1 export format (docs/export-format.md)')
    .option('--out <file>', 'write to a new file (0600) instead of stdout')
    .option('--force', 'with --out, overwrite an existing file (never a symlink)')
    .option('--json', 'accepted for compatibility; the format is always JSON Lines')
    .action(run((o: { out?: string; force?: boolean }) => exportCommand(o, ctx)));

  return p;
}

/**
 * Runs the CLI on `args` (user arguments, without node and the script) and
 * resolves the exit code: 0 success, 1 unexpected error (message only; the
 * stack with --debug), 2 refusal or usage problem. Never prints a key: error
 * messages come from our own refusals or from adapters that never include one.
 */
export async function runCli(
  args: string[],
  io: Io,
  wire: WireFn = defaultWire,
  keychain: Keychain = keychainFor(io.env, {
    warn: (m) => io.err(`oort: ${m}\n`),
    promptSecret: (q) => io.askSecret(q),
  }),
  deps: { login?: LoginDeps; fetch?: typeof fetch } = {},
): Promise<number> {
  let code = 0;
  const p = program({ io, wire, keychain, ...deps }, (c) => {
    code = c;
  });
  try {
    await p.parseAsync(args, { from: 'user' });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    if (e instanceof Refusal) {
      io.err(`oort: ${e.message}\n`);
      return 2;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    io.err(`oort: ${err.message}\n`);
    if (args.includes('--debug') && err.stack !== undefined) io.err(`${err.stack}\n`);
    return 1;
  }
}
