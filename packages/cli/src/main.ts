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
    const [{ hookCommand }, { wire }, { keychainFor }, { processIo }] = await Promise.all([
      import('./commands/hook.js'),
      import('./wire.js'),
      import('./keychain.js'),
      import('./io.js'),
    ]);
    const io = processIo(evalMode ? undefined : process.argv[1], { hook });
    const keychain = keychainFor(io.env, {
      warn: (m) => io.err(`oort: ${m}\n`),
      promptSecret: (q) => io.askSecret(q),
    });
    await hookCommand(args[1] as string, { io, wire, keychain });
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
