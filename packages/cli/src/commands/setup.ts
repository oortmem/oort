import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import { grantFor, HOOK_EVENTS, installHooks } from '@oortmem/claude-code';
import {
  localScope,
  recall,
  resolveHome,
  VERSION,
  type Memory,
  type Scope,
  type ScopeFilter,
  localGrant,
} from '@oortmem/core';
import {
  HOSTS,
  HOST_LABEL,
  connectHost,
  detectHosts,
  hostConfigPath,
  type Host,
} from '../connectors.js';
import { PROVIDER_ENV, VENDORS, type Vendor } from '../keychain.js';
import { rememberFacts } from '../remember.js';
import { emit, jsonMode, nested } from '../output.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, echo, noteWarning, tilde, withWired, type Ctx } from '../util.js';
import type { Wired } from '../wire.js';
import { describeChange, hostArgs, hostContext } from './connect.js';
import { importCommand, parseSince, type ImportOutcome } from './import.js';
import { hookCommandPath, settingsFile } from './install.js';
import {
  canInstallManaged,
  checkAgentPath,
  inspectManaged,
  installCommandFor,
  installManaged,
  managedIsCurrent,
  riskOf,
  untrustedManagedMessage,
  manualInstall,
  plannedMain,
  runningUnstable,
  shownPrefix,
  thisCopyRefusal,
} from './managed.js';
import { managedPrefixFor } from './update.js';
import { keySource } from './keys.js';
import { modelsPullCommand } from './models.js';
import { keychainBlocker, runLogin } from './login.js';

export interface SetupOptions {
  yes?: boolean;
  /** `detected` (default), `none`, or a comma list of hosts. */
  agents?: string;
  /** `byo`, `pro` or `skip`. */
  keys?: string;
  /** `skip` (default) or an age such as `14d`. */
  import?: string;
  /** false with `--no-demo`. */
  demo?: boolean;
  /** No longer needed (setup installs the managed copy itself); accepted and ignored. */
  installGlobal?: boolean;
  /**
   * `--this-copy`, for developers testing their own build: agents run this copy even when a
   * managed copy is there, and nothing is installed. A copy that does not stay put is refused.
   */
  thisCopy?: boolean;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * How the wizard talks: clack prompts on a terminal, plain lines otherwise.
 * A question resolves `null` when the user cancels (Ctrl-C, Esc).
 */
export interface Prompter {
  readonly interactive: boolean;
  intro(title: string): void;
  step(n: number, title: string): void;
  info(text: string): void;
  outro(text: string): void;
  multiselect<T extends string>(
    message: string,
    options: Choice<T>[],
    initial: T[],
  ): Promise<T[] | null>;
  select<T extends string>(message: string, options: Choice<T>[], initial: T): Promise<T | null>;
  confirm(message: string, initial: boolean): Promise<boolean | null>;
}

export interface SetupDeps {
  prompter?: Prompter;
  /** This copy as agents would run it (default: the realpath of this bin, refused when it is not the bin). */
  bin?: () => string;
  /**
   * Why this copy is no place to point agents at (default: `runningUnstable`: a package cache,
   * a temp directory, fnm's per-shell link, a Node version manager), or undefined.
   */
  unstable?: () => string | undefined;
}

const STEPS = 6;

const KEY_HELP: Record<Vendor, { label: string; url: string; needs: string }> = {
  voyage: {
    label: 'Voyage AI',
    url: 'https://docs.voyageai.com/docs/api-key-and-installation',
    needs: 'embeddings and rerank (dense recall)',
  },
  typesafe: {
    label: 'TypeSafe',
    url: 'https://typesafe.ai (docs: https://docs.typesafe.ai/)',
    needs: 'the gate and reconcile decisions (saving memories)',
  },
  anthropic: {
    label: 'Anthropic',
    url: 'https://platform.claude.com/settings/keys',
    needs: 'the memory writer (saving memories)',
  },
};

class Cancelled extends Error {}

const answered = <T>(v: T | null): T => {
  if (v === null) throw new Cancelled();
  return v;
};

const indent = (text: string): string =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => (l === '' ? l : `  ${l}`))
    .join('\n');

