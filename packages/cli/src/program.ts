import * as fs from 'node:fs';
import * as path from 'node:path';
import { Argument, Command, CommanderError, Option } from 'commander';
import { VERSION, resolveHome } from '@oortmem/core';
import { connectCommand } from './commands/connect.js';
import {
  constellationAdoptCommand,
  constellationAttachCommand,
  constellationCreateCommand,
  constellationDeleteCommand,
  constellationDetachCommand,
  constellationInviteCommand,
  constellationInvitesCommand,
  constellationJoinCommand,
  constellationLeaveCommand,
  constellationListCommand,
  constellationMembersCommand,
  constellationPolicyCommand,
  constellationContestedCommand,
  constellationResolveCommand,
  constellationRemoveCommand,
  constellationRevokeCommand,
  constellationRoleCommand,
  constellationTransferCommand,
} from './commands/constellation.js';
import { galaxyCreateCommand, galaxyListCommand, galaxyMembersCommand } from './commands/galaxy.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand, type UpdateDeps, type UpdateOptions } from './commands/update.js';
import { consolidateCommand } from './commands/consolidate.js';
import { explainCommand } from './commands/explain.js';
import { exportCommand } from './commands/export.js';
import { forgetCommand } from './commands/forget.js';
import { hookCommand } from './commands/hook.js';
import { importCommand, importFileCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import {
  judgeApplyCommand,
  judgeEvalCommand,
  judgeImportCommand,
  judgeConfirmCommand,
  judgeListCommand,
  judgePackExportCommand,
  judgePackImportCommand,
  judgePurgeCommand,
  judgeRecordCommand,
  judgeWithdrawCommand,
  type JudgeApplyOptions,
  type JudgeRecordOptions,
} from './commands/judge.js';
import {
  keysCreateCommand,
  keysListCommand,
  keysRmCommand,
  keysSetCommand,
} from './commands/keys.js';
import { whoamiCommand } from './commands/whoami.js';
import { loginCommand, logoutCommand, type LoginDeps } from './commands/login.js';
import { inspectCommand } from './commands/inspect.js';
import { installCommand } from './commands/install.js';
import { mcpCommand } from './commands/mcp.js';
import {
  modelsListCommand,
  modelsPullCommand,
  modelsRmCommand,
  modelsVerifyCommand,
} from './commands/models.js';
import { observeCommand } from './commands/observe.js';
import { OPEN_TARGETS, openCommand, type OpenDeps, type OpenTarget } from './commands/open.js';
import { linkCommand } from './commands/link.js';
import { pinCommand } from './commands/pin.js';
import {
  projectConstellationCommand,
  projectLinkCommand,
  projectPrivacyCommand,
  projectUnlinkCommand,
} from './commands/project.js';
import { recallCommand, type RecallOptions } from './commands/recall.js';
import { rememberCommand, type RememberOptions } from './commands/remember.js';
import { reembedCommand } from './commands/reembed.js';
import { reindexCommand } from './commands/reindex.js';
import { revalidateCommand } from './commands/revalidate.js';
import { serveCommand, type ServeOptions } from './commands/serve.js';
import { setupCommand, type SetupOptions } from './commands/setup.js';
import { shareCommand } from './commands/share.js';
import { statsCommand } from './commands/stats.js';
import type { Io } from './io.js';
import { keychainFor, type Keychain } from './keychain.js';
import {
  cloudExportCommand,
  cloudImportCommand,
  cloudStatusCommand,
  cloudUseCommand,
} from './commands/cloud.js';
import {
  commandFor,
  commandName,
  commandPath,
  describeError,
  emitted,
  exempt,
  failure,
  flush,
  hasJsonOption,
  jsonFromEnv,
  rerunWith,
  serveActionIn,
  startOutput,
} from './output.js';
import { uiFor } from './ui.js';
import {
  availableUpdate,
  noticeText,
  readUpdateCache,
  requestRefresh,
  updateCheckOff,
} from './update-check.js';
import { Refusal, commanderText, echo, safeJson, shown, type Ctx } from './util.js';
import { wire as defaultWire, type WireFn } from './wire.js';

export function program(ctx: Ctx, setCode: (code: number) => void): Command {
  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<number | void>) =>
    async (...args: A): Promise<void> => {
      const code = await fn(...args);
      if (typeof code === 'number') setCode(code);
      // The contract: in JSON mode every run that does not throw prints its envelope, and only
      // now, after the command and its cleanup (the store closed) have finished.
      const out = ctx.output;
      if (out?.json === true && !emitted(out)) {
        throw new Error(`oort ${out.command} printed no JSON (a bug: please report it).`);
      }
      flush(ctx, typeof code === 'number' ? code : 0);
    };
  const ui = uiFor(ctx.io);
  // The help's banner: the mark beside the wordmark, on a colour terminal only.
  const banner = ui.mark([
    '',
    `${ui.bold(ui.gradient('oort'))}  ${ui.dim(VERSION)}`,
    ui.dim('tiered memory for coding agents'),
    '',
    `${ui.tier('hot')} ${ui.dim('Photosphere')}   ${ui.tier('warm')} ${ui.dim('Kuiper Belt')}   ${ui.tier('cold')} ${ui.dim('Oort Cloud')}`,
  ]);
  const p = new Command('oort')
    .description(banner === '' ? 'Oort: tiered memory for coding agents.' : '')
    .version(VERSION)
    .option('--debug', 'print stack traces for unexpected errors')
    .option(
      '--agent <id>',
      'act as this agent (claude-code, codex, cursor, …): it shares your Planet and has its own Star',
    )
    .hook('preAction', (cmd, action) => {
      const agent = (cmd.opts() as { agent?: string }).agent;
      if (agent !== undefined) ctx.agent = agent;
      // `--json`, or OORT_OUTPUT=json on any command that has `--json` (docs/cli.md, "JSON output").
      // The hook, MCP and a foreground `serve` never print JSON, whatever is set (an explicit
      // --json on a foreground serve is refused by the command, on stderr).
      const opts = action.opts() as { json?: boolean; detach?: boolean };
      const path = commandPath(action);
      const serveAction =
        path === 'serve' ? (action.processedArgs[0] as string | undefined) : undefined;
      const name = commandName(path, serveAction);
      const explicit = opts.json === true;
      const json =
        hasJsonOption(action) &&
        !exempt(name, opts.detach === true) &&
        (explicit || jsonFromEnv(ctx.io.env));
      if (json) action.setOptionValue('json', true);
      startOutput(ctx, name, json, explicit);
    })
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.io.out(s),
      writeErr: (s) => ctx.io.err(s),
      getOutHasColors: () => ui.color,
      getErrHasColors: () => ui.color,
      // Commander quotes the offending argument ('…') or lists excess ones bare: scrub and clip
      // each like our own refusals, and scrub the line.
      outputError: (s, write) => write(commanderText(s)),
    })
    .configureHelp({
      styleTitle: (s) => ui.bold(s),
      styleCommandText: (s) => ui.bold(s),
      styleSubcommandText: (s) => (s === '[command]' ? ui.dim(s) : ui.glow(s)),
      styleOptionText: (s) => (s === '[options]' ? ui.dim(s) : ui.glow(s)),
      styleArgumentText: (s) => ui.dim(s),
    })
    .addHelpText('before', ({ error }) => (error ? '' : banner))
    .showHelpAfterError('(run `oort --help` for usage)');

  p.command('setup')
    .description('interactive setup: agents, keys, connect, import, a quick check')
    .option('--yes', 'never ask: take every choice from the flags (detected agents by default)')
    .option('--agents <list>', 'detected, none, or a comma list: claude-code,codex,cursor,…')
    .option('--keys <mode>', 'byo, pro, local or skip')
    .option('--import <age>', 'skip, or import Claude Code sessions from this age: 14d, 30d')
    .option('--no-demo', 'skip the remember, recall and forget check')
    // Before CON-114: `npm i -g oortmem` under npx. Setup now installs ~/.oort/cli itself.
    .addOption(new Option('--install-global').hideHelp())
    .option(
      '--this-copy',
      'for developers testing their own build: write this copy, even when ~/.oort/cli is there',
    )
    .option('--json', 'print oort.v1 JSON')
    .action(run((o: SetupOptions) => setupCommand(o, ctx)));

  p.command('init')
    .description('write ~/.oort/config.json with defaults (never overwrites)')
    .option('--project', 'also write oort.config.json at the git root')
    .option('--json', 'print oort.v1 JSON')
    .action(run((o: { project?: boolean; json?: boolean }) => initCommand(o, ctx)));

  p.command('install')
    .description(
      'install Oort into a harness: the Claude Code hooks, or the MCP server for any other (as `oort connect`)',
    )
    .argument('<harness>', 'claude-code, codex, cursor, claude-desktop, gemini or vscode')
    .option('--project', 'use <cwd>/.claude/settings.json instead of ~/.claude/settings.json')
    .option(
      '--this-copy',
      'for developers testing their own build: write this copy, even when ~/.oort/cli is there',
    )
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((h: string, o: { project?: boolean; thisCopy?: boolean }) =>
        installCommand('install', h, o, ctx),
      ),
    );

  p.command('uninstall')
    .description('remove the Claude Code hooks, or the MCP server from any other harness')
    .argument('<harness>', 'claude-code, codex, cursor, claude-desktop, gemini or vscode')
    .option('--project', 'use <cwd>/.claude/settings.json instead of ~/.claude/settings.json')
    .option('--json', 'print oort.v1 JSON')
    .action(run((h: string, o: { project?: boolean }) => installCommand('uninstall', h, o, ctx)));

  p.command('connect')
    .description('add the oort MCP server to an agent host (backs up the file, prints the diff)')
    .argument('<hosts...>', 'claude-desktop, claude-code, codex, cursor, gemini or vscode')
    .option('--dry-run', 'print the diff without writing')
    .option('--star', "keep this agent's new memories in its own Star (it still reads your Planet)")
    .option('--no-star', "write this agent's new memories to your Planet again (the default)")
    .option(
      '--this-copy',
      'for developers testing their own build: write this copy, even when ~/.oort/cli is there',
    )
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((hosts: string[], o: { dryRun?: boolean; star?: boolean; thisCopy?: boolean }) =>
        connectCommand('connect', hosts, o, ctx),
      ),
    );

  p.command('disconnect')
    .description("remove the oort MCP server from an agent host's config")
    .argument('<hosts...>', 'claude-desktop, claude-code, codex, cursor, gemini or vscode')
    .option('--dry-run', 'print the diff without writing')
    .option('--json', 'print oort.v1 JSON')
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

  p.command('serve')
    .description(
      'run the local daemon the hooks prefer (a Unix socket; they fall back to in-process without it)',
    )
    .argument('[action]', 'start (the default), status, stop or token')
    .option('--detach', 'start in the background and return')
    .option(
      '--idle <duration>',
      'exit after this long without a request (default serve.idleMinutes, 30m)',
    )
    .option(
      '--listen <address>',
      'service mode: also serve the memory protocol on TCP (127.0.0.1:7807), with a token',
    )
    .option('--behind-tls-proxy', 'service mode: allow a non-loopback address behind a TLS proxy')
    .option('--org <id>', 'service mode: the org every token request acts in (or OORT_SERVE_ORG)')
    .option('--rotate', 'token: replace the existing token file')
    .option(
      '--json',
      'status, stop, token and --detach: print oort.v1 JSON (not a foreground start)',
    )
    .action(run((action: string | undefined, o: ServeOptions) => serveCommand(action, o, ctx)));

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
    .option('--known-at <iso>', 'recall what was believed at this time, corrected facts included')
    .option('--history', 'recall every version of the matching facts, oldest first')
    .option('--include <levels>', 'read only these levels: self, planet, star (comma list)')
    .option('--include-withdrawn', 'also show withdrawn judgments')
    .option('--limit <n>', 'at most this many memories, 1 to 50 (default 10)')
    .option('--speed <speed>', 'full (the default), fast (no rerank) or lexical (no model call)')
    .option('--budget-chars <n>', 'the printed block, at most this many characters')
    .option('--within <path>', 'only memories at this place or below it (e.g. room:B)')
    .option('--near <x,y[,z]>', 'only memories near this point, in metres (with --radius, --map)')
    .option('--radius <m>', 'with --near: how far, in metres')
    .option('--map <id>', 'with --near: the map the point is on')
    .option('--frame <id>', 'with --near: the coordinate frame (default map)')
    .action(run((t: string, o: RecallOptions) => recallCommand(t, o, ctx)));

  p.command('remember')
    .description(
      'save a fact you state, as the MCP remember tool does (scrubbed, through the write path)',
    )
    .argument('<fact...>', 'the fact, in quotes (words without quotes are joined into one fact)')
    .option(
      '--type <type>',
      'a hint for the kind of fact: semantic, episodic, procedural, preference',
    )
    .option('--dry-run', 'only report what the scrubber would redact; touches nothing')
    .option('--place <path>', 'where the fact is: a place path such as site:hq/room:B/shelf:B3')
    .option('--pose <x,y[,z]>', 'where the fact is on a map, in metres (with --map)')
    .option('--map <id>', 'with --pose: the map the point is on')
    .option('--radius <m>', 'with --pose: the size of the place, in metres')
    .option('--frame <id>', 'with --pose: the coordinate frame (default map)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((words: string[], o: RememberOptions) => rememberCommand(words, o, ctx)));

  p.command('explain')
    .description("recall with each stage's ranks and scores")
    .argument('<query>')
    .option('--json', 'print each memory with its ranks and scores, and the timings, as JSON')
    .option('--as-of <iso>', 'explain a recall of what was true at this time')
    .option('--known-at <iso>', 'explain a recall of what was believed at this time')
    .option('--history', 'explain a recall of every version of the matching facts')
    .option('--include <levels>', 'read only these levels: self, planet, star (comma list)')
    .option('--include-withdrawn', 'also show withdrawn judgments')
    .option('--within <path>', 'only memories at this place or below it (e.g. room:B)')
    .option('--near <x,y[,z]>', 'only memories near this point, in metres (with --radius, --map)')
    .option('--radius <m>', 'with --near: how far, in metres')
    .option('--map <id>', 'with --near: the map the point is on')
    .option('--frame <id>', 'with --near: the coordinate frame (default map)')
    .action(run((q: string, o: RecallOptions) => explainCommand(q, o, ctx)));

  p.command('revalidate')
    .description('list volatile facts nobody has confirmed lately (recall marks them outdated)')
    .option('--json', 'print them as JSON')
    .action(run((o: { json?: boolean }) => revalidateCommand(o, ctx)));

  p.command('observe')
    .description('run the write path on one observation (JSON on stdin, or --user/--assistant)')
    .option('--user <text>', 'the user turn')
    .option('--assistant <text>', 'the assistant turn')
    .option('--dry-run', 'only report what the scrubber would redact; touches nothing')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((o: { user?: string; assistant?: string; dryRun?: boolean; json?: boolean }) =>
        observeCommand(o, ctx),
      ),
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
    .option('--json', 'print oort.v1 JSON')
    .action(run(() => consolidateCommand(ctx)));

  p.command('forget')
    .description('delete a memory everywhere')
    .argument('<id>', 'memory id or unique prefix')
    .option('--yes', 'do not ask')
    .option(
      '--everywhere',
      'Oort Cloud: also withdraw its shared copies where you are the only contributor',
    )
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((id: string, o: { yes?: boolean; everywhere?: boolean }) => forgetCommand(id, o, ctx)),
    );

  const judge = p
    .command('judge')
    .description(
      "judgment memory: record an expert's decisions with their reasons, and apply them to new items",
    );
  judge
    .command('record')
    .description('record one decision the expert made, with their reason in their own words')
    .option('--subject <text>', 'what was judged, in one line')
    .option('--ref <link>', 'a link or id of the item itself')
    .option('--verdict <label>', 'approved or rejected, or a label from --verdicts')
    .option('--verdicts <list>', 'the verdict set, comma list (default approved,rejected)')
    .option('--reason <text>', "the expert's reason, verbatim")
    .option('--criteria <list>', 'tags the reason relies on, comma list (no-source,pii)')
    .option('--domain <name>', 'the domain: legal, content, code-review, …')
    .option('--by <expert>', "the expert's id")
    .option('--decided-at <iso>', 'when the expert decided (default now)')
    .option('--corrects <id>', 'replace this earlier judgment (it stops counting)')
    .option('--json', 'print JSON')
    .action(run((o: JudgeRecordOptions) => judgeRecordCommand(o, ctx)));
  judge
    .command('apply')
    .description(
      "predict the expert's verdict on a new item from their precedents, or say it needs the expert",
    )
    .argument('<item>', 'the new item, summarised in one line')
    .option('--details <text>', 'more about the item')
    .option('--ref <link>', 'a link or id of the item')
    .option('--domain <name>', 'use only judgments of this domain')
    .option('--by <expert>', "use only this expert's judgments")
    .option('--k <n>', 'precedents to use (default 5)')
    .option('--threshold <p>', 'probability a prediction needs (default 0.7)')
    .option('--min-similarity <s>', 'similarity a precedent needs to count')
    .option('--include-imported', 'also use judgments imported from packs (off by default)')
    .option(
      '--include-agent-recorded',
      'also use agent-recorded judgments nobody confirmed (off by default)',
    )
    .option('--json', 'print the full result as JSON')
    .action(run((item: string, o: JudgeApplyOptions) => judgeApplyCommand(item, o, ctx)));
  judge
    .command('list')
    .description('the judgments this agent reads (current ones; --all for withdrawn and corrected)')
    .option('--domain <name>', 'only this domain')
    .option('--by <expert>', 'only this expert')
    .option('--all', 'include withdrawn and corrected judgments')
    .option('--json', 'print JSON')
    .action(
      run((o: { domain?: string; by?: string; all?: boolean; json?: boolean }) =>
        judgeListCommand(o, ctx),
      ),
    );
  judge
    .command('withdraw')
    .description(
      'withdraw a judgment: judging, recall, export and packs leave it out from now on (its record stays)',
    )
    .argument('<id>', 'judgment id or unique prefix')
    .option('--by <operator>', 'who withdraws it (default: judge.operator, else local-user)')
    .option('--yes', 'do not ask')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((id: string, o: { yes?: boolean; by?: string }) => judgeWithdrawCommand(id, o, ctx)),
    );
  judge
    .command('confirm')
    .description('confirm an agent-recorded judgment, so it counts when judging (never over MCP)')
    .argument('<id>', 'judgment id or unique prefix')
    .option('--by <operator>', 'who confirms it (default: judge.operator, else local-user)')
    .option('--yes', 'do not ask')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((id: string, o: { yes?: boolean; by?: string }) => judgeConfirmCommand(id, o, ctx)),
    );
  judge
    .command('purge')
    .description("remove a judgment's subject, link, reason and embedding, keeping an audit stub")
    .argument('<id>', 'judgment id or unique prefix')
    .option('--by <operator>', 'who purges it (default: judge.operator, else local-user)')
    .option('--yes', 'do not ask')
    .option('--json', 'print oort.v1 JSON')
    .action(run((id: string, o: { yes?: boolean; by?: string }) => judgePurgeCommand(id, o, ctx)));
  judge
    .command('import')
    .description('import past decisions from CSV or JSON Lines (see docs/cli.md for the columns)')
    .argument('<file>')
    .option('--format <format>', 'csv or jsonl (default: from the file name)')
    .option('--domain <name>', 'the domain for rows without one')
    .option('--by <expert>', 'the expert for rows without one')
    .option('--json', 'print JSON')
    .action(
      run((file: string, o: { format?: string; domain?: string; by?: string; json?: boolean }) =>
        judgeImportCommand(file, o, ctx),
      ),
    );
  judge
    .command('eval')
    .description(
      'judge held-out decisions (never recorded) and report agreement and coverage per domain',
    )
    .argument('<file>', 'held-out decisions, CSV or JSON Lines, as for import')
    .option('--format <format>', 'csv or jsonl (default: from the file name)')
    .option('--domain <name>', 'the domain for rows without one')
    .option('--by <expert>', 'the expert for rows without one')
    .option('--thresholds <list>', 'confidence thresholds, comma list (default 0.5,…,0.9)')
    .option('--k <n>', 'precedents to use (default 5)')
    .option('--min-similarity <s>', 'similarity a precedent needs to count')
    .option('--include-imported', 'also use judgments imported from packs (off by default)')
    .option(
      '--include-agent-recorded',
      'also use agent-recorded judgments nobody confirmed (off by default)',
    )
    .option('--json', 'print JSON')
    .action(
      run(
        (
          file: string,
          o: {
            format?: string;
            domain?: string;
            by?: string;
            thresholds?: string;
            k?: string;
            minSimilarity?: string;
            includeImported?: boolean;
            includeAgentRecorded?: boolean;
            json?: boolean;
          },
        ) => judgeEvalCommand(file, o, ctx),
      ),
    );
  const pack = judge
    .command('pack')
    .description("judgment packs: an expert's judgments as a file another agent can import");
  pack
    .command('export')
    .description('write the current judgments (optionally one domain or expert) as a pack')
    .option('--out <file>', 'write to a new file (0600) instead of stdout')
    .option('--force', 'with --out, overwrite an existing file (never a symlink)')
    .option('--name <name>', 'the pack name')
    .option('--domain <name>', 'only this domain')
    .option('--by <expert>', 'only this expert')
    .option('--include-imported', 'also export judgments imported from packs')
    .option('--json', 'with --out, print oort.v1 JSON (to stdout the pack itself is the output)')
    .action(
      run(
        (o: {
          out?: string;
          force?: boolean;
          name?: string;
          domain?: string;
          by?: string;
          includeImported?: boolean;
        }) => judgePackExportCommand(o, ctx),
      ),
    );
  pack
    .command('import')
    .description(
      'import a pack (shows what it holds first); each judgment keeps its expert and origin',
    )
    .argument('<file>')
    .option('--yes', 'do not ask')
    .option('--json', 'print JSON')
    .action(
      run((file: string, o: { yes?: boolean; json?: boolean }) =>
        judgePackImportCommand(file, o, ctx),
      ),
    );

  p.command('share')
    .description('Oort Cloud: share a copy of a memory with a Constellation (shows it first)')
    .argument('<id>', 'memory id or unique prefix')
    .requiredOption('--to <constellation>', 'the Constellation, by name or id')
    .option('--text <text>', 'share this edited text instead')
    .option('--yes', 'do not ask')
    .option('--json', 'print JSON')
    .action(
      run((id: string, o: { to?: string; text?: string; yes?: boolean; json?: boolean }) =>
        shareCommand(id, o, ctx),
      ),
    );

  const galaxy = p
    .command('galaxy')
    .description('Oort Cloud: Galaxies, your team (invite-only beta)');
  galaxy
    .command('list', { isDefault: true })
    .description('your Galaxies and your role in each')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => galaxyListCommand(o, ctx)));
  galaxy
    .command('members')
    .description('who is in a Galaxy, and their roles')
    .argument('<galaxy>', 'slug, name or id')
    .option('--json', 'print JSON')
    .action(run((g: string, o: { json?: boolean }) => galaxyMembersCommand(g, o, ctx)));
  galaxy
    .command('create')
    .description('create a Galaxy: opens oortcloud.dev, where you create it signed in')
    .argument('<name>', 'its name')
    .option('--no-browser', 'print the page instead of opening it')
    .option('--json', 'print oort.v1 JSON')
    .action(run((name: string, o: { browser?: boolean }) => galaxyCreateCommand(name, o, ctx)));

  const constellation = p
    .command('constellation')
    .description('Oort Cloud: Constellations, memory you share with a team (invite-only beta)');
  constellation
    .command('list', { isDefault: true })
    .description('the Constellations you belong to')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => constellationListCommand(o, ctx)));
  constellation
    .command('create')
    .description('create a Constellation, with you as its maintainer')
    .argument('<name>', 'its name, as labels show it')
    .option('--galaxy <galaxy>', 'in one of your Galaxies (its admins): slug, name or id')
    .option('--json', 'print JSON')
    .action(
      run((name: string, o: { json?: boolean; galaxy?: string }) =>
        constellationCreateCommand(name, o, ctx),
      ),
    );
  constellation
    .command('invite')
    .description('invite someone by email (maintainers): a single-use link, valid 7 days')
    .argument('<constellation>', 'name or id')
    .argument('<email>', 'the address they will accept with')
    .option('--role <role>', 'maintainer, member (default) or reader')
    .option('--json', 'print JSON')
    .action(
      run((c: string, email: string, o: { role?: string; json?: boolean }) =>
        constellationInviteCommand(c, email, o, ctx),
      ),
    );
  constellation
    .command('join')
    .description('open an invite link to accept it, signed in on oortcloud.dev')
    .argument('<link>', 'the invite link (or its token)')
    .option('--no-browser', 'print the page instead of opening the browser')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((link: string, o: { browser?: boolean }) => constellationJoinCommand(link, o, ctx)),
    );
  constellation
    .command('invites')
    .description('invites nobody has accepted yet (maintainers)')
    .argument('<constellation>', 'name or id')
    .option('--json', 'print JSON')
    .action(run((c: string, o: { json?: boolean }) => constellationInvitesCommand(c, o, ctx)));
  constellation
    .command('revoke')
    .description('revoke an open invite (maintainers)')
    .argument('<constellation>', 'name or id')
    .argument('<invite>', 'the invite id from `oort constellation invites`')
    .option('--json', 'print oort.v1 JSON')
    .action(run((c: string, invite: string) => constellationRevokeCommand(c, invite, ctx)));
  constellation
    .command('members')
    .description('who is in a Constellation: roles and attached agents')
    .argument('<constellation>', 'name or id')
    .option('--json', 'print JSON')
    .action(run((c: string, o: { json?: boolean }) => constellationMembersCommand(c, o, ctx)));
  constellation
    .command('remove')
    .description('remove a member (maintainers); what they shared stays')
    .argument('<constellation>', 'name or id')
    .argument('<member>', 'the mb_… id from `members`, or their email address')
    .option('--yes', 'do not ask first (needed outside a terminal)')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((c: string, member: string, o: { yes?: boolean }) =>
        constellationRemoveCommand(c, member, o, ctx),
      ),
    );
  constellation
    .command('role')
    .description("change a member's role (maintainers)")
    .argument('<constellation>', 'name or id')
    .argument('<member>', 'the mb_… id from `members`, or their email address')
    .argument('<role>', 'maintainer, member or reader')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((c: string, member: string, role: string) =>
        constellationRoleCommand(c, member, role, ctx),
      ),
    );
  constellation
    .command('leave')
    .description('leave a Constellation; what you shared stays')
    .argument('<constellation>', 'name or id')
    .option('--yes', 'do not ask first (needed outside a terminal)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((c: string, o: { yes?: boolean }) => constellationLeaveCommand(c, o, ctx)));
  constellation
    .command('transfer')
    .description('make another member the owner (owner only)')
    .argument('<constellation>', 'name or id')
    .argument('<member>', 'the mb_… id from `members`, or their email address')
    .option('--yes', 'do not ask first (needed outside a terminal)')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((c: string, member: string, o: { yes?: boolean }) =>
        constellationTransferCommand(c, member, o, ctx),
      ),
    );
  constellation
    .command('delete')
    .description('delete a Constellation and every memory shared in it (owner only)')
    .argument('<constellation>', 'name or id')
    .option('--yes', 'do not ask first (needed outside a terminal)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((c: string, o: { yes?: boolean }) => constellationDeleteCommand(c, o, ctx)));
  constellation
    .command('adopt')
    .description(
      "keep an archived Constellation (its team's organization was deleted): move it into your own account (owner)",
    )
    .argument('<constellation>', 'name or id')
    .option('--json', 'print JSON')
    .action(run((c: string, o: { json?: boolean }) => constellationAdoptCommand(c, o, ctx)));
  constellation
    .command('policy')
    .description(
      'how shares are accepted, who may supersede, and erasure support (maintainers): --confirm, --open, --supersede-trust, --min-support',
    )
    .argument('<constellation>', 'name or id')
    .option('--confirm', 'every share is confirmed by a person (the default)')
    .option('--open', 'shares are accepted without a review step')
    .option(
      '--supersede-trust <trust>',
      "member (the default) or maintainer: who may supersede someone else's memory",
    )
    .option(
      '--min-support <n>',
      'members (1-10, default 1) a memory needs to survive an erasure; needs a full key',
    )
    .option('--json', 'print oort.v1 JSON')
    .action(
      run(
        (
          c: string,
          o: { open?: boolean; confirm?: boolean; supersedeTrust?: string; minSupport?: string },
        ) => constellationPolicyCommand(c, o, ctx),
      ),
    );
  constellation
    .command('contested')
    .description('memories held against each other until a maintainer decides')
    .argument('<constellation>', 'name or id')
    .option('--json', 'print JSON')
    .action(run((c: string, o: { json?: boolean }) => constellationContestedCommand(c, o, ctx)));
  constellation
    .command('resolve')
    .description('settle a contest by keeping one memory (maintainers)')
    .argument('<constellation>', 'name or id')
    .argument('<id>', 'a contested memory id (from `contested`)')
    .requiredOption('--keep <id>', 'the memory that stays current')
    .option('--json', 'print JSON')
    .action(
      run((c: string, id: string, o: { keep?: string; json?: boolean }) =>
        constellationResolveCommand(c, id, o, ctx),
      ),
    );
  constellation
    .command('attach')
    .description('let one of your agents read a Constellation (never more than your role)')
    .argument('<constellation>', 'name or id')
    .option('--agent <name>', 'the agent: claude-code, codex, cursor, …')
    .option('--share', 'also let it share into the Constellation')
    .option('--json', 'print JSON')
    .action(
      run((c: string, o: { agent?: string; share?: boolean; json?: boolean }) =>
        // `--agent` is also the program-wide option, which commander may claim first.
        constellationAttachCommand(c, { ...o, agent: o.agent ?? ctx.agent }, ctx),
      ),
    );
  constellation
    .command('detach')
    .description('stop one of your agents reading a Constellation')
    .argument('<constellation>', 'name or id')
    .option('--agent <name>', 'the agent')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((c: string, o: { agent?: string }) =>
        constellationDetachCommand(c, { agent: o.agent ?? ctx.agent }, ctx),
      ),
    );

  p.command('pin')
    .description('pin a memory (never sent to cold)')
    .argument('<id>', 'memory id or unique prefix')
    .option('--json', 'print oort.v1 JSON')
    .action(run((id: string) => pinCommand(id, true, ctx)));

  p.command('unpin')
    .description('unpin a memory')
    .argument('<id>', 'memory id or unique prefix')
    .option('--json', 'print oort.v1 JSON')
    .action(run((id: string) => pinCommand(id, false, ctx)));

  p.command('link')
    .description('link two memories that belong together')
    .argument('<a>', 'memory id or unique prefix')
    .argument('<b>', 'memory id or unique prefix')
    .option('--yes', 'do not ask (the link is then recorded as asserted by an agent)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((a: string, b: string, o: { yes?: boolean }) => linkCommand(a, b, false, o, ctx)));

  p.command('unlink')
    .description('remove a link, or keep two memories from being linked')
    .argument('<a>', 'memory id or unique prefix')
    .argument('<b>', 'memory id or unique prefix')
    .option('--yes', 'do not ask (the change is then recorded as made by an agent)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((a: string, b: string, o: { yes?: boolean }) => linkCommand(a, b, true, o, ctx)));

  const project = p
    .command('project')
    .description('trust a project id for this repository (oort.config.json project.id)');
  project
    .command('link')
    .description('bind this repository to its configured project id, or to --id')
    .option('--id <id>', 'the project id to bind (default: project.id in oort.config.json)')
    .option('--constellation <c>', 'Oort Cloud: bind this project to a Constellation (maintainers)')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((o: { id?: string; constellation?: string }) =>
        o.constellation !== undefined
          ? projectConstellationCommand(o.constellation, true, ctx)
          : projectLinkCommand(o, ctx),
      ),
    );
  project
    .command('unlink')
    .description("remove this repository's binding (back to the derived id)")
    .option('--constellation <c>', 'Oort Cloud: unbind this project from a Constellation')
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((o: { constellation?: string }) =>
        o.constellation !== undefined
          ? projectConstellationCommand(o.constellation, false, ctx)
          : projectUnlinkCommand(ctx),
      ),
    );
  project
    .command('privacy')
    .description(
      "Oort Cloud: mark this repository's project public (its memories can be shared) or private",
    )
    .argument('<state>', 'public or private')
    .option('--yes', 'do not ask')
    .option('--json', 'print oort.v1 JSON')
    .action(run((state: string, o: { yes?: boolean }) => projectPrivacyCommand(state, o, ctx)));

  const cloud = p
    .command('cloud')
    .description('Oort Cloud (Oort Pro): keep memories in your account instead of on this machine');
  cloud
    .command('use')
    .description('use Oort Cloud for hooks, MCP and every command (needs oort login and Pro)')
    .option('--local', 'switch back to the local store on this machine')
    .option('--json', 'print oort.v1 JSON')
    .action(run((o: { local?: boolean }) => cloudUseCommand(o, ctx)));
  cloud
    .command('status')
    .description('which store this machine uses, the account, and import progress')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => cloudStatusCommand(o, ctx)));
  cloud
    .command('import')
    .alias('upload')
    .description('upload the local store to Oort Cloud (resumable; safe to run again)')
    .option('--dry-run', 'show what would be uploaded and stop')
    .option('--yes', 'do not ask before uploading')
    .option('--json', 'print oort.v1 JSON')
    .action(run((o: { dryRun?: boolean; yes?: boolean }) => cloudImportCommand(o, ctx)));
  cloud
    .command('export')
    .alias('download')
    .description('download every memory in your Oort Cloud account (v1 export format)')
    .option('--out <file>', 'write to a new file (0600) instead of stdout')
    .option('--force', 'with --out, overwrite an existing file (never a symlink)')
    .option('--json', 'with --out, print oort.v1 JSON (to stdout the export is JSON Lines)')
    .action(run((o: { out?: string; force?: boolean }) => cloudExportCommand(o, ctx)));

  p.command('whoami')
    .description('the store, the agent, and the spaces it reaches with your role in each')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => whoamiCommand(o, ctx)));

  p.command('update')
    .description(
      'update every copy of oort here (the hooks, this one, ~/.oort/cli) to the latest release',
    )
    .option('--check', 'only report what would change (exits 0 either way)')
    .option('--yes', 'do not ask before running the installers')
    .option('--version <version>', 'install this version instead of the latest (0.6.3)')
    // The program's own `--version` is parsed before any subcommand's, so runCli renames this
    // command's to `--update-version` before parsing (`updateArgs`).
    .addOption(new Option('--update-version <version>').hideHelp())
    .option('--json', 'print oort.v1 JSON')
    .action(
      run((o: UpdateOptions & { updateVersion?: string }) => {
        const { updateVersion, ...rest } = o;
        return updateCommand(
          { ...rest, ...(updateVersion !== undefined && { version: updateVersion }) },
          ctx,
        );
      }),
    );

  p.command('doctor')
    .description(
      'check keys, hooks, MCP connectors, the store and the relay, with a fix per problem',
    )
    .option('--json', 'print every check as JSON')
    .option(
      '--vacuum',
      'rewrite the store once, so text deleted by Oort 0.9.0 or older is gone from the file',
    )
    .action(run((o: { json?: boolean; vacuum?: boolean }) => doctorCommand(o, ctx)));

  p.command('login')
    .description(
      'sign in to Oort Pro in the browser and keep the Oort key in the Keychain (macOS) or credentials.json',
    )
    .option('--no-browser', 'print the sign-in URL instead of opening the browser')
    .option('--json', 'print oort.v1 JSON')
    .action(run((o: { browser?: boolean }) => loginCommand(o, ctx)));

  p.command('logout')
    .description('remove the stored Oort key (it does not revoke the key)')
    .option('--json', 'print oort.v1 JSON')
    .action(run(() => logoutCommand(ctx)));

  p.command('open')
    .description(
      'open the dashboard, the star map, a memory, your account or the docs on oortcloud.dev in the browser',
    )
    .addArgument(
      new Argument(
        '[target]',
        'default: the dashboard when signed in to Oort Pro, else the quickstart',
      ).choices(OPEN_TARGETS),
    )
    .argument('[id]', 'with memory: its id or a unique prefix (8+ characters)')
    .option('--no-browser', 'print the address instead of opening it')
    .option('--json', 'print oort.v1 JSON with the address (never opens a browser)')
    .action(
      run((target: OpenTarget | undefined, id: string | undefined, o: { browser?: boolean }) =>
        openCommand(target, id, o, ctx),
      ),
    );

  const keys = p
    .command('keys')
    .description(
      'provider keys in the macOS Keychain, or credentials.json elsewhere (voyage, typesafe, anthropic, oort)',
    );
  keys
    .command('set')
    .description('store a key; it is prompted for with the input hidden (never in argv or history)')
    .argument('<provider>', 'voyage, typesafe, anthropic or oort')
    .option('--json', 'print oort.v1 JSON')
    .action(run((provider: string) => keysSetCommand(provider, ctx)));
  keys
    .command('list')
    .description('where each key comes from: keychain, env or missing (never the value)')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => keysListCommand(o, ctx)));
  keys
    .command('create')
    .description(
      'Oort Cloud: a new Oort key for this account, shown once; --scope narrows it (planet,<c>[:read|:share])',
    )
    .option('--name <name>', 'a name to recognise it by on oortcloud.dev/account')
    .option('--scope <list>', 'planet, then Constellations: planet,checkout:read')
    .option('--json', 'print JSON')
    .action(
      run((o: { name?: string; scope?: string; json?: boolean }) => keysCreateCommand(o, ctx)),
    );
  keys
    .command('rm')
    .alias('remove')
    .description('delete a stored key')
    .argument('<provider>', 'voyage, typesafe, anthropic or oort')
    .option('--json', 'print oort.v1 JSON')
    .action(run((provider: string) => keysRmCommand(provider, ctx)));

  const models = p
    .command('models')
    .description('local models: embeddings and rerank on this CPU, no keys or account');
  models
    .command('list', { isDefault: true })
    .description('the local models, which are downloaded, and which are in use')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => modelsListCommand(o, ctx)));
  models
    .command('pull')
    .description(
      'download (default: the small embedder and reranker, 58 MB), verify each file, and use them',
    )
    .argument('[models...]', 'model ids from `oort models list`')
    .option('--no-use', 'download only; leave ~/.oort/config.json as it is')
    .option('--json', 'print oort.v1 JSON')
    .action(run((ids: string[], o: { use?: boolean }) => modelsPullCommand(ids, o, ctx)));
  models
    .command('verify')
    .description('re-hash downloaded models against their pinned SHA-256')
    .argument('[models...]', 'model ids (default: every downloaded one)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((ids: string[]) => modelsVerifyCommand(ids, ctx)));
  models
    .command('rm')
    .alias('remove')
    .description('delete downloaded models (default: all) and switch back to the default provider')
    .argument('[models...]', 'model ids (default: every downloaded one)')
    .option('--json', 'print oort.v1 JSON')
    .action(run((ids: string[]) => modelsRmCommand(ids, ctx)));

  p.command('reembed')
    .description('re-embed every memory with the configured embedder (after switching embedders)')
    .option('--force', 're-embed even when the store already uses the configured embedder')
    .option('--yes', 'do not ask before calling a paid embedder')
    .option('--json', 'print oort.v1 JSON')
    .action(run((o: { force?: boolean; yes?: boolean }) => reembedCommand(o, ctx)));

  p.command('reindex')
    .description("rebuild the RaBitQ vector index around today's vectors (oort doctor says when)")
    .option('--json', 'print oort.v1 JSON')
    .action(run(() => reindexCommand(ctx)));

  p.command('import')
    .description('import Claude Code transcripts, or an Oort export file (JSON Lines); asks first')
    .argument('<source>', 'claude-code, or an export file (oort export, oort cloud export)')
    .option('--since <age>', 'only transcripts modified within this age: 12h, 30d, 2w')
    .option('--yes', 'do not ask before importing')
    .option('--estimate-only', 'print the estimate and stop')
    .option('--include-unresolved', 'import sessions whose project is gone as global memories')
    .option('--projects-dir <dir>', 'Claude Code projects directory (default ~/.claude/projects)')
    .option('--json', 'print oort.v1 JSON')
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
            // An Oort export file (CON-137): any path that names a file.
            const file = path.resolve(ctx.io.cwd, harness);
            if (fs.existsSync(file) && fs.statSync(file).isFile()) {
              const transcriptOnly = (
                ['since', 'estimateOnly', 'includeUnresolved', 'projectsDir'] as const
              ).filter((k) => o[k] !== undefined);
              if (transcriptOnly.length > 0) {
                throw new Refusal(
                  `--${transcriptOnly[0]!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is for transcripts; an export file takes --yes and --json only.`,
                );
              }
              return importFileCommand(harness, { yes: o.yes === true }, ctx);
            }
            throw new Refusal(
              `Unknown source ${echo(harness)}: import reads claude-code transcripts or an Oort export file, and no file is at that path.`,
              { fix: 'oort import claude-code' },
            );
          }
          return importCommand(o, ctx);
        },
      ),
    );

  p.command('export')
    .description('write every visible memory in the v2 export format (docs/export-format.md)')
    .option('--out <file>', 'write to a new file (0600) instead of stdout')
    .option('--force', 'with --out, overwrite an existing file (never a symlink)')
    .option('--format <version>', 'export format version: 2 (default) or 1 (Planet memories only)')
    .option('--json', 'with --out, print oort.v1 JSON (to stdout the export is JSON Lines)')
    .option('--include-withdrawn', 'also export withdrawn judgments')
    .action(
      run((o: { out?: string; force?: boolean; format?: string; includeWithdrawn?: boolean }) =>
        exportCommand(o, ctx),
      ),
    );

  groupHelp(p, ui);
  return p;
}

