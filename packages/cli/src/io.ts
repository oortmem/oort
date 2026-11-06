import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export type Env = Record<string, string | undefined>;

/** A hook's stdin is read for at most this long; Claude Code writes it at once and closes it. */
export const HOOK_STDIN_CAP_MS = 1000;

/**
 * Everything a command touches outside the store and adapters. The bin passes
 * `processIo()`; tests pass a recording double.
 */
export interface Io {
  cwd: string;
  env: Env;
  /** The script the CLI was started as (`process.argv[1]`); undefined under `node -e`. */
  entry: string | undefined;
  stdinIsTTY: boolean;
  /** Whether stdout is a terminal (colour is off when it is not); absent means no. */
  stdoutIsTTY?: boolean;
  out(text: string): void;
  err(text: string): void;
  /** All of stdin, or what arrived within `capMs`. */
  readStdin(capMs?: number): Promise<string>;
  /** Prints `question` on stderr (never stdout, which may be piped data) and reads one line from stdin. */
  ask(question: string): Promise<string>;
  /** Like `ask` (the question on stderr), with the typed input hidden on a terminal; a pipe supplies one line. Never echoed. */
  askSecret(question: string): Promise<string>;
  /** Starts a detached `oort hook drain` in `cwd` and does not wait for it. */
  spawnDrain(cwd: string): void;
  /** Writes the hook's stdout, then exits 0 as soon as the write is flushed. */
  hookExit(stdout: string): void;
}

/**
 * Runs a child with the terminal attached for input (npm, the macOS `security` prompt), but its
 * stdout on our stderr: stdout stays for the command's own output (one `oort.v1` envelope with
 * `--json`), and a child's progress or prompt still reaches the person. Resolves the exit code.
 */
export function runToStderr(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
  spawnFn: typeof spawn = spawn,
): Promise<number> {
  return new Promise((resolve, reject) => {
    spawnFn(file, args, {
      stdio: ['inherit', 2, 2],
      ...(opts.env !== undefined && { env: opts.env }),
    })
      .once('error', reject)
      .once('close', (code) => resolve(code ?? 1));
  });
}

/** The bin (`dist/main.js`), beside this module in the built package. */
export function binPath(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

/**
 * The bin's `Io`. stdout errors are handled here: a closed pipe (`oort export
 * | head`) exits 0 quietly, any other write failure exits 1 with one line. In
 * hook mode every stdout error exits 0, since a hook must never fail.
 */
export function processIo(
  entry: string | undefined,
  opts: {
    hook?: boolean;
    /**
     * Bench only (`OORT_HOOK_TIMING=1`): after the hook's stdout is flushed, one stderr line
     * `oort-hook <label> <ms since process start>`.
     */
    timing?: () => string;
  } = {},
): Io {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (opts.hook === true || e.code === 'EPIPE') process.exit(0);
    process.stderr.write(`oort: cannot write to stdout (${e.code ?? e.name})\n`);
    process.exit(1);
  });
  return {
    cwd: process.cwd(),
    env: process.env,
    entry,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readStdin(capMs) {
      return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          clearTimeout(timer);
          process.stdin.off('data', onData).off('end', finish).off('error', finish);
          process.stdin.pause();
          resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const onData = (c: Buffer): void => void chunks.push(c);
        if (capMs !== undefined) timer = setTimeout(finish, capMs);
        process.stdin.on('data', onData).on('end', finish).on('error', finish);
      });
    },
    async ask(question) {
      // The question goes to stderr: stdout may be piped data (`oort share … --json | jq`).
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askSecret(question) {
      const stdin = process.stdin;
      if (!stdin.isTTY) {
        return new Promise((resolve) => {
          let buf = '';
          const finish = (): void => {
            stdin.off('data', onData).off('end', finish).off('error', finish);
            stdin.pause();
            resolve((buf.split(/\r?\n/, 1)[0] ?? '').trim());
          };
          const onData = (c: Buffer): void => {
            buf += c.toString('utf8');
            if (/\n/.test(buf)) finish();
          };
          stdin.on('data', onData).on('end', finish).on('error', finish);
        });
      }
      process.stderr.write(question);
      return new Promise((resolve) => {
        let buf = '';
        const done = (value: string): void => {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          resolve(value);
        };
        const onData = (chunk: Buffer): void => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(buf.trim());
            if (ch === '\u0003') return done(''); // Ctrl-C: nothing is stored
            if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
            else if (ch >= ' ') buf += ch;
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
      });
    },
    spawnDrain(cwd) {
      const child = spawn(process.execPath, [fs.realpathSync(binPath()), 'hook', 'drain'], {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.on('error', () => {}); // a failed spawn must not crash the hook
      child.unref();
    },
    hookExit(stdout) {
      const timing = opts.timing;
      const exit = (): void => {
        if (timing === undefined) process.exit(0);
        const line = `oort-hook ${timing()} ${performance.now().toFixed(2)}ms\n`;
        process.stderr.write(line, () => process.exit(0));
      };
      if (stdout.length === 0) exit();
      else process.stdout.write(stdout, exit);
    },
  };
}