/** Plain lines on stdout; never asks (every question was answered by a flag). */
function plainPrompter(ctx: Ctx, ui: Ui): Prompter {
  const no = async (): Promise<never> => {
    throw new Error('non-interactive setup asked a question');
  };
  return {
    interactive: false,
    intro: (t) => ctx.io.out(ui.header('setup', t)),
    step: (n, t) => ctx.io.out(`\n${ui.dim(`${n}/${STEPS}`)} ${ui.bold(t)}\n`),
    info: (t) => ctx.io.out(`${indent(t)}\n`),
    outro: (t) => ctx.io.out(`\n${t.trimEnd()}\n`),
    multiselect: no,
    select: no,
    confirm: no,
  };
}

/** clack on the terminal. */
function clackPrompter(ui: Ui): Prompter {
  const val = <T>(v: T | symbol): T | null => (clack.isCancel(v) ? null : (v as T));
  return {
    interactive: true,
    intro: (t) => clack.intro(t),
    step: (n, t) => clack.log.step(`${ui.dim(`${n}/${STEPS}`)} ${ui.bold(t)}`),
    info: (t) => clack.log.message(t.trimEnd()),
    outro: (t) => clack.outro(t.trimEnd()),
    async multiselect<T extends string>(message: string, options: Choice<T>[], initial: T[]) {
      return val<T[]>(
        await clack.multiselect({
          message,
          options: options as never,
          initialValues: initial,
          required: false,
        }),
      );
    },
    async select<T extends string>(message: string, options: Choice<T>[], initial: T) {
      return val<T>(
        await clack.select({ message, options: options as never, initialValue: initial }),
      );
    },
    async confirm(message, initial) {
      return val<boolean>(await clack.confirm({ message, initialValue: initial }));
    },
  };
}

type KeysMode = 'byo' | 'pro' | 'local' | 'skip' | 'have-pro';

interface Plan {
  agents?: Host[];
  keys?: Exclude<KeysMode, 'have-pro'>;
  /** An age (`14d`) or `skip`. */
  import?: string;
  demo: boolean;
}

/** Flags, checked before anything is touched. */
function planFrom(opts: SetupOptions, detected: Host[]): Plan {
  const plan: Plan = { demo: opts.demo !== false };
  if (opts.agents !== undefined) {
    const a = opts.agents.trim();
    plan.agents =
      a === 'none' || a === ''
        ? []
        : a === 'detected'
          ? detected
          : hostArgs(
              a
                .split(',')
                .map((x) => x.trim())
                .filter((x) => x !== ''),
            );
  }
  if (opts.keys !== undefined) {
    if (
      opts.keys !== 'byo' &&
      opts.keys !== 'pro' &&
      opts.keys !== 'local' &&
      opts.keys !== 'skip'
    ) {
      throw new Refusal(`--keys ${echo(opts.keys)} must be byo, pro, local or skip.`);
    }
    plan.keys = opts.keys;
  }
  if (opts.import !== undefined) {
    if (opts.import !== 'skip') parseSince(opts.import, new Date());
    plan.import = opts.import;
  }
  return plan;
}

function nonInteractiveHelp(detected: Host[]): string {
  const agents = detected.length > 0 ? detected.join(',') : 'claude-code';
  return [
    'setup never prompts when stdin is not a terminal. Pass --yes and your choices, for example:',
    `  oort setup --yes --agents ${agents} --keys byo --import skip`,
    `  --agents  detected (the default with --yes), none, or a comma list of: ${HOSTS.join(', ')}`,
    '  --keys    byo (report missing keys and where to get them), pro (oort login: Oort Pro, no vendor keys),',
    '            local (download local models, 58 MB: embeddings and rerank with no keys), or skip',
    '  --import  skip (the default) or an age such as 14d: imports Claude Code transcripts, using the writer',
    '  --no-demo skip the remember, recall and forget check',
  ].join('\n');
}