/**
 * `oort --help`'s groups (CON-107 step 3), in this order, each listing its commands in this
 * order. A command left out here fails help.test.ts.
 */
export const HELP_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Start:', ['setup', 'init', 'whoami']],
  [
    'Memory:',
    [
      'recall',
      'remember',
      'observe',
      'inspect',
      'explain',
      'forget',
      'pin',
      'unpin',
      'link',
      'unlink',
      'revalidate',
      'import',
      'export',
      'judge',
    ],
  ],
  ['Agents:', ['connect', 'disconnect', 'install', 'uninstall', 'mcp', 'hook', 'serve']],
  [
    'Cloud and sharing:',
    ['login', 'logout', 'open', 'cloud', 'share', 'constellation', 'galaxy', 'project'],
  ],
  [
    'Maintenance:',
    ['doctor', 'update', 'stats', 'consolidate', 'reembed', 'reindex', 'models', 'keys'],
  ],
];

/** The examples under `oort --help`: the common commands, one line each. */
const HELP_EXAMPLES: readonly (readonly [string, string])[] = [
  ['oort setup', 'connect your agents and choose keys'],
  ['oort remember "We deploy on Fridays."', 'save a fact you state'],
  ['oort recall "how do we deploy?"', 'what your agents are shown'],
  ['oort inspect', 'list current memories'],
  ['oort forget 1b2c3d4e', 'delete one, by id or prefix'],
  ['oort doctor', 'check keys, hooks and the store'],
  ['oort recall "auth port" --json', 'any command as oort.v1 JSON'],
];

