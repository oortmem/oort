import { HOOK_TIMEOUTS, createHookLogger, runHook, type HookEvent } from '@oortmem/claude-code';
import { resolveHome, type MemoryStore } from '@oortmem/core';
import { echo, type Ctx } from '../util.js';
import type { Wired } from '../wire.js';

export const HOOK_COMMAND_EVENTS: readonly HookEvent[] = [
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
  'drain',
];

/** Stdin is read for at most this long; Claude Code writes it at once and closes it. */
export const HOOK_STDIN_CAP_MS = 1000;
/** Exit this long before Claude Code's own hook timeout would discard the output. */
const DEADLINE_MARGIN_MS = 1000;
/**
 * A hook waits at most this long for the store's write lock (held, say, by a
 * drain). SQLite's busy wait is synchronous: it freezes the event loop, the
 * deadline timer included, so it must stay short. The drain keeps the default.
 */
export const HOOK_BUSY_TIMEOUT_MS = 250;

/** SQLite's "another connection holds the lock" errors. */
function isBusy(e: unknown): boolean {
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
function inputCwd(stdin: string): string | undefined {
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
export async function hookCommand(event: string, ctx: Ctx): Promise<void> {
  const { io } = ctx;
  let exited = false;
  const exit = (stdout: string): void => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    io.hookExit(stdout);
  };
  const budget = event in HOOK_TIMEOUTS ? HOOK_TIMEOUTS[event as keyof typeof HOOK_TIMEOUTS] : 0;
  const deadline =
    budget > 0 ? setTimeout(() => exit(''), budget * 1000 - DEADLINE_MARGIN_MS) : undefined;
  deadline?.unref();

  let w: Wired | undefined;
  let stdout = '';
  let busy = false;
  try {
    if (!isEvent(event)) {
      io.err(
        `oort hook: unknown event ${echo(event)}; expected one of ${HOOK_COMMAND_EVENTS.join(', ')}.\n`,
      );
      log(ctx, undefined, event, 'unknown-event');
    } else {
      const stdin = event === 'drain' ? '' : await io.readStdin(HOOK_STDIN_CAP_MS);
      w = await ctx.wire(inputCwd(stdin) ?? io.cwd, {
        env: io.env,
        // The drain serves every project's queue: home config only, whatever lies above OORT_HOME.
        ...(event === 'drain' ? { projectConfig: false } : { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS }),
      });
      for (const warning of w.warnings) log(ctx, w, event, `config:${warning.code}`);
      const home = w.config.home;
      const {
        harnessLog,
        unavailable: _u,
        close: _c,
        scope: _s,
        warnings: _w,
        store,
        ...engine
      } = w;
      // The scope is left out: each handler derives it from the session's cwd.
      const out = await runHook(event, stdin, {
        ...engine,
        store: busyAware(store, () => {
          busy = true;
        }),
        log: harnessLog,
        // The drain runs in the home directory, so it resolves the home config only:
        // project config never affects the write path.
        spawnDrain: () => io.spawnDrain(home),
      });
      stdout = out.stdout;
      // The drain is detached and nothing waits on it, so it closes the store cleanly.
      if (event === 'drain') await w.close();
    }
  } catch (e) {
    if (isBusy(e)) busy = true;
    else log(ctx, w, event, 'cli-error');
  }
  if (busy) {
    // The store was locked: whatever the handler made of it, inject nothing.
    stdout = '';
    log(ctx, w, event, 'degraded:busy', ['busy']);
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
