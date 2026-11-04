import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHome } from '@oortmem/core';
import type { Env } from './io.js';

/**
 * Where keys live off macOS: `$OORT_HOME/credentials.json`, `{ "version": 1, "keys": { <provider>: <key> } }`,
 * file mode 0600 in a 0700 directory. Windows has no POSIX modes, so there the directory ACL
 * of the user profile is what protects it.
 *
 * Nothing here prints a key: errors and warnings name the file and its mode, never its content.
 */

export const CREDENTIALS_FILE = 'credentials.json';

const POSIX = process.platform !== 'win32';

export const credentialsPath = (env: Env): string => path.join(resolveHome(env), CREDENTIALS_FILE);

export type FileState =
  | { state: 'absent' }
  | { state: 'ok' }
  /** A mode wider than 0600: Oort will not read or write it. */
  | { state: 'wide'; mode: number }
  | { state: 'unreadable'; reason: string };

/** The file's presence and permissions, without reading it. */
export function inspectCredentialsFile(file: string): FileState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unreadable', reason: 'cannot be inspected' };
  }
  if (!st.isFile()) return { state: 'unreadable', reason: 'is not a regular file' };
  const mode = st.mode & 0o777;
  if (POSIX && (mode & 0o077) !== 0) return { state: 'wide', mode };
  return { state: 'ok' };
}

/** One line that says what is wrong and how to fix it; for `wide` and `unreadable`. */
export function describeProblem(file: string, s: FileState): string | undefined {
  if (s.state === 'wide') {
    return `${file} is mode ${s.mode.toString(8)}, so other users could read your keys; Oort will not use it. Fix: chmod 600 ${file}`;
  }
  if (s.state === 'unreadable') return `${file} ${s.reason}; Oort will not use it.`;
  return undefined;
}

export type Keys = Partial<Record<string, string>>;

export type ReadResult = { keys: Keys } | { problem: string };

/** The stored keys; `problem` (never a key) when the file is too open, not a file, or not valid. */
export function readKeys(file: string): ReadResult {
  const s = inspectCredentialsFile(file);
  if (s.state === 'absent') return { keys: {} };
  const problem = describeProblem(file, s);
  if (problem !== undefined) return { problem };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = (parsed as { keys?: unknown } | null)?.keys;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('shape');
    const keys: Keys = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v !== '') keys[k] = v;
    return { keys };
  } catch {
    return {
      problem: `${file} is not a valid credentials file (expected {"version":1,"keys":{...}}); fix or delete it, then store the key again.`,
    };
  }
}

/** Writes `keys` atomically: a 0600 temp file in a 0700 directory, then rename. */
export function writeKeys(file: string, keys: Keys): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${CREDENTIALS_FILE}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`);
    if (POSIX) fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
