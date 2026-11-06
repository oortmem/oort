import { z } from 'zod';
import { closeCloudPool } from '../cloud-http.js';
import { wireEngine, type Engine } from '../wire.js';
import * as cloud from './cloud.js';
import { Aborted, abortable, type Ctx } from './context.js';
import { OortNeedsLoginError, OortUsageError, toOortError, type OortError } from './errors.js';
import * as judge from './judge.js';
import * as local from './local.js';
import {
  agentFor,
  agentName,
  checkUser,
  requireUserIfNamed,
  principalOf,
  projectIdFor,
  refuseStarWithUser,
} from './principal.js';
import type {
  ConsolidateResult,
  Explanation,
  ForgetResult,
  JudgeItem,
  JudgeOptions,
  JudgeRole,
  JudgmentInput,
  MemoryType,
  MemoryView,
  ObserveResult,
  Oort,
  OortJudge,
  OortOptions,
  PinResult,
  RecallOptions,
  RecallResult,
  RememberResult,
  ScopedOptions,
  Turn,
  Warning,
  Whoami,
} from './types.js';
import {
  ConsolidateSchema,
  FactsSchema,
  ForgetOptionsSchema,
  IdSchema,
  JudgeItemSchema,
  JudgeListSchema,
  JudgeOptionsSchema,
  JudgmentInputSchema,
  OptionsSchema,
  QuerySchema,
  RecallOptionsSchema,
  RecentOptionsSchema,
  RememberOptionsSchema,
  ScopedSchema,
  SignalOnlySchema,
  TurnSchema,
  check,
} from './validate.js';

/** Shared by a root handle and every handle `scoped()` derives from it. */
interface Root {
  engine: Engine;
  closed: boolean;
  now: () => Date;
  /** This root took a reference on the process's keep-alive pool (cloud mode). */
  pooled: boolean;
}

/** One handle's fixed principal and judge role. */
interface State {
  ctx: Ctx;
  org: string;
  /** The cwd's own project (for `statedPrivacy`), resolved once by the engine. */
  cwdProject: string | undefined;
  isRoot: boolean;
}

/** Live keep-alive pool references: the pool closes when the last cloud root closes. */
let poolRefs = 0;

const CLOUD_ONLY = ['url', 'timeoutMs', 'fetch'] as const;
const LOCAL_ONLY = ['user', 'org', 'config', 'migrate', 'judge', 'projectConfig'] as const;

/** Refuses an option the resolved mode does not take: never silently ignored. */
function checkMode(o: OortOptions, mode: 'local' | 'cloud'): void {
  const set = (k: keyof OortOptions): boolean => o[k] !== undefined;
  if (mode === 'local') {
    for (const k of CLOUD_ONLY) if (set(k)) throw local.notInMode(k, mode);
    return;
  }
  for (const k of LOCAL_ONLY) if (set(k)) throw local.notInMode(k, mode);
  if (o.mode === 'cloud' && set('home')) throw local.notInMode('home', mode);
  for (const k of ['voyage', 'typesafe', 'anthropic'] as const) {
    if (o.keys?.[k] !== undefined) throw local.notInMode(`keys.${k}`, mode);
  }
}

class OortHandle implements Oort {
  readonly #root: Root;
  readonly #s: State;

  constructor(root: Root, s: State) {
    this.#root = root;
    this.#s = s;
  }

  get mode(): 'local' | 'cloud' {
    return this.#root.engine.mode;
  }

