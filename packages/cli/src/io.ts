import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export type Env = Record<string, string | undefined>;

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
  out(text: string): void;
  err(text: string): void;
  /** All of stdin, or what arrived within `capMs`. */
  readStdin(capMs?: number): Promise<string>;
  /** Prints `question` on stdout and reads one line from stdin. */
  ask(question: string): Promise<string>;
  /** Starts a detached `oort hook drain` and does not wait for it. */
  spawnDrain(): void;
  /** Writes the hook's stdout, then exits 0 as soon as the write is flushed. */
  hookExit(stdout: string): void;
}

/** The bin (`dist/main.js`), beside this module in the built package. */
export function binPath(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

export function processIo(entry: string | undefined): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    entry,
    stdinIsTTY: process.stdin.isTTY === true,
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
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    spawnDrain() {
      const child = spawn(process.execPath, [fs.realpathSync(binPath()), 'hook', 'drain'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.on('error', () => {}); // a failed spawn must not crash the hook
      child.unref();
    },
    hookExit(stdout) {
      const exit = (): never => process.exit(0);
      if (stdout.length === 0) exit();
      process.stdout.on('error', exit);
      process.stdout.write(stdout, exit);
    },
  };
}