/**
 * Groups the top-level commands by purpose, `help` under Maintenance, and ends the top-level help
 * with the examples and where the docs are. A command's own help (`oort recall --help`) is as
 * commander prints it.
 */
function groupHelp(p: Command, ui: ReturnType<typeof uiFor>): void {
  const order = HELP_GROUPS.flatMap(([, names]) => names);
  for (const [group, names] of HELP_GROUPS) {
    for (const name of names) {
      const cmd = p.commands.find((c) => c.name() === name);
      if (cmd === undefined) throw new Error(`help group ${group} names no command ${name}`);
      cmd.helpGroup(group);
    }
  }
  // Commander lists a group's commands in the order they were added.
  (p.commands as Command[]).sort((a, b) => order.indexOf(a.name()) - order.indexOf(b.name()));
  p.commandsGroup('Maintenance:').helpCommand('help [command]', 'display help for command');
  const width = Math.max(...HELP_EXAMPLES.map(([c]) => c.length));
  p.addHelpText('after', ({ error }) =>
    error
      ? ''
      : [
          '',
          ui.bold('Examples:'),
          ...HELP_EXAMPLES.map(([c, what]) => `  ${c.padEnd(width)}  ${ui.dim(what)}`),
          '',
          'Run `oort <command> --help` for its flags.',
          `Docs: ${ui.glow('https://oortcloud.dev/docs')}`,
          `Every command and flag: ${ui.glow('https://github.com/oortmem/oort/blob/main/docs/cli.md')}`,
        ].join('\n'),
  );
}

