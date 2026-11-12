import { HOOK_TIMEOUTS, createHookLogger, runHook, type HookEvent } from '@oortmem/claude-code';
import { VERSION, resolveHome, type MemoryStore } from '@oortmem/core';
import { StoreMigrationRequiredError } from '@oortmem/store-sqlite';
import { cloudRemote } from '../cloud-remote.js';
import { LOCAL_PROVIDER } from '../local-models.js';
import { HOOK_STDIN_CAP_MS, type Env } from '../io.js';
import { timingLine } from '../timing-line.js';
import { sessionStartNotice } from '../update-check.js';
import { echo, starInCloudMessage, type Ctx } from '../util.js';
import type { AdapterRole, WireOptions, Wired } from '../wire.js';

export const HOOK_COMMAND_EVENTS: readonly HookEvent[] = [
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
  'drain',
];

export { HOOK_STDIN_CAP_MS } from '../io.js';
/** Exit this long before Claude Code's own hook timeout would discard the output. */
const DEADLINE_MARGIN_MS = 1000;
/**
 * A hook waits at most this long for the store's write lock (held, say, by a
 * drain). SQLite's busy wait is synchronous: it freezes the event loop, the
 * deadline timer included, so it must stay short. The drain keeps the default.
 */
export const HOOK_BUSY_TIMEOUT_MS = 250;

/** The one stderr line a hook prints when the store still needs its schema migration. */
export const MIGRATION_PENDING_NOTE =
  'Oort is upgrading its store; run `oort doctor` once, then restart any Oort MCP server started before the upgrade\n';

/** SQLite's "another connection holds the lock" errors. */
export function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  );
}

/** `store`, noting through `onBusy` any call that failed on the lock (the handlers swallow errors). */
function busyAware(store: MemoryStore, onBusy: () => void): MemoryStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          if (isBusy(e)) onBusy();
          throw e;
        }
      };
    },
  });
}

const isEvent = (e: string): e is HookEvent =>
  (HOOK_COMMAND_EVENTS as readonly string[]).includes(e);

/** The session's cwd from the hook input, so config and scope follow the session, not our cwd. */
export function inputCwd(stdin: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(stdin);
    if (typeof raw === 'object' && raw !== null && 'cwd' in raw) {
      const cwd = (raw as { cwd: unknown }).cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
  } catch {
    // runHook logs the invalid input.
  }
  return undefined;
}

/**
 * The adapters each event needs. UserPromptSubmit only recalls; Stop and SessionStart call no
 * model; the drain writes memories. Loading fewer adapters skips their key reads and SDK imports.
 */
const HOOK_ROLES: Record<HookEvent, readonly AdapterRole[]> = {
  UserPromptSubmit: ['embed', 'rerank'],
  SessionStart: [],
  Stop: [],
  drain: ['embed', 'rerank', 'decide', 'write'],
};

/**
 * How a hook wires the engine, in-process or in `oort serve`: never migrating, a short lock wait,
 * the adapters `roles` (default: the event's own), always as Claude Code.
 */
export function hookWireOptions(
  event: HookEvent,
  env: Env,
  roles: readonly AdapterRole[] = HOOK_ROLES[event],
): WireOptions {
  return {
    env,
    // Oort Cloud: a recall must answer inside the hook's own budget.
    cloudTimeoutMs: event === 'drain' ? 30_000 : 1400,
    // The drain serves every project's queue: home config only, whatever lies above OORT_HOME.
    ...(event === 'drain' ? { projectConfig: false } : { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS }),
    // A schema migration copies and rebuilds the whole store: never inside a hook.
    migrate: false,
    roles,
    // The hooks are Claude Code's: they always act as that agent.
    agent: 'claude-code',
  };
}

export interface WiredHookOptions {
  /** How long wiring took (0 for the daemon's warm engine); the hook log records it. */
  wireMs: number;
  /** Where the one stderr line of a Stop in cloud mode goes. */
  err: (text: string) => void;
  /** Starts a detached drain in `home`. */
  spawnDrain: (home: string) => void;
  /** Set by `oort serve`: its log lines carry `daemon: 1`. */
  daemon?: boolean;
}

/**
 * The prompt hook keeps its own, shorter rerank wait (CON-136): it runs before every prompt, while
 * `oort recall`, `oort mcp` and the SDK wait up to `recall.rerankBudgetMs`.
 */
export function promptRecallConfig<C extends PromptConfig>(config: C): C {
  return {
    ...config,
    recall: {
      ...config.recall,
      rerankBudgetMs: config.recall.promptRerankBudgetMs,
      // CON-131: a kept reranker in `fast` mode runs only on a gate miss.
      ...(config.recall.promptMode === 'fast' && promptReranker(config)
        ? { rerankWhen: 'gate-miss' as const }
        : {}),
    },
  };
}

