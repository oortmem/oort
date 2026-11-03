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

try {
  const { runCli } = await import('./program.js');
  const { processIo } = await import('./io.js');
  const code = await runCli(args, processIo(evalMode ? undefined : process.argv[1]));
  process.exitCode = hook ? 0 : code;
} catch (e) {
  if (hook) process.exit(0);
  process.stderr.write(`oort: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