/**
 * Runs the CLI on `args` (user arguments, without node and the script) and
 * resolves the exit code (docs/cli.md): 0 success (a declined question
 * included), 1 unexpected error (message only; the stack with --debug) and a
 * status query whose thing is not running, 2 refusal or usage problem (every
 * `oort.v1` error code but `internal`), 3 partial success (`import` with
 * failed sessions), 4 and 5 doctor's warnings and failures. With `--json` a
 * failure is also an `oort.v1` envelope on stdout (output.ts). Never prints a
 * key: error messages come from our own refusals or from adapters that never
 * include one.
 */
export async function runCli(
  args: string[],
  io: Io,
  wire: WireFn = defaultWire,
  keychain: Keychain = keychainFor(io.env, {
    warn: (m) => io.err(`oort: ${m}\n`),
    promptSecret: (q) => io.askSecret(q),
  }),
  deps: {
    login?: LoginDeps;
    fetch?: typeof fetch;
    binPath?: string;
    updateDeps?: Partial<UpdateDeps>;
    open?: OpenDeps;
  } = {},
): Promise<number> {
  let code = 0;
  const ctx: Ctx = { io, wire, keychain, ...deps };
  const p = program(ctx, (c) => {
    code = c;
  });
  try {
    args = updateArgs(p, args);
    // Plain `oort` is the front door: the help on stdout, exit 0.
    await p.parseAsync(args.length === 0 ? ['--help'] : args, { from: 'user' });
    updateNotice(ctx, io);
    return code;
  } catch (e) {
    if (e instanceof CommanderError && e.exitCode === 0) return 0;
    const target = commandFor(p, args);
    const info = describeError(e, (flag) => rerunWith(p, target, args, flag));
    // Commander has printed its own line (with the usage hint).
    // Any message may quote input (a file's field, a server's words): never raw escapes (L-c).
    if (!(e instanceof CommanderError))
      io.err(`oort: ${shown(info.message, { newlines: true })}\n`);
    // --debug: the stack of every unexpected (exit 1) error.
    if (info.exitCode === 1 && args.includes('--debug') && e instanceof Error && e.stack) {
      io.err(`${e.stack}\n`);
    }
    // In JSON mode the failure envelope goes on stdout too (`io` is the real stdout here), unless
    // stdout already has this run's output (a JSON Lines export). Before any action ran (a usage
    // error) the mode comes from the arguments; the exempt commands never print one.
    const out = ctx.output;
    let json: boolean;
    let command: string;
    if (out !== undefined) {
      json = out.json && !out.written;
      command = out.command;
    } else {
      command = commandName(commandPath(target), serveActionIn(args));
      // An unknown command (`oort recal --json`) still answers a script that asked for JSON.
      json =
        !exempt(command, args.includes('--detach')) &&
        (hasJsonOption(target)
          ? args.includes('--json') || jsonFromEnv(io.env)
          : target === p && args.includes('--json'));
    }
    if (json) io.out(`${safeJson(failure(command, info))}\n`);
    return info.exitCode;
  }
}

