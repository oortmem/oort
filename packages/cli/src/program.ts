import { Command, CommanderError } from 'commander';
import { VERSION } from '@oortmem/core';
import { connectCommand } from './commands/connect.js';
import {
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
import { doctorCommand } from './commands/doctor.js';
import { consolidateCommand } from './commands/consolidate.js';
import { explainCommand } from './commands/explain.js';
import { exportCommand } from './commands/export.js';
import { forgetCommand } from './commands/forget.js';
import { hookCommand } from './commands/hook.js';
import { importCommand } from './commands/import.js';
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
import { pinCommand } from './commands/pin.js';
import {
  projectConstellationCommand,
  projectLinkCommand,
  projectPrivacyCommand,
  projectUnlinkCommand,
} from './commands/project.js';
import { recallCommand, type RecallOptions } from './commands/recall.js';
import { reembedCommand } from './commands/reembed.js';
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
import { uiFor } from './ui.js';
import { Refusal, echo, type Ctx } from './util.js';
import { wire as defaultWire, type WireFn } from './wire.js';

function program(ctx: Ctx, setCode: (code: number) => void): Command {
  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<number | void>) =>
    async (...args: A): Promise<void> => {
      const code = await fn(...args);
      if (typeof code === 'number') setCode(code);
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
    .hook('preAction', (cmd) => {
      const agent = (cmd.opts() as { agent?: string }).agent;
      if (agent !== undefined) ctx.agent = agent;
    })
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.io.out(s),
      writeErr: (s) => ctx.io.err(s),
      getOutHasColors: () => ui.color,
      getErrHasColors: () => ui.color,
      // Commander quotes the offending argument ('…'): scrub and clip it like our own refusals.
      outputError: (s, write) => write(s.replace(/'([^'\n]*)'/g, (_m, a: string) => echo(a))),
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
    .description(
      'install Oort into a harness: the Claude Code hooks, or the MCP server for any other (as `oort connect`)',
    )
    .argument('<harness>', 'claude-code, codex, cursor, claude-desktop, gemini or vscode')
    .option('--project', 'use <cwd>/.claude/settings.json instead of ~/.claude/settings.json')
    .action(run((h: string, o: { project?: boolean }) => installCommand('install', h, o, ctx)));

  p.command('uninstall')
    .description('remove the Claude Code hooks, or the MCP server from any other harness')
    .argument('<harness>', 'claude-code, codex, cursor, claude-desktop, gemini or vscode')
    .option('--project', 'use <cwd>/.claude/settings.json instead of ~/.claude/settings.json')
    .action(run((h: string, o: { project?: boolean }) => installCommand('uninstall', h, o, ctx)));

  p.command('connect')
    .description('add the oort MCP server to an agent host (backs up the file, prints the diff)')
    .argument('<hosts...>', 'claude-desktop, claude-code, codex, cursor, gemini or vscode')
    .option('--dry-run', 'print the diff without writing')
    .option('--star', "keep this agent's new memories in its own Star (it still reads your Planet)")
    .option('--no-star', "write this agent's new memories to your Planet again (the default)")
    .action(
      run((hosts: string[], o: { dryRun?: boolean; star?: boolean }) =>
        connectCommand('connect', hosts, o, ctx),
      ),
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

  p.command('serve')
    .description(
      'run the local daemon the hooks prefer (a Unix socket; they fall back to in-process without it)',
    )
    .argument('[action]', 'start (the default), status or stop')
    .option('--detach', 'start in the background and return')
    .option(
      '--idle <duration>',
      'exit after this long without a request (default serve.idleMinutes, 30m)',
    )
    .option('--json', 'status: print JSON')
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
    .action(run((t: string, o: RecallOptions) => recallCommand(t, o, ctx)));

  p.command('explain')
    .description("recall with each stage's ranks and scores")
    .argument('<query>')
    .option('--json', 'print each memory with its ranks and scores, and the timings, as JSON')
    .option('--as-of <iso>', 'explain a recall of what was true at this time')
    .option('--known-at <iso>', 'explain a recall of what was believed at this time')
    .option('--history', 'explain a recall of every version of the matching facts')
    .option('--include <levels>', 'read only these levels: self, planet, star (comma list)')
    .option('--include-withdrawn', 'also show withdrawn judgments')
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
    .option(
      '--everywhere',
      'Oort Cloud: also withdraw its shared copies where you are the only contributor',
    )
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
    .action(
      run((id: string, o: { yes?: boolean; by?: string }) => judgeWithdrawCommand(id, o, ctx)),
    );
  judge
    .command('confirm')
    .description('confirm an agent-recorded judgment, so it counts when judging (never over MCP)')
    .argument('<id>', 'judgment id or unique prefix')
    .option('--by <operator>', 'who confirms it (default: judge.operator, else local-user)')
    .option('--yes', 'do not ask')
    .action(
      run((id: string, o: { yes?: boolean; by?: string }) => judgeConfirmCommand(id, o, ctx)),
    );
  judge
    .command('purge')
    .description("remove a judgment's subject, link, reason and embedding, keeping an audit stub")
    .argument('<id>', 'judgment id or unique prefix')
    .option('--by <operator>', 'who purges it (default: judge.operator, else local-user)')
    .option('--yes', 'do not ask')
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
    .option('--json', 'print JSON')
    .action(run((name: string, o: { json?: boolean }) => constellationCreateCommand(name, o, ctx)));
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
    .action(run((c: string, o: { yes?: boolean }) => constellationLeaveCommand(c, o, ctx)));
  constellation
    .command('transfer')
    .description('make another member the owner (owner only)')
    .argument('<constellation>', 'name or id')
    .argument('<member>', 'the mb_… id from `members`, or their email address')
    .option('--yes', 'do not ask first (needed outside a terminal)')
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
    .action(run((c: string, o: { yes?: boolean }) => constellationDeleteCommand(c, o, ctx)));
  constellation
    .command('policy')
    .description(
      'how shares are accepted and who may supersede (maintainers): --confirm, --open, --supersede-trust',
    )
    .argument('<constellation>', 'name or id')
    .option('--confirm', 'every share is confirmed by a person (the default)')
    .option('--open', 'shares are accepted without a review step')
    .option(
      '--supersede-trust <trust>',
      "member (the default) or maintainer: who may supersede someone else's memory",
    )
    .action(
      run((c: string, o: { open?: boolean; confirm?: boolean; supersedeTrust?: string }) =>
        constellationPolicyCommand(c, o, ctx),
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
    .action(
      run((c: string, o: { agent?: string }) =>
        constellationDetachCommand(c, { agent: o.agent ?? ctx.agent }, ctx),
      ),
    );

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
    .option('--constellation <c>', 'Oort Cloud: bind this project to a Constellation (maintainers)')
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
    .action(run((state: string, o: { yes?: boolean }) => projectPrivacyCommand(state, o, ctx)));

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

  p.command('whoami')
    .description('the store, the agent, and the spaces it reaches with your role in each')
    .option('--json', 'print JSON')
    .action(run((o: { json?: boolean }) => whoamiCommand(o, ctx)));

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
    .description('delete a stored key')
    .argument('<provider>', 'voyage, typesafe, anthropic or oort')
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
    .action(run((ids: string[], o: { use?: boolean }) => modelsPullCommand(ids, o, ctx)));
  models
    .command('verify')
    .description('re-hash downloaded models against their pinned SHA-256')
    .argument('[models...]', 'model ids (default: every downloaded one)')
    .action(run((ids: string[]) => modelsVerifyCommand(ids, ctx)));
  models
    .command('rm')
    .description('delete downloaded models (default: all) and switch back to the default provider')
    .argument('[models...]', 'model ids (default: every downloaded one)')
    .action(run((ids: string[]) => modelsRmCommand(ids, ctx)));

  p.command('reembed')
    .description('re-embed every memory with the configured embedder (after switching embedders)')
    .option('--force', 're-embed even when the store already uses the configured embedder')
    .option('--yes', 'do not ask before calling a paid embedder')
    .action(run((o: { force?: boolean; yes?: boolean }) => reembedCommand(o, ctx)));

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
    .description('write every visible memory in the v2 export format (docs/export-format.md)')
    .option('--out <file>', 'write to a new file (0600) instead of stdout')
    .option('--force', 'with --out, overwrite an existing file (never a symlink)')
    .option('--format <version>', 'export format version: 2 (default) or 1 (Planet memories only)')
    .option('--json', 'accepted for compatibility; the format is always JSON Lines')
    .option('--include-withdrawn', 'also export withdrawn judgments')
    .action(
      run((o: { out?: string; force?: boolean; format?: string; includeWithdrawn?: boolean }) =>
        exportCommand(o, ctx),
      ),
    );

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
    // Plain `oort` is the front door: the help on stdout, exit 0.
    await p.parseAsync(args.length === 0 ? ['--help'] : args, { from: 'user' });
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