type PromptConfig = {
  rerank: { provider: string };
  recall: {
    rerankBudgetMs: number;
    promptRerankBudgetMs: number;
    promptMode: 'full' | 'fast' | 'lexical';
    promptGateMissRerank: boolean;
    rerankWhen: 'always' | 'gate-miss';
  };
};

/**
 * Whether the prompt hook keeps the reranker. A local reranker would load in this short-lived
 * process on every prompt: about 450 ms and 600 ms of CPU, often past the rerank budget anyway, and
 * it is English-only, so the hook never uses it (CON-15). Otherwise `full` keeps it, `fast` keeps
 * it only for the gate-miss rerank (`recall.promptGateMissRerank`, CON-131), and `lexical` never.
 */
export function promptReranker(config: PromptConfig): boolean {
  if (config.rerank.provider === LOCAL_PROVIDER) return false;
  const { promptMode, promptGateMissRerank } = config.recall;
  return promptMode === 'full' || (promptMode === 'fast' && promptGateMissRerank);
}

/**
 * Runs `event` on an engine already wired for it, as the in-process hook and `oort serve` both
 * do: the same handlers, the same injection format and scrubbing. Resolves the hook's stdout,
 * empty when the store was locked (the log then records `degraded:busy`), or `skipped` when a Star
 * agent in cloud mode must not save. Never throws for a handler's failure (runHook swallows it).
 */
export async function runWiredHook(
  event: HookEvent,
  stdin: string,
  w: Wired,
  opts: WiredHookOptions,
): Promise<{ stdout: string; skipped?: true; timings?: Record<string, number> }> {
  const logEntry = (outcome: string, degraded?: string[]): void =>
    w.harnessLog.write({
      event,
      session: null,
      project: null,
      outcome,
      counts: opts.daemon === true ? { daemon: 1 } : {},
      timings: {},
      ...(degraded !== undefined && { degraded }),
    });
  for (const warning of w.warnings) logEntry(`config:${warning.code}`);
  const home = w.config.home;
  const {
    harnessLog,
    unavailable: _u,
    close: _c,
    scope: _s,
    agent,
    warnings: _w,
    store,
    mode: _m,
    cloud: _cl,
    cloudProblem: _cp,
    embedder: _e,
    reembedWith: _r,
    rerank,
    ...engine
  } = w;
  // Claude Code keeps a Star, which Oort Cloud does not have: saving would put its memories
  // on the shared Planet. Fail open: nothing is saved, recall still works, one stderr line.
  const starInCloud = w.mode === 'cloud' && agent.home === 'star';
  if (starInCloud && event === 'Stop') opts.err(`oort: ${starInCloudMessage(agent.id)}\n`);
  if (starInCloud && (event === 'Stop' || event === 'drain')) {
    logEntry('skipped:star-in-cloud');
    return { stdout: '', skipped: true };
  }
  // A local reranker would load in this short-lived process on every prompt: about 450 ms
  // and 600 ms of CPU, often past the rerank budget anyway. The prompt hook ranks by fusion
  // and the relevance gate instead; `oort mcp` and `oort recall` keep it (CON-15). `oort serve`
  // follows the hook, so a prompt gets the same context whichever process answers it.
  // `recall.promptMode` (CON-101) trades more for speed on the prompt hook only: `fast` drops any
  // reranker (unless `recall.promptGateMissRerank` keeps a hosted one for gate misses, CON-131),
  // `lexical` the query embedding too. In cloud mode the API is asked to do the same,
  // and to follow `recall.lexicalFirst` (skip the embedding when the lexical answer is clear).
  const prompt = event === 'UserPromptSubmit';
  const promptMode = w.config.recall.promptMode;
  const hookRerank = prompt && !promptReranker(w.config) ? undefined : rerank;
  const hookEmbed = prompt && promptMode === 'lexical' ? undefined : engine.embed;
  const { embed: _embed, ...rest } = engine;
  let busy = false;
  // The event's own timings as its log line records them (numbers only), for OORT_HOOK_TIMING.
  let timings: Record<string, number> | undefined;
  // The scope is left out: each handler derives it from the session's cwd.
  const out = await runHook(event, stdin, {
    ...rest,
    ...(prompt && { config: promptRecallConfig(rest.config) }),
    ...(hookEmbed !== undefined && { embed: hookEmbed }),
    ...(hookRerank !== undefined && { rerank: hookRerank }),
    store: busyAware(store, () => {
      busy = true;
    }),
    home: agent.home,
    log: {
      write: (e) => {
        const t = { ...e.timings, wireMs: opts.wireMs };
        if (e.event === event) timings = t;
        harnessLog.write({
          ...e,
          timings: t,
          ...(opts.daemon === true && { counts: { ...e.counts, daemon: 1 } }),
        });
      },
    },
    // The drain runs in the home directory, so it resolves the home config only:
    // project config never affects the write path.
    spawnDrain: () => opts.spawnDrain(home),
    ...(w.mode === 'cloud' && {
      remote: cloudRemote(
        w.cloud,
        w.cloudProblem,
        {
          projectId: w.scope.projectId,
          ...(w.statedPrivacy !== undefined && { private: w.statedPrivacy }),
        },
        agent.source === 'none' ? undefined : agent.id,
        promptMode,
        w.config.recall.lexicalFirst,
        w.config.recall.promptGateMissRerank,
      ),
    }),
  });
  if (busy) {
    // The store was locked: whatever the handler made of it, inject nothing.
    logEntry('degraded:busy', ['busy']);
    return { stdout: '', ...(timings !== undefined && { timings }) };
  }
  return { stdout: out.stdout, ...(timings !== undefined && { timings }) };
}

