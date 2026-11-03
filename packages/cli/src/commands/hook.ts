import { HOOK_TIMEOUTS, createHookLogger, runHook, type HookEvent } from '@oortmem/claude-code';
import { resolveHome } from '@oortmem/core';
import type { Ctx } from '../util.js';
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
 * the hook log and swallowed. A deadline exits 0 with empty stdout should
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
  try {
    if (!isEvent(event)) {
      io.err(
        `oort hook: unknown event "${event}"; expected one of ${HOOK_COMMAND_EVENTS.join(', ')}.\n`,
      );
      log(ctx, undefined, event, 'unknown-event');
    } else {
      const stdin = event === 'drain' ? '' : await io.readStdin(HOOK_STDIN_CAP_MS);
      w = await ctx.wire(inputCwd(stdin) ?? io.cwd, { env: io.env });
      const { harnessLog, unavailable: _u, close: _c, scope: _s, ...engine } = w;
      // The scope is left out: each handler derives it from the session's cwd.
      const out = await runHook(event, stdin, {
        ...engine,
        log: harnessLog,
        spawnDrain: () => io.spawnDrain(),
      });
      stdout = out.stdout;
      // The drain is detached and nothing waits on it, so it closes the store cleanly.
      if (event === 'drain') await w.close();
    }
  } catch {
    log(ctx, w, event, 'cli-error');
  }
  exit(stdout);
}

function log(ctx: Ctx, w: Wired | undefined, event: string, outcome: string): void {
  try {
    const logger = w?.harnessLog ?? createHookLogger(resolveHome(ctx.io.env));
    logger.write({ event, session: null, project: null, outcome, counts: {}, timings: {} });
  } catch {
    // Logging is best effort; the session must go on.
  }
}
