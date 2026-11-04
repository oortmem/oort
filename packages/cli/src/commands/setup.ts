import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import { HOOK_EVENTS, installHooks } from '@oortmem/claude-code';
import {
  localScope,
  recall,
  resolveHome,
  type Memory,
  type Scope,
  type ScopeFilter,
} from '@oortmem/core';
import {
  HOSTS,
  HOST_LABEL,
  connectHost,
  detectHosts,
  hostConfigPath,
  type Host,
} from '../connectors.js';
import { PROVIDERS, PROVIDER_ENV, type Provider } from '../keychain.js';
import { rememberFacts } from '../remember.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, echo, tilde, withWired, type Ctx } from '../util.js';
import type { Wired } from '../wire.js';
import { describeChange, hostArgs, hostContext } from './connect.js';
import { importCommand, parseSince } from './import.js';
import { hookCommandPath, settingsFile } from './install.js';
import { keySource } from './keys.js';

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
  /** The command written into host configs (default: the realpath of this bin, refused when temporary). */
  bin?: () => string;
}

const STEPS = 6;

const KEY_HELP: Record<Provider, { label: string; url: string; needs: string }> = {
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
    step: (n, t) => ctx.io.out(`\n${ui.bold(`${n}/${STEPS} ${t}`)}\n`),
    info: (t) => ctx.io.out(`${indent(t)}\n`),
    outro: (t) => ctx.io.out(`\n${t.trimEnd()}\n`),
    multiselect: no,
    select: no,
    confirm: no,
  };
}

/** clack on the terminal. */
function clackPrompter(): Prompter {
  const val = <T>(v: T | symbol): T | null => (clack.isCancel(v) ? null : (v as T));
  return {
    interactive: true,
    intro: (t) => clack.intro(t),
    step: (n, t) => clack.log.step(`${n}/${STEPS} ${t}`),
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

type KeysMode = 'byo' | 'pro' | 'skip';

interface Plan {
  agents?: Host[];
  keys?: KeysMode;
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
    if (opts.keys !== 'byo' && opts.keys !== 'pro' && opts.keys !== 'skip') {
      throw new Refusal(`--keys ${echo(opts.keys)} must be byo, pro or skip.`);
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
    '  --keys    byo (report missing keys and where to get them), pro, or skip',
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
      await w.store.upsert(directMemory(fact, scope, new Date()));
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
    const left = await w.store.list(filter, { validOnly: false });
    for (const m of left) await w.store.forget(m.id);
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
  if (opts.yes !== true && !terminal) throw new Refusal(nonInteractiveHelp(detected));
  const ui = uiFor(ctx.io);
  const interactive = opts.yes !== true;
  const p = interactive ? (deps.prompter ?? clackPrompter()) : plainPrompter(ctx, ui);
  if (plan.agents === undefined && !interactive) plan.agents = detected;
  if (plan.keys === undefined && !interactive) plan.keys = 'byo';
  if (plan.import === undefined && !interactive) plan.import = 'skip';
  const done: Done[] = [];
  const show = (file: string): string => tilde(file, hc.home);
  const storeHome = resolveHome(ctx.io.env);
  const hadStore = fs.existsSync(storeHome);

  p.intro(interactive ? 'oort setup' : 'non-interactive (--yes)');
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
            : ui.dim('· not found'),
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
    const sources = new Map<Provider, string>();
    for (const provider of PROVIDERS) sources.set(provider, await keySource(provider, ctx));
    const missing = PROVIDERS.filter((k) => sources.get(k) === 'missing');
    p.info(
      ui.kv(
        PROVIDERS.map((k) => [
          k,
          sources.get(k) === 'missing' ? ui.yellow('missing') : ui.green(sources.get(k) ?? ''),
        ]),
      ),
    );
    const keys =
      plan.keys ??
      answered(
        await p.select<KeysMode>(
          'How should Oort reach its model providers?',
          [
            { value: 'byo', label: 'Bring my own keys', hint: 'Voyage, TypeSafe, Anthropic' },
            {
              value: 'pro',
              label: 'Oort Pro (coming in this release)',
              hint: 'no keys, $19/month',
            },
            { value: 'skip', label: 'Skip for now', hint: 'recall works lexical-only' },
          ],
          missing.length === 0 ? 'skip' : 'byo',
        ),
      );
    if (keys === 'pro') {
      p.info(
        'Oort Pro (no keys, $19/month) arrives in this release: `oort login` signs you in at oortcloud.dev and lands shortly. Continuing without it for now.',
      );
    } else if (keys === 'byo') {
      if (missing.length === 0) p.info(ui.ok('All three keys are set.'));
      for (const k of missing) {
        const help = KEY_HELP[k];
        p.info(`${ui.bold(help.label)} for ${help.needs}: get a key at ${help.url}`);
        if (interactive && ctx.keychain.supported) {
          if (
            answered(await p.confirm(`Store your ${help.label} key in the Keychain now?`, true))
          ) {
            const code = await ctx.keychain.set(k);
            if (code === 0) {
              done.push({
                what: `stored ${k} in the Keychain (oort.${k})`,
                undo: `oort keys rm ${k}`,
              });
            } else {
              p.info(ui.warn(`the Keychain did not store it; run \`oort keys set ${k}\` later`));
            }
          }
        } else {
          p.info(
            ctx.keychain.supported
              ? `  then run: oort keys set ${k}`
              : `  then export ${PROVIDER_ENV[k]}=... (${ctx.io.env['OORT_NO_KEYCHAIN'] === '1' ? 'OORT_NO_KEYCHAIN=1 is set' : 'the Keychain is macOS-only for now'})`,
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
    } else {
      p.info('Skipped. Recall works lexical-only until keys are set (`oort keys set <provider>`).');
    }

    // 3. Connect.
    p.step(3, 'Connect');
    if (agents.length === 0) {
      p.info(
        'Skipped: no agents chosen. Later: `oort install claude-code` or `oort connect <host>`.',
      );
    } else {
      let cmd: string | undefined;
      try {
        cmd = (deps.bin ?? (() => hookCommandPath(ctx.io.entry)))();
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        p.info(ui.warn(`Skipped: ${e.message}`));
      }
      if (cmd !== undefined) {
        const bin = cmd;
        const preview: string[] = [];
        for (const h of agents) {
          if (h === 'claude-code') {
            preview.push(
              `${ui.bold('Claude Code')}: hooks in ${show(settingsFile(false, ctx))}\n${HOOK_EVENTS.map((e) => ui.green(`+ hooks.${e}: ${bin} hook ${e}`)).join('\n')}`,
            );
          } else {
            try {
              preview.push(
                describeChange(ui, connectHost(h, hc, bin, { dryRun: true }), bin, {
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
        const go = interactive ? answered(await p.confirm('Write these changes?', true)) : true;
        if (!go) {
          p.info('Nothing changed in any agent config.');
        } else {
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
          await importCommand(
            {
              since,
              projectsDir: projects,
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
          );
          done.push({
            what: `imported Claude Code sessions since ${since}`,
            undo: 'review with `oort inspect`, remove with `oort forget <id>`',
          });
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