  /** Runs one call: closed and abort checks, then any error as an `OortError`. */
  async #run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    if (this.#root.closed) {
      throw new OortUsageError('This Oort handle is closed.', { reason: 'closed' });
    }
    try {
      return await fn(this.#s.ctx);
    } catch (e) {
      if (e instanceof Aborted) throw e.reason;
      throw toOortError(e);
    }
  }

  #cloud(): boolean {
    return this.#root.engine.mode === 'cloud';
  }

  recall(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    return this.#run(async (ctx) => {
      const q = check(QuerySchema, query, 'query');
      const o = check(RecallOptionsSchema, opts, 'recall options');
      return abortable(o.signal, () => local.recall(ctx, q, o));
    });
  }

  observe(turn: Turn, opts: { signal?: AbortSignal } = {}): Promise<ObserveResult> {
    return this.#run(async (ctx) => {
      const t = check(TurnSchema, turn, 'turn');
      const { signal } = check(SignalOnlySchema, opts, 'observe options');
      return abortable(signal, () =>
        this.#cloud() ? cloud.observe(ctx, t) : local.observe(ctx, t),
      );
    });
  }

  remember(
    facts: string | readonly string[],
    opts: { type?: MemoryType } = {},
  ): Promise<RememberResult> {
    return this.#run(async (ctx) => {
      const list = check(FactsSchema, typeof facts === 'string' ? [facts] : facts, 'facts');
      const { type } = check(RememberOptionsSchema, opts, 'remember options');
      return this.#cloud() ? cloud.remember(ctx, list, type) : local.remember(ctx, list, type);
    });
  }

  forget(id: string, opts: { everywhere?: boolean } = {}): Promise<ForgetResult> {
    return this.#run(async (ctx) => {
      const ref = check(IdSchema, id, 'id');
      const everywhere = check(ForgetOptionsSchema, opts, 'forget options').everywhere === true;
      return this.#cloud()
        ? cloud.forget(ctx, ref, everywhere)
        : local.forget(ctx, ref, everywhere);
    });
  }

  pin(id: string): Promise<PinResult> {
    return this.#pin(id, true);
  }

  unpin(id: string): Promise<PinResult> {
    return this.#pin(id, false);
  }

  #pin(id: string, pinned: boolean): Promise<PinResult> {
    return this.#run(async (ctx) => {
      const ref = check(IdSchema, id, 'id');
      return this.#cloud() ? cloud.pin(ctx, ref, pinned) : local.pin(ctx, ref, pinned);
    });
  }

  recent(
    opts: { since?: string | Date; limit?: number } = {},
  ): Promise<{ memories: MemoryView[]; warnings: Warning[] }> {
    return this.#run(async (ctx) => {
      const o = check(RecentOptionsSchema, opts, 'recent options');
      const limit = o.limit ?? 20;
      return this.#cloud() ? cloud.recent(ctx, o.since, limit) : local.recent(ctx, o.since, limit);
    });
  }

  explain(id: string): Promise<Explanation> {
    return this.#run(async (ctx) => {
      const ref = check(IdSchema, id, 'id');
      return this.#cloud() ? cloud.explain(ctx, ref) : local.explain(ctx, ref);
    });
  }

  whoami(): Promise<Whoami> {
    return this.#run(async (ctx) => (this.#cloud() ? cloud.whoami(ctx) : local.whoami(ctx)));
  }

  consolidate(opts: { budgetMs?: number; signal?: AbortSignal } = {}): Promise<ConsolidateResult> {
    return this.#run(async (ctx) => {
      const o = check(ConsolidateSchema, opts, 'consolidate options');
      if (this.#cloud()) throw cloud.localOnly('Consolidation');
      return abortable(o.signal, () => local.consolidate(ctx, o.budgetMs, o.signal));
    });
  }

  get judge(): OortJudge {
    return {
      record: (input: JudgmentInput) =>
        this.#run((ctx) => judge.record(ctx, check(JudgmentInputSchema, input, 'judgment'))),
      apply: (item: string | JudgeItem, opts: JudgeOptions = {}) =>
        this.#run((ctx) =>
          judge.apply(
            ctx,
            check(JudgeItemSchema, item, 'item'),
            check(JudgeOptionsSchema, opts, 'judge options'),
          ),
        ),
      list: (opts = {}) =>
        this.#run((ctx) => judge.list(ctx, check(JudgeListSchema, opts, 'list options'))),
      confirm: (id: string) => this.#run((ctx) => judge.confirm(ctx, check(IdSchema, id, 'id'))),
    };
  }

  scoped(s: ScopedOptions): Oort {
    if (this.#root.closed) {
      throw new OortUsageError('This Oort handle is closed.', { reason: 'closed' });
    }
    try {
      requireUserIfNamed(s);
      const o = check(ScopedSchema, s, 'scoped options');
      const { ctx, org } = this.#s;
      const engine = this.#root.engine;
      if (o.user !== undefined && engine.mode === 'cloud') {
        throw new OortUsageError(
          'user is not available in cloud mode yet: one Oort key is one account (CON-92).',
          { reason: 'invalid-argument' },
        );
      }
      checkUser(o.user, o.user === undefined ? undefined : org);
      const user = o.user ?? ctx.user;
      const agent =
        o.agent === undefined ? ctx.principal.agent : agentFor(engine.config.home, {}, o.agent);
      refuseStarWithUser(agent, user);
      const projectId =
        o.project === undefined ? ctx.principal.scope.projectId : projectIdFor(o.project, engine);
      const principal = principalOf(engine, { org, user, agent, projectId });
      const child: Ctx = {
        ...ctx,
        principal,
        user,
        statedPrivacy: projectId === this.#s.cwdProject ? engine.statedPrivacy : undefined,
        judge: { role: o.judgeRole ?? ctx.judge.role, operator: ctx.judge.operator },
      };
      return new OortHandle(this.#root, { ...this.#s, ctx: child, isRoot: false });
    } catch (e) {
      throw toOortError(e);
    }
  }

  async close(): Promise<void> {
    if (!this.#s.isRoot || this.#root.closed) return;
    this.#root.closed = true;
    await this.#root.engine.close();
    if (this.#root.pooled && --poolRefs === 0) await closeCloudPool();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** What a log line may show: the mode and the scope. Never a key. */
  #summary(): { mode: string; scope: Record<string, string | null> } {
    const { scope, agent } = this.#s.ctx.principal;
    return {
      mode: this.#root.engine.mode,
      scope: {
        org: scope.orgId,
        user: this.#s.ctx.user,
        agent: agent.source === 'none' ? null : agent.id,
        project: scope.projectId ?? null,
      },
    };
  }

  toJSON(): { mode: string; scope: Record<string, string | null> } {
    return this.#summary();
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    const { mode, scope } = this.#summary();
    return `Oort ${JSON.stringify({ mode, scope })}`;
  }
}

/**
 * The internal test hook (§10.2): fake adapters, a fixed clock, a keychain double. Not exported
 * from the package root, so no shipped entry point can swap in fake models.
 */
export interface Internals {
  adapters?: { embed?: unknown; rerank?: unknown; decide?: unknown; write?: unknown };
  now?: () => Date;
  keychain?: (
    provider: 'voyage' | 'typesafe' | 'anthropic' | 'oort',
  ) => Promise<string | undefined>;
}

/**
 * A handle on Oort memory. `mode: 'auto'` (the default) uses what `oort setup` chose on this
 * machine; servers pass `mode`, `home`, `org`, `project`, `projectConfig: false` and `keySources`
 * explicitly. Makes no network request; local mode opens the store and loads the adapters.
 */
export async function createOort(options: OortOptions = {}): Promise<Oort> {
  return createOortWith(options, {});
}

/** `createOort` with the test hook's internals. */
export async function createOortWith(options: OortOptions, internals: Internals): Promise<Oort> {
  let engine: Engine | undefined;
  try {
    requireUserIfNamed(options);
    const o = check(OptionsSchema, options, 'options') as OortOptions;
    if (o.config !== undefined && 'serve' in o.config) {
      throw new OortUsageError('config.serve cannot be set from code (the home config only).', {
        reason: 'invalid-argument',
      });
    }
    if (o.keys !== undefined && o.keySources !== undefined && !o.keySources.includes('explicit')) {
      throw new OortUsageError(
        "keys were given, but keySources leaves out 'explicit', so they would be ignored; add 'explicit' to keySources or drop keys.",
        { reason: 'invalid-argument' },
      );
    }
    if (o.mode === 'local' || o.mode === 'cloud') checkMode(o, o.mode);
    checkUser(o.user, o.org);
    const env: Record<string, string | undefined> = { ...(o.env ?? process.env) };
    if (o.home !== undefined) env['OORT_HOME'] = o.home;
    if (o.url !== undefined) env['OORT_CLOUD_URL'] = o.url;
    const cwd = o.cwd ?? process.cwd();
    agentName(env, o.agent);
    try {
      engine = await wireEngine({
        cwd,
        env,
        mode: o.mode ?? 'auto',
        projectWarning: o.project === undefined,
        cloudKeepAlive: o.fetch === undefined,
        ...(o.projectConfig !== undefined && { projectConfig: o.projectConfig }),
        ...(o.migrate !== undefined && { migrate: o.migrate }),
        ...(o.timeoutMs !== undefined && { cloudTimeoutMs: o.timeoutMs }),
        ...(o.fetch !== undefined && { fetch: o.fetch }),
        ...(o.config !== undefined && { configOverlay: o.config as Record<string, unknown> }),
        ...(o.keys !== undefined && { explicitKeys: { ...o.keys } }),
        ...(o.keySources !== undefined && { keySources: o.keySources }),
        ...(internals.adapters !== undefined && { adapters: internals.adapters }),
        ...(internals.keychain !== undefined && { keychain: internals.keychain }),
      });
    } catch (e) {
      throw configError(e);
    }
    checkMode(o, engine.mode);
    if (engine.mode === 'cloud' && engine.cloud === undefined) {
      if (engine.cloudProblem !== undefined && /OORT_CLOUD_URL/.test(engine.cloudProblem)) {
        throw new OortUsageError(
          'url (or OORT_CLOUD_URL) must be an https URL, or http to localhost, with no credentials or query.',
          { reason: 'invalid-argument' },
        );
      }
      throw new OortNeedsLoginError(
        'Cloud mode needs the Oort key: run `oort login`, or pass keys.oort.',
        {
          reason: 'no-key',
        },
      );
    }
    const agent = agentFor(engine.config.home, env, o.agent);
    const user = o.user ?? null;
    const org = o.org ?? 'local';
    const projectId = projectIdFor(o.project, engine);
    const principal = principalOf(engine, { org, user, agent, projectId });
    const role: JudgeRole = o.judge?.role ?? 'agent';
    const operator = o.judge?.operator ?? engine.config.judge.operator ?? 'local-user';
    const pooled = engine.mode === 'cloud' && o.fetch === undefined;
    if (pooled) poolRefs++;
    const root: Root = { engine, closed: false, now: internals.now ?? (() => new Date()), pooled };
    const ctx: Ctx = {
      engine,
      principal,
      user,
      now: root.now,
      statedPrivacy: projectId === engine.project.projectId ? engine.statedPrivacy : undefined,
      judge: { role, operator },
      warnings: engine.warnings.map((w) => ({ code: w.code, message: w.message })),
    };
    return new OortHandle(root, {
      ctx,
      org,
      cwdProject: engine.project.projectId,
      isRoot: true,
    });
  } catch (e) {
    await engine?.close().catch(() => {});
    throw toOortError(e);
  }
}

/** A config problem (the overlay, or a config file) as a usage error naming the fields. */
function configError(e: unknown): unknown {
  if (e instanceof z.ZodError) {
    const fields = [...new Set(e.issues.map((i) => ['config', ...i.path.map(String)].join('.')))];
    return new OortUsageError(`config: invalid fields ${fields.join(', ')}.`, {
      reason: 'invalid-argument',
    });
  }
  if (e instanceof Error && e.message.startsWith('Invalid config file')) {
    return new OortUsageError(
      'A config file (config.json or oort.config.json) is invalid; `oort doctor` names the problem.',
      { fix: 'oort doctor', reason: 'invalid-argument' },
    );
  }
  return e;
}

export type { OortError };
