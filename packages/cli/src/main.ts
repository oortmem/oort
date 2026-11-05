#!/usr/bin/env node
/**
 * The `oort` bin. A hook run (`oort hook <event>`) must exit 0 whatever
 * happens, so crash handlers are installed before anything else loads; the
 * hook command itself exits the moment its stdout is flushed.
 */
const evalMode = process.execArgv.some((a) => ['-e', '--eval', '-p', '--print'].includes(a));
const args = process.argv.slice(evalMode ? 1 : 2);
const hook = args[0] === 'hook';
if (hook) {
  const bail = (): never => process.exit(0);
  process.on('uncaughtException', bail);
  process.on('unhandledRejection', bail);
}

/**
 * `oort hook <event>` skips the argument parser and every other command module: a hook runs on
 * every prompt and every turn, and only needs the hook command and the wiring (CON-51). Flags
 * (`--help`) still go through the full CLI.
 */
const fastHook = hook && args.length >= 2 && args.slice(1).every((a) => !a.startsWith('-'));

try {
  if (fastHook) {
    const startedAt = performance.now();
    const event = args[1] as string;
    const { processIo, binPath, HOOK_STDIN_CAP_MS } = await import('./io.js');
    let via = 'process';
    const io = processIo(evalMode ? undefined : process.argv[1], {
      hook,
      ...(process.env['OORT_HOOK_TIMING'] === '1' && { timing: () => `${event} via=${via}` }),
    });
    /**
     * The two events that inject context try `oort serve` first (CON-18): one connect to a local
     * socket (50 ms at most) and one answer. Anything else (no daemon, a slow or broken one,
     * another version) runs the hook in-process below, exactly as without a daemon.
     */
    let stdin: string | undefined;
    let served = false;
    if (event === 'UserPromptSubmit' || event === 'SessionStart') {
      stdin = await io.readStdin(HOOK_STDIN_CAP_MS);
      try {
        const client = await import('./serve-client.js');
        const r = await client.hookViaDaemon(event, stdin, io.cwd, io.env);
        if (r.served) {
          served = true;
          via = 'daemon';
          io.hookExit(r.stdout);
        } else if (event === 'SessionStart' && (r.reason === 'absent' || r.reason === 'refused')) {
          // `serve.autostart` (home config, default off): start one for the prompts that follow.
          // Best effort: a failed start never keeps this hook from running.
          const { homeFrom } = await import('./serve-protocol.js');
          const { homedir } = await import('node:os');
          const home = homeFrom(io.env, homedir);
          try {
            if (client.autostartEnabled(home)) {
              const { realpathSync } = await import('node:fs');
              client.spawnDaemon(realpathSync(binPath()), home, io.env);
            }
          } catch {
            // The hook goes on in-process; the breaker keeps the next sessions from retrying at once.
            client.writeSkip(home, Date.now() + client.SKIP_AFTER_REFUSAL_MS, 'refused');
          }
        }
      } catch {
        // Whatever went wrong talking to the daemon, the hook runs in-process below.
      }
    }
    if (!served) {
      const [{ hookCommand }, { wire }, { keychainFor }] = await Promise.all([
        import('./commands/hook.js'),
        import('./wire.js'),
        import('./keychain.js'),
      ]);
      const keychain = keychainFor(io.env, {
        warn: (m) => io.err(`oort: ${m}\n`),
        promptSecret: (q) => io.askSecret(q),
      });
      await hookCommand(
        event,
        { io, wire, keychain },
        {
          ...(stdin !== undefined && { stdin }),
          startedAt,
        },
      );
    }
    process.exitCode = 0;
  } else {
    const { runCli } = await import('./program.js');
    const { processIo } = await import('./io.js');
    const code = await runCli(args, processIo(evalMode ? undefined : process.argv[1], { hook }));
    process.exitCode = hook ? 0 : code;
  }
} catch (e) {
  if (hook) process.exit(0);
  process.stderr.write(`oort: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