/** Commands that never show the update notice: their output is a protocol or has its own line. */
const NO_NOTICE = new Set(['hook', 'mcp', 'update', 'doctor']);

/**
 * After an interactive command, one dim line on stderr when a newer oort is out (CON-114): `Oort X
 * is available (you have Y): oort update`. Only when stdout and stderr are both a terminal, never
 * in JSON mode (`--json`, `OORT_OUTPUT=json`), never for the hook, MCP, serve, doctor (its own
 * line) or update. Reads the cache only; a day-old one is refreshed by a detached process.
 */
function updateNotice(ctx: Ctx, io: Io): void {
  try {
    const out = ctx.output;
    if (out === undefined || out.json || jsonFromEnv(io.env)) return;
    if (NO_NOTICE.has(out.command) || out.command.startsWith('serve')) return;
    if (io.stdoutIsTTY !== true || io.stderrIsTTY !== true) return;
    const home = resolveHome(io.env);
    if (updateCheckOff(io.env, home) !== undefined) return;
    requestRefresh(home, io.env, () => io.spawnUpdateCheck?.());
    const latest = availableUpdate(VERSION, readUpdateCache(home));
    if (latest !== undefined) io.err(`${uiFor(io).dim(noticeText(latest, VERSION))}\n`);
  } catch {
    // A notice never fails a command.
  }
}

/**
 * `oort update --version <x>`: commander parses the program's `--version` (print the version)
 * before a subcommand's, so after `update` it becomes `--update-version`, the option update reads.
 */
export function updateArgs(root: Command, args: string[]): string[] {
  if (commandPath(commandFor(root, args)) !== 'update') return args;
  const at = args.indexOf('update');
  return args.map((a, i) =>
    i <= at
      ? a
      : a === '--version'
        ? '--update-version'
        : a.startsWith('--version=')
          ? `--update-version=${a.slice('--version='.length)}`
          : a,
  );
}