export interface HookRunOptions {
  /** The hook input, when the caller already read it (the bin, after trying `oort serve`). */
  stdin?: string;
  /** `performance.now()` when the hook started: the deadline counts from there. */
  startedAt?: number;
}

/**
 * `oort hook <event>`. Prints exactly the hook JSON (or nothing) on stdout and
 * always exits 0, through `io.hookExit`, which exits the moment the write is
 * flushed: after a recall timeout the losing full recall is still pending and
 * would otherwise hold the process past Claude Code's timeout. Every failure
 * (bad config, a store that will not open, a throwing handler) is logged to
 * the hook log and swallowed. A store locked by another writer (a drain) makes
 * the open or a write fail after 250 ms: stdout is then empty and the log
 * records `degraded:busy`. A deadline exits 0 with empty stdout should
 * anything hang.
 */
export async function hookCommand(
  event: string,
  ctx: Ctx,
  opts: HookRunOptions = {},
): Promise<void> {
  const { io } = ctx;
  let exited = false;
  let input: string | undefined = opts.stdin;
  const exit = (stdout: string): void => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    // A new release: one line for the person (`systemMessage`), never the model's context.
    io.hookExit(
      event === 'SessionStart'
        ? sessionStartNotice(stdout, input, {
            home: resolveHome(io.env),
            env: io.env,
            current: VERSION,
            spawnRefresh: () => io.spawnUpdateCheck?.(),
          })
        : stdout,
    );
  };
  const budget = event in HOOK_TIMEOUTS ? HOOK_TIMEOUTS[event as keyof typeof HOOK_TIMEOUTS] : 0;
  // Time already spent (on stdin, or on a daemon that did not answer) comes off the deadline.
  const spent = opts.startedAt === undefined ? 0 : performance.now() - opts.startedAt;
  const deadline =
    budget > 0
      ? setTimeout(() => exit(''), Math.max(0, budget * 1000 - DEADLINE_MARGIN_MS - spent))
      : undefined;
  deadline?.unref();

  let w: Wired | undefined;
  let stdout = '';
  try {
    if (!isEvent(event)) {
      io.err(
        `oort hook: unknown event ${echo(event)}; expected one of ${HOOK_COMMAND_EVENTS.join(', ')}.\n`,
      );
      log(ctx, undefined, event, 'unknown-event');
    } else {
      const stdin =
        event === 'drain' ? '' : (opts.stdin ?? (await io.readStdin(HOOK_STDIN_CAP_MS)));
      input = stdin;
      const wireStart = performance.now();
      w = await ctx.wire(inputCwd(stdin) ?? io.cwd, hookWireOptions(event, io.env));
      // Config, store open and key lookup (env, then the keychain): the hook log records it (CON-57).
      const wireMs = performance.now() - wireStart;
      const out = await runWiredHook(event, stdin, w, {
        wireMs,
        err: (t) => io.err(t),
        spawnDrain: (home) => io.spawnDrain(home),
      });
      stdout = out.stdout;
      if (io.env['OORT_HOOK_TIMING'] === '1' && out.timings !== undefined) {
        io.err(timingLine('process', out.timings));
      }
      // The drain is detached and nothing waits on it, so it closes the store cleanly.
      if (event === 'drain') await w.close();
    }
  } catch (e) {
    if (isBusy(e)) {
      stdout = '';
      log(ctx, w, event, 'degraded:busy', ['busy']);
    } else if (e instanceof StoreMigrationRequiredError) {
      // Fail open: no recall and no save this turn, the prompt goes on; any oort command migrates.
      if (event !== 'drain') io.err(MIGRATION_PENDING_NOTE);
      log(ctx, w, event, 'degraded:migration-pending', ['migration-pending']);
    } else log(ctx, w, event, 'cli-error');
  }
  exit(stdout);
}

function log(
  ctx: Ctx,
  w: Wired | undefined,
  event: string,
  outcome: string,
  degraded?: string[],
): void {
  try {
    const logger = w?.harnessLog ?? createHookLogger(resolveHome(ctx.io.env));
    logger.write({
      event,
      session: null,
      project: null,
      outcome,
      counts: {},
      timings: {},
      ...(degraded !== undefined && { degraded }),
    });
  } catch {
    // Logging is best effort; the session must go on.
  }
}
