import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shellWord as sh } from './util.js';

/**
 * Whether a binary is safe for agents to run (PR #78 review, I1 and I2): who could change it
 * before the next hook runs it. Agents run whatever path `oort install` wrote, every prompt, so a
 * path that someone else can write, or one that a cleaner deletes, is no place for them.
 */

/** Directories every system clears or shares: macOS's per-user one, `/tmp`, `/var/tmp`, `/dev/shm`. */
const SHARED_TEMP = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/dev/shm'];

/**
 * Every temporary directory, as given and as its realpath: `os.tmpdir()` (macOS's per-user
 * `/var/folders/…/T`), `$TMPDIR`, and the shared ones.
 */
export function tempDirs(env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p === undefined || p === '' || !path.isAbsolute(p)) return;
    out.add(path.resolve(p));
    try {
      out.add(fs.realpathSync(p));
    } catch {
      // Not on this system.
    }
  };
  add(os.tmpdir());
  add(env['TMPDIR']);
  for (const d of SHARED_TEMP) add(d);
  return [...out];
}

/** `p` is one of `dirs` or below one. */
export const inside = (p: string, dirs: readonly string[]): boolean =>
  dirs.some((d) => p === d || p.startsWith(d.endsWith(path.sep) ? d : d + path.sep));

/** Why a path is not safe for agents to run, and the command that fixes it. */
export interface Untrusted {
  /** The first directory (or the file) that fails, from `/` down. */
  dir: string;
  why: string;
  fix: string;
}

const realpathOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Walks `file`'s realpath from `/` down to the file itself; every step must be one nobody else can
 * change:
 *
 * - **Owner.** This user's inside `home` (the user's HOME); this user's or root's above it, and
 *   for a copy outside it (`/usr/local`, `/opt/homebrew`).
 * - **Writable.** `strict` (the managed copy and `OORT_HOME`, which oort creates owner-only): no
 *   group or other write anywhere. Otherwise (a copy the user installed elsewhere): no other
 *   write, sticky or not (`/tmp`); group write is allowed, because Homebrew's `/opt/homebrew/lib`
 *   and `/usr/local/lib/node_modules` are group-writable for the admin group on a normal Mac.
 *
 * Undefined when it passes. A path that does not resolve fails. Windows has no such modes: it
 * passes there.
 */
export function trustedPath(
  file: string,
  opts: { home: string; strict: boolean },
): Untrusted | undefined {
  if (process.platform === 'win32') return undefined;
  const real = realpathOf(file);
  if (real === undefined) {
    return {
      dir: file,
      why: 'does not exist, or is a link that leads nowhere',
      fix: `ls -l ${sh(file)}`,
    };
  }
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const home = realpathOf(opts.home) ?? path.resolve(opts.home);
  const steps: string[] = [];
  for (let p = real; ;) {
    steps.unshift(p);
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  for (const p of steps) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return { dir: p, why: 'cannot be read', fix: `ls -ld ${sh(p)}` };
    }
    const mine = p === home || p.startsWith(home + path.sep);
    if (me !== undefined && st.uid !== me && (mine || st.uid !== 0)) {
      return {
        dir: p,
        why: 'belongs to another user',
        fix: `sudo chown "$(id -un)" ${sh(p)}`,
      };
    }
    const mask = opts.strict ? 0o022 : 0o002;
    if ((st.mode & mask) !== 0) {
      return {
        dir: p,
        why: opts.strict ? 'can be written by group or others' : 'can be written by others',
        fix: `chmod ${opts.strict ? 'go-w' : 'o-w'} ${sh(p)}`,
      };
    }
  }
  return undefined;
}

/** One sentence for people: `<dir> <why> (fix: <command>)`. */
export const untrustedText = (u: Untrusted): string => `${u.dir} ${u.why} (fix: ${u.fix})`;
