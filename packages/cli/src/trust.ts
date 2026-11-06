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
  /** The fix as a command to run as it is, when `fix` says more than that. */
  command?: string;
}

const realpathOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/** Linux groups whose members can already become root: group write from them adds nothing. */
const ROOT_GROUPS = new Set(['root', 'sudo', 'wheel', 'admin']);

/** What `groupCanBecomeRoot` reads: the system's group and user databases, and who this is. */
export interface SystemGroups {
  platform: NodeJS.Platform;
  /** `/etc/group`'s text (`name:x:gid:member,member`). */
  group: string;
  /** `/etc/passwd`'s text (`name:x:uid:gid:…`). */
  passwd: string;
  user: string;
}

let systemGroups: SystemGroups | undefined;

function readSystemGroups(): SystemGroups {
  const read = (f: string): string => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // No user name: no user-private group either.
  }
  return {
    platform: process.platform,
    group: read('/etc/group'),
    passwd: read('/etc/passwd'),
    user,
  };
}

/**
 * Whether members of group `gid` can already become root, so letting them write changes nothing
 * (PR #78 review, N2). macOS: `wheel` (0) and `admin` (80), by number, with no lookup (every
 * account's own group there is `staff`, 20, which never counts). Elsewhere, from `/etc/group`:
 * `root`, `sudo`, `wheel` or `admin`, or this user's private group (named after the user, with no
 * other members and no other user's primary group). Read once per process; never spawns.
 */
export function groupCanBecomeRoot(gid: number, sys?: SystemGroups): boolean {
  const s = sys ?? (systemGroups ??= readSystemGroups());
  if (s.platform === 'darwin') return gid === 0 || gid === 80;
  if (gid === 0) return true;
  const entry = s.group
    .split('\n')
    .map((l) => l.split(':'))
    .find((f) => f.length >= 3 && Number(f[2]) === gid);
  if (entry === undefined) return false;
  const name = entry[0] ?? '';
  if (ROOT_GROUPS.has(name)) return true;
  const members = (entry[3] ?? '').split(',').filter((m) => m.trim() !== '');
  if (s.user === '' || name !== s.user || members.some((m) => m.trim() !== s.user)) return false;
  const others = s.passwd
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 4 && Number(f[3]) === gid && f[0] !== s.user);
  return others.length === 0;
}

/**
 * Walks `file`'s realpath from `/` down to the file itself; every step must be one nobody else can
 * change:
 *
 * - **Owner.** This user's inside `home` (the user's HOME); this user's or root's above it, and
 *   for a copy outside it (`/usr/local`, `/opt/homebrew`).
 * - **Writable.** `strict` (the managed copy and `OORT_HOME`, which oort creates owner-only): no
 *   group or other write anywhere. Otherwise (a copy the user installed elsewhere): no other
 *   write, sticky or not (`/tmp`); no group write inside HOME; outside it, group write only from a
 *   group that can already become root (`groupCanBecomeRoot`: Homebrew's `/opt/homebrew/lib` is
 *   `admin`, `/usr/local/lib/node_modules` often `wheel`), never `staff` (PR #78 review, N2).
 *
 * The fix it names never adopts what is not yours: `chmod` only for a directory of this user's,
 * never `chown` (that would make someone else's files yours). Undefined when it passes. A path
 * that does not resolve fails. Windows has no such modes: it passes there. `groupOk` replaces
 * `groupCanBecomeRoot` (tests).
 */