interface Done {
  what: string;
  undo: string;
}

/** A memory written straight to the store, for the demo when the write path is unavailable. */
function directMemory(text: string, scope: Scope, now: Date): Memory {
  const iso = now.toISOString();
  return {
    id: randomUUID(),
    scope,
    type: 'semantic',
    text,
    stub: 'oort setup demo word',
    entities: ['oort setup'],
    salience: 0.5,
    pinned: false,
    tier: 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: iso,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'setup', decisions: [] },
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * Remembers one harmless fact in a throwaway scope, recalls it, then forgets
 * everything in that scope. Without keys the fact is written directly (the
 * write path needs all three adapters), so recall and forget still show.
 */
async function demo(w: Wired, ui: Ui): Promise<string> {
  const projectId = `oort-setup-demo-${randomUUID().slice(0, 8)}`;
  const scope = localScope(projectId);
  const filter: ScopeFilter = {
    orgId: scope.orgId,
    customerId: scope.customerId,
    agentId: scope.agentId,
    projectIds: [projectId],
  };
  // The demo reads and writes only its throwaway project.
  const grant = localGrant(filter);
  const fact = 'The Oort setup demo word is nebula.';
  const lines: string[] = [];
  try {
    let via = 'through the write path (scrub, gate, writer)';
    try {
      const [r] = await rememberFacts(w, [fact], { harness: 'setup', scope });
      if (r?.outcome !== 'added') throw new Error(`the write path said ${r?.outcome ?? 'nothing'}`);
    } catch (e) {
      via =
        e instanceof Refusal
          ? 'directly (no keys yet, so the write path was skipped)'
          : `directly (${(e as Error).message})`;
      await w.store.upsert(grant, directMemory(fact, scope, new Date()));
    }
    lines.push(ui.ok(`remembered "${fact}" ${via}`));
    const r = await recall(
      { text: 'What is the Oort setup demo word?', scope: filter },
      {
        store: w.store,
        config: w.config,
        ...(w.embed !== undefined && { embed: w.embed }),
        ...(w.rerank !== undefined && { rerank: w.rerank }),
      },
    );
    const hit = r.memories[0];
    if (hit !== undefined) {
      const how = r.degraded?.includes('no-embedder') === true ? 'lexical-only' : 'hybrid';
      lines.push(ui.ok(`recalled it (${ui.tier(hit.tier)}, ${how}): "${hit.text}"`));
    } else {
      lines.push(ui.warn('recall did not find it; run `oort explain "demo word"` to see why'));
    }
  } finally {
    const left = await w.store.list(grant, { validOnly: false });
    for (const m of left) await w.store.forget(grant, m.id);
    lines.push(ui.ok(`forgot it: the throwaway scope ${projectId} is empty again`));
  }
  return lines.join('\n');
}

/**
 * `oort setup`: detect agents, choose keys, connect, offer an import, run a
 * demo, and finish with what changed and how to undo it. Every step can be
 * skipped; `--yes` with flags runs any path without a question, and a
 * session whose stdin is not a terminal never prompts.
 */
export async function setupCommand(
  opts: SetupOptions,
  ctx: Ctx,
  deps: SetupDeps = {},
): Promise<number> {
  const hc = hostContext(ctx);
  const detected = detectHosts(hc);
  const plan = planFrom(opts, detected);
  const terminal = ctx.io.stdinIsTTY && ctx.io.stdoutIsTTY === true;
  if (opts.yes !== true && !terminal) {
    throw new Refusal(nonInteractiveHelp(detected), {
      fix: `oort setup --yes --agents ${detected.length > 0 ? detected.join(',') : 'claude-code'} --keys byo --import skip${jsonMode(ctx) ? ' --json' : ''}`,
    });
  }
  const ui = uiFor(ctx.io);
  const interactive = opts.yes !== true;
  const p = interactive ? (deps.prompter ?? clackPrompter(ui)) : plainPrompter(ctx, ui);
  if (plan.agents === undefined && !interactive) plan.agents = detected;
  if (plan.keys === undefined && !interactive) plan.keys = 'byo';
  if (plan.import === undefined && !interactive) plan.import = 'skip';
  const done: Done[] = [];
  const show = (file: string): string => tilde(file, hc.home);
  const storeHome = resolveHome(ctx.io.env);
  const hadStore = fs.existsSync(storeHome);

  // The mark opens setup on a colour terminal; the header line follows either way.
  const art = ui.mark([
    '',
    `${ui.bold(ui.gradient('oort'))}  ${ui.dim(VERSION)}`,
    ui.dim('Six short steps: agents, keys, connect, import, a check.'),
    ui.dim('Every step can be skipped, and the last one shows how to undo.'),
  ]);
  if (art !== '') ctx.io.out(`${art}\n`);
  p.intro(
    interactive
      ? ui.color
        ? `${ui.wordmark()} ${ui.bold('setup')}`
        : 'oort setup'
      : 'non-interactive (--yes)',
  );
  try {
    // 1. Detect agents.
    p.step(1, 'Detect agents');
    p.info(
      ui.kv(
        HOSTS.map((h) => [
          HOST_LABEL[h],
          detected.includes(h)
            ? ui.ok(
                ui.dim(
                  show(h === 'claude-code' ? settingsFile(false, ctx) : hostConfigPath(h, hc)),
                ),
              )
            : ui.info(ui.dim('not found')),
        ]),
      ),
    );
    const agents =
      plan.agents ??
      answered(
        await p.multiselect(
          'Connect Oort to which agents?',
          HOSTS.map((h) => ({
            value: h,
            label: HOST_LABEL[h],
            hint: h === 'claude-code' ? 'hooks' : 'MCP server',
          })),
          detected,
        ),
      );

    // 2. Keys.
    p.step(2, 'Choose keys');
    const sources = new Map<Vendor, string>();
    for (const provider of VENDORS) sources.set(provider, await keySource(provider, ctx));
    const missing = VENDORS.filter((k) => sources.get(k) === 'missing');
    const oortSource = await keySource('oort', ctx);
    p.info(
      ui.kv([
        ...VENDORS.map(
          (k) =>
            [
              k,
              sources.get(k) === 'missing' ? ui.yellow('missing') : ui.green(sources.get(k) ?? ''),
            ] as const,
        ),
        ['oort', oortSource === 'missing' ? ui.dim('missing') : ui.green(oortSource)],
      ]),
    );
    // An Oort key already covers every role without a vendor key: nothing to choose.
    const keys: KeysMode =
      oortSource !== 'missing'
        ? 'have-pro'
        : (plan.keys ??
          answered(
            await p.select<KeysMode>(
              'How should Oort reach its model providers?',
              [
                {
                  value: 'pro',
                  label: 'Oort Pro',
                  hint: 'no keys, $19/month; signs in at oortcloud.dev (oort login)',
                },
                { value: 'byo', label: 'Bring my own keys', hint: 'Voyage, TypeSafe, Anthropic' },
                {
                  value: 'local',
                  label: 'Local models',
                  hint: 'no keys, no account: embed and rerank on this CPU (58 MB download)',
                },
                { value: 'skip', label: 'Skip for now', hint: 'recall works lexical-only' },
              ],
              missing.length === 0 ? 'skip' : 'byo',
            ),
          ));
    if (keys === 'have-pro') {
      p.info(
        ui.ok(
          `Oort Pro key found (${oortSource === 'env' ? 'OORT_API_KEY' : ctx.keychain.where('oort')}): ${
            missing.length === 0
              ? 'your own keys still win for every role.'
              : `${missing.join(', ')} go${missing.length === 1 ? 'es' : ''} through the Oort Pro relay; your own keys win where set.`
          }`,
        ),
      );
    } else if (keys === 'pro') {
      const blocker = keychainBlocker(ctx);
      if (blocker !== undefined) {
        p.info(ui.warn(`Oort Pro sign-in skipped: ${blocker}`));
      } else {
        let outcome;
        try {
          outcome = await runLogin(ctx, (t) => p.info(t), ui);
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          outcome = { ok: false as const, message: e.message };
        }
        if (outcome.ok) {
          done.push({
            what:
              ctx.keychain.kind === 'file'
                ? `stored the Oort Pro key in ${ctx.keychain.where('oort')}`
                : 'stored the Oort Pro key in the Keychain (oort.oort)',
            undo: 'oort logout (then revoke the key at oortcloud.dev/account)',
          });
        } else {
          p.info(ui.warn(`${outcome.message} Setup continues without Oort Pro.`));
        }
      }
    } else if (keys === 'byo') {
      if (missing.length === 0) p.info(ui.ok('All three keys are set.'));
      for (const k of missing) {
        const help = KEY_HELP[k];
        p.info(`${ui.bold(help.label)} for ${help.needs}: get a key at ${help.url}`);
        if (interactive && ctx.keychain.supported) {
          if (
            answered(
              await p.confirm(`Store your ${help.label} key in ${ctx.keychain.label} now?`, true),
            )
          ) {
            const code = await ctx.keychain.set(k);
            if (code === 0) {
              done.push({
                what:
                  ctx.keychain.kind === 'file'
                    ? `stored ${k} in ${ctx.keychain.where(k)}`
                    : `stored ${k} in the Keychain (oort.${k})`,
                undo: `oort keys rm ${k}`,
              });
            } else {
              p.info(
                ui.warn(`${ctx.keychain.label} did not store it; run \`oort keys set ${k}\` later`),
              );
            }
          }
        } else {
          p.info(
            ctx.keychain.supported
              ? `  then run: oort keys set ${k}`
              : `  then set ${PROVIDER_ENV[k]} in the environment your agent starts with (${ctx.io.env['OORT_NO_KEYCHAIN'] === '1' ? 'OORT_NO_KEYCHAIN=1 is set' : 'no key store here: the Keychain is macOS-only, credentials.json is for Linux and Windows'})`,
          );
        }
      }
      if (missing.includes('anthropic')) {
        p.info(
          ui.dim(
            'Keep ANTHROPIC_API_KEY out of your shell profile if you use Claude Code on a subscription; the Keychain avoids that.',
          ),
        );
      }
    } else if (keys === 'local') {
      try {
        await nested(ctx, () => modelsPullCommand([], {}, ctx));
        done.push({
          what: 'downloaded the local models to ~/.oort/models and switched embed and rerank to them',
          undo: 'oort models rm',
        });
        p.info(
          ui.dim(
            'Recall now embeds and reranks on this machine. Saving new memories still needs the TypeSafe and Anthropic keys (or Oort Pro).',
          ),
        );
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        p.info(
          ui.warn(`Local models skipped: ${e.message} Setup continues; recall works lexical-only.`),
        );
      }
    } else {
      p.info(
        'Skipped. Recall works lexical-only until keys are set (`oort keys set <provider>`, or `oort login` for Oort Pro), or local models are pulled (`oort models pull`).',
      );
    }

    // 3. Connect.
    p.step(3, 'Connect');
    const env = ctx.io.env;
    const managed: {
      prefix: string;
      status:
        'skipped' | 'reused' | 'installed' | 'declined' | 'failed' | 'unavailable' | 'untrusted';
      version: string | null;
      command: string | null;
      reason: string | null;
    } = {
      prefix: managedPrefixFor(env),
      status: 'skipped',
      version: null,
      command: null,
      reason: null,
    };
    let written: string | undefined;
    if (agents.length === 0) {
      p.info(
        'Skipped: no agents chosen. Later: `oort install claude-code` or `oort connect <host>`.',
      );
    } else {
      // Agents run the managed copy (~/.oort/cli): reused when it is this version or newer, else
      // installed once the changes are confirmed (CON-114). Without it, this copy, when it is one
      // that stays put; never npx's cache, a temp directory, fnm's link or a version manager.
      const prefix = shownPrefix(env);
      const manual = manualInstall(env);
      const why = (deps.unstable ?? (() => runningUnstable(ctx)))();
      let running: string | undefined;
      let problem = why === undefined ? '' : `This oort is in ${why}, ${riskOf(why)}.`;
      if (why === undefined) {
        try {
          running = (deps.bin ?? (() => hookCommandPath(ctx.io.entry)))();
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          problem = e.message;
        }
      }
      const unavailable = (because: string, verb: string): void => {
        if (running !== undefined) {
          const line = `The managed copy in ${prefix} ${verb} (${because}), so agents run this copy: ${show(running)}. For one that stays put: ${manual}, then oort install claude-code.`;
          noteWarning(ctx, 'managed-copy-unavailable', line);
          p.info(ui.warn(line));
        } else {
          p.info(
            ui.warn(
              `Skipped connecting: ${problem} The managed copy ${verb} (${because}): run ${manual}, then ${prefix}/bin/oort setup.`,
            ),
          );
        }
      };
      const state = inspectManaged(env);
      const current = state.state === 'ok' ? state.managed : undefined;
      let plan: { bin: string; install: boolean } | undefined;
      if (opts.thisCopy !== true && state.state === 'untrusted') {
        // Never reused, never installed over, never worked around (PR #78 review, I1).
        managed.status = 'untrusted';
        managed.reason = 'untrusted';
        p.info(ui.warn(`Skipped connecting: ${untrustedManagedMessage(state.problem, env)}`));
      } else if (opts.thisCopy === true) {
        managed.reason = 'this-copy';
        if (current !== undefined) managed.version = current.version;
        if (running !== undefined) {
          plan = { bin: running, install: false };
          p.info(
            ui.info(
              `--this-copy: agents run this copy, ${show(running)}${current !== undefined ? `, not the managed copy in ${prefix}` : ''}.`,
            ),
          );
        } else {
          p.info(
            ui.warn(
              `Skipped connecting: ${why !== undefined ? thisCopyRefusal(why, env, 'setup') : problem}`,
            ),
          );
        }
      } else if (managedIsCurrent(current)) {
        plan = { bin: current.main, install: false };
        managed.status = 'reused';
        managed.version = current.version;
        p.info(
          ui.ok(
            `Agents run the managed copy in ${prefix} (oort ${current.version}); oort update keeps it current.`,
          ),
        );
      } else {
        const can = canInstallManaged(ctx);
        if (can.ok) {
          plan = { bin: plannedMain(env), install: true };
          managed.command = installCommandFor(env);
        } else {
          managed.status = 'unavailable';
          managed.reason = can.reason;
          unavailable(can.because, 'cannot be installed');
          if (running !== undefined) plan = { bin: running, install: false };
        }
      }
      if (plan !== undefined) {
        const planned = plan.bin;
        const preview: string[] = [];
        if (plan.install) {
          preview.push(
            `${ui.bold('oort')}: the managed copy agents run, in ${prefix}\n${ui.green(`+ ${installCommandFor(env)}`)}`,
          );
        }
        for (const h of agents) {
          if (h === 'claude-code') {
            preview.push(
              `${ui.bold('Claude Code')}: hooks in ${show(settingsFile(false, ctx))}\n${HOOK_EVENTS.map((e) => ui.green(`+ hooks.${e}: ${planned} hook ${e}`)).join('\n')}`,
            );
          } else {
            try {
              preview.push(
                describeChange(ui, connectHost(h, hc, planned, { dryRun: true }), planned, {
                  dryRun: true,
                  home: hc.home,
                }).trimEnd(),
              );
            } catch (e) {
              if (!(e instanceof Refusal)) throw e;
              preview.push(ui.warn(`${HOST_LABEL[h]}: ${e.message}`));
            }
          }
        }
        if (interactive) p.info(preview.join('\n\n'));
        const go = interactive
          ? answered(
              await p.confirm(
                plan.install
                  ? `Install oort ${VERSION} in ${prefix} and write these changes?`
                  : 'Write these changes?',
                true,
              ),
            )
          : true;
        let bin: string | undefined = planned;
        if (!go) {
          if (plan.install) managed.status = 'declined';
          p.info(
            plan.install
              ? 'Nothing installed, and nothing changed in any agent config.'
              : 'Nothing changed in any agent config.',
          );
          bin = undefined;
        } else if (plan.install) {
          p.info(
            `Installing oort ${VERSION} in ${prefix}, the copy agents run: ${managed.command}`,
          );
          let r: Awaited<ReturnType<typeof installManaged>>;
          try {
            r = await installManaged(ctx);
          } catch (e) {
            if (!(e instanceof Refusal)) throw e;
            r = { ok: false, reason: 'failed', command: managed.command ?? '', detail: e.message };
          }
          if (r.ok) {
            bin = r.managed.main;
            managed.status = 'installed';
            managed.version = r.managed.version;
            p.info(
              ui.ok(
                `Installed oort ${r.managed.version} in ${prefix}: agents run it, and oort update keeps it current.`,
              ),
            );
            done.push({
              what: `installed oort ${r.managed.version} in ${prefix} (the copy agents run)`,
              undo: `npm rm -g --prefix ${prefix} oortmem`,
            });
          } else {
            managed.status = 'failed';
            managed.reason = r.reason;
            bin = running;
            unavailable(r.detail, 'could not be installed');
          }
        }
        if (bin !== undefined) {
          // The last check before any config is written: the path is still safe (PR #78, I1).
          try {
            checkAgentPath(bin, ctx);
          } catch (e) {
            if (!(e instanceof Refusal)) throw e;
            p.info(ui.warn(`Skipped connecting: ${e.message}`));
            bin = undefined;
          }
        }
        if (bin !== undefined) {
          written = bin;
          for (const h of agents) {
            try {
              if (h === 'claude-code') {
                const file = settingsFile(false, ctx);
                const { changed } = installHooks(file, bin);
                const backup = `${file}.oort-backup`;
                p.info(
                  changed
                    ? ui.ok(`Claude Code hooks (${HOOK_EVENTS.join(', ')}) in ${show(file)}`) +
                        (fs.existsSync(backup) ? `\n  backup  ${show(backup)}` : '')
                    : ui.ok(`Claude Code hooks are already installed in ${show(file)}.`),
                );
                if (changed)
                  done.push({
                    what: `Claude Code hooks in ${show(file)}`,
                    undo: 'oort uninstall claude-code',
                  });
              } else {
                const c = connectHost(h, hc, bin);
                p.info(describeChange(ui, c, bin, { home: hc.home }));
                if (c.changed)
                  done.push({
                    what: `${HOST_LABEL[h]} MCP entry in ${show(c.file)}`,
                    undo: `oort disconnect ${h}`,
                  });
              }
            } catch (e) {
              if (!(e instanceof Refusal)) throw e;
              p.info(ui.warn(`${HOST_LABEL[h]}: ${e.message}`));
            }
          }
        }
      }
    }

    // 4. Import.
    p.step(4, 'Import Claude Code history');
    let importOutcome: ImportOutcome | 'skipped' | 'failed' = 'skipped';
    const projects = path.join(hc.home, '.claude', 'projects');
    if (!fs.existsSync(projects)) {
      p.info(`Skipped: no Claude Code transcripts in ${show(projects)}.`);
    } else {
      const since =
        plan.import ??
        answered(
          await p.select(
            'Import recent Claude Code sessions? (estimates first, then asks before using the writer)',
            [
              { value: '14d', label: 'The last 14 days' },
              { value: '30d', label: 'The last 30 days' },
              { value: 'skip', label: 'Skip' },
            ],
            '14d',
          ),
        );
      if (since === 'skip') {
        p.info('Skipped. Later: `oort import claude-code --since 14d`.');
      } else {
        try {
          let outcome: ImportOutcome | undefined;
          importOutcome = 'failed';
          const code = await nested(ctx, () =>
            importCommand(
              {
                since,
                projectsDir: projects,
                onOutcome: (o) => {
                  outcome = o;
                },
                ...(interactive
                  ? {
                      confirmWith: async (est: { observations: number; estimatedTokens: number }) =>
                        answered(
                          await p.confirm(
                            `Import ${est.observations} observations (about ${est.estimatedTokens} writer tokens)?`,
                            false,
                          ),
                        ),
                    }
                  : { yes: true }),
              },
              ctx,
            ),
          );
          importOutcome = outcome ?? 'nothing';
          const undo = 'review with `oort inspect`, remove with `oort forget <id>`';
          const later = `\`oort import claude-code --since ${since}\``;
          if (code === 3 || outcome === 'partial') {
            done.push({
              what: `imported part of the Claude Code sessions since ${since}`,
              undo,
            });
            p.info(
              ui.warn(
                `Some sessions stopped at a failed observation; the rest were imported. Run ${later} to retry them.`,
              ),
            );
          } else if (outcome === 'imported') {
            done.push({ what: `imported Claude Code sessions since ${since}`, undo });
          } else if (outcome === 'declined') {
            p.info(`Nothing imported. Later: ${later}.`);
          } else {
            p.info(`No Claude Code sessions to import since ${since}.`);
          }
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          p.info(ui.warn(e.message));
        }
      }
    }

    // 5. Demo.
    p.step(5, 'Check it works');
    const runDemo =
      plan.demo &&
      (!interactive ||
        answered(await p.confirm('Run a quick remember, recall, forget check?', true)));
    if (!runDemo) {
      p.info('Skipped.');
    } else {
      p.info(await withWired(ctx, (w) => demo(w, ui)));
      if (!hadStore && fs.existsSync(storeHome)) {
        done.push({
          what: `created the local store in ${show(storeHome)}`,
          undo: `rm -r ${show(storeHome)} (deletes every memory)`,
        });
      }
    }

    // 6. Finish.
    p.step(6, 'Done');
    p.info(
      done.length === 0
        ? 'Nothing changed.'
        : ui.kv(done.flatMap((d) => [['changed', d.what] as const, ['undo', d.undo] as const])),
    );
    p.outro(
      done.length === 0
        ? 'Run `oort setup` again any time.'
        : 'Restart the agents you connected. `oort recall "<question>"` shows what they will see.',
    );
    if (jsonMode(ctx)) {
      emit(ctx, {
        agents,
        keys,
        import: importOutcome,
        demo: runDemo,
        command: written ?? null,
        binary:
          written === undefined
            ? null
            : managed.status === 'reused' || managed.status === 'installed'
              ? 'managed'
              : 'running',
        managed,
        changed: done,
      });
    }
    return 0;
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    const summary =
      done.length === 0
        ? 'Setup cancelled; nothing changed.'
        : `Setup cancelled. Already changed:\n${done.map((d) => `  ${d.what} (undo: ${d.undo})`).join('\n')}`;
    p.outro(summary);
    return 1;
  }
}