export function trustedPath(
  file: string,
  opts: { home: string; strict: boolean; groupOk?: (gid: number) => boolean },
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
  const groupOk = opts.groupOk ?? ((gid: number) => groupCanBecomeRoot(gid));
  const steps: string[] = [];
  for (let p = real; ;) {
    steps.unshift(p);
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  const elsewhere = 'use a copy in a directory of your own';
  for (const p of steps) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return { dir: p, why: 'cannot be read', fix: `ls -ld ${sh(p)}` };
    }
    const mine = p === home || p.startsWith(home + path.sep);
    const owned = me === undefined || st.uid === me;
    if (!owned && (mine || st.uid !== 0)) {
      return { dir: p, why: 'belongs to another user', fix: elsewhere };
    }
    const others = (st.mode & 0o002) !== 0;
    const group = (st.mode & 0o020) !== 0 && (opts.strict || mine || !groupOk(st.gid));
    if (others || group) {
      const bits = others && group ? 'go-w' : others ? 'o-w' : 'g-w';
      return {
        dir: p,
        why: `can be written by ${others && group ? 'group or others' : others ? 'others' : 'its group'}`,
        // Strict (OORT_HOME, the user's own): tightening it is the fix (when a managed copy is in
        // it, inspectManaged removes that first). Anywhere else, what is below may have been
        // changed already: tightening alone would adopt it, so the hint says to rebuild or
        // reinstall too, and is never a command to run as it is (PR #78 review, N1).
        ...(!owned
          ? { fix: elsewhere }
          : opts.strict
            ? { fix: `chmod ${bits} ${sh(p)}`, command: `chmod ${bits} ${sh(p)}` }
            : {
                fix: `chmod ${bits} ${sh(p)}, then rebuild or reinstall oort (what is below it may have been changed), or use the managed copy (oort setup)`,
              }),
      };
    }
  }
  return undefined;
}

/** One sentence for people: `<dir> <why> (fix: <command>)`. */
export const untrustedText = (u: Untrusted): string => `${u.dir} ${u.why} (fix: ${u.fix})`;

/** The most entries `trustedTree` walks; a tree bigger than this is not vouched for. */
export const TREE_CAP = 20_000;

const treeCache = new Map<string, Untrusted | null>();

/** Forgets what `trustedTree` found (tests change trees between checks; a process never does). */
export function clearTreeCache(): void {
  treeCache.clear();
}

/**
 * Walks everything under `prefix` (the managed copy: `bin/`, and `lib/node_modules` with oortmem,
 * its `dist/` and every dependency Node could resolve from there), with lstat and no symlink
 * followed (PR #78 follow-up review). `main.js` loads all of it, so every directory and file must
 * be this user's with no group or other write; a symlink may point only inside the prefix; any
 * other kind of entry (a FIFO, a socket, a device) does not belong. Iterative, at most `cap`
 * entries; past that it is not vouched for. The result is kept for the rest of the process, so
 * setup's reuse, the check before each write and doctor walk it once.
 */
export function trustedTree(prefix: string, opts: { cap?: number } = {}): Untrusted | undefined {
  if (process.platform === 'win32') return undefined;
  const root = realpathOf(prefix);
  if (root === undefined) {
    return { dir: prefix, why: 'does not exist', fix: 'oort setup', command: 'oort setup' };
  }
  const cap = opts.cap ?? TREE_CAP;
  const key = `${root}\0${cap}`;
  const seen = treeCache.get(key);
  if (seen !== undefined) return seen ?? undefined;
  const found = walk(root, cap);
  treeCache.set(key, found ?? null);
  return found;
}

function walk(root: string, cap: number): Untrusted | undefined {
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
  // Never chmod or chown a tree like this: its files may not be what npm put there, and either
  // would make them yours. Remove it and install it again (PR #78 review, N1).
  const again = `rm -r ${sh(root)} && oort setup`;
  const bad = (p: string, why: string): Untrusted => ({ dir: p, why, fix: again, command: again });
  const stack = [root];
  let count = 0;
  while (stack.length > 0) {
    const p = stack.pop() as string;
    if (++count > cap) {
      return bad(root, `holds more than ${cap} files, more than oort ever installs`);
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return bad(p, 'cannot be read');
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = path.resolve(path.dirname(p), fs.readlinkSync(p));
      } catch {
        return bad(p, 'is a link that cannot be read');
      }
      if (target !== root && !target.startsWith(root + path.sep)) {
        return bad(p, `is a link out of the managed copy (to ${target})`);
      }
      continue;
    }
    if (me !== undefined && st.uid !== me) return bad(p, 'belongs to another user');
    if ((st.mode & 0o022) !== 0) return bad(p, 'can be written by group or others');
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(p);
      } catch {
        return bad(p, 'cannot be read');
      }
      for (const n of names) stack.push(path.join(p, n));
    } else if (!st.isFile()) {
      return bad(p, 'is neither a file, a directory nor a link');
    }
  }
  return undefined;
}
