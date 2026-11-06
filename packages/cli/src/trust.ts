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
      out.add(fs.realpathSync.native(p));
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

// What the kernel opens, not Node's own resolution of link text (PR #78 review).
const realpathOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync.native(p);
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

/** Forgets every `trustedTree` result (tests change trees between checks). */
export function clearTreeCache(): void {
  treeCache.clear();
}

/**
 * Forgets what `trustedTree` found under `prefix`: an install has just rewritten it, so the
 * check after it walks it again (PR #78 review: a stale ok after npm ran).
 */
export function forgetTree(prefix: string): void {
  const root = realpathOf(prefix) ?? path.resolve(prefix);
  for (const k of treeCache.keys()) if (k.startsWith(`${root}\0`)) treeCache.delete(k);
}

/** How `trustedTree` judges a tree. */
export interface TreeOptions {
  cap?: number;
  /**
   * `true` (the default; the managed copy): every entry this user's, no group or other write,
   * links only inside the tree. `false` (a copy of the user's own elsewhere: `--this-copy`, the
   * fallback): `trustedPath`'s lenient rules for every entry, and a link may lead anywhere whose
   * path passes them; it is not walked into (a pnpm checkout's node_modules links to its store).
   */
  strict?: boolean;
  /** The user's HOME (non-strict: owner and group rules depend on it). */
  home?: string;
  groupOk?: (gid: number) => boolean;
}

/**
 * Walks everything under `prefix` (the managed copy: `bin/`, and `lib/node_modules` with oortmem,
 * its `dist/` and every dependency Node could resolve from there; or a copy's own package root),
 * with lstat and no symlink followed (PR #78 follow-up review). `main.js` loads all of it. A
 * link's own owner counts, and where it leads is what the kernel opens (`realpathSync.native`),
 * never what its text says. Any other kind of entry (a FIFO, a socket, a device) does not belong.
 * Iterative, at most `cap` entries; past that it is not vouched for. The result is kept for the
 * rest of the process (setup's reuse, the check before each write and doctor walk once) until an
 * install rewrites the tree (`forgetTree`).
 */
export function trustedTree(prefix: string, opts: TreeOptions = {}): Untrusted | undefined {
  if (process.platform === 'win32') return undefined;
  const root = realpathOf(prefix);
  if (root === undefined) {
    return { dir: prefix, why: 'does not exist', fix: 'oort setup', command: 'oort setup' };
  }
  const cap = opts.cap ?? TREE_CAP;
  const strict = opts.strict !== false;
  const key = `${root}\0${cap}\0${strict ? 'strict' : `lenient\0${opts.home ?? ''}`}`;
  const seen = opts.groupOk === undefined ? treeCache.get(key) : undefined;
  if (seen !== undefined) return seen ?? undefined;
  const found = walk(root, cap, { ...opts, strict });
  if (opts.groupOk === undefined) treeCache.set(key, found ?? null);
  return found;
}

/**
 * The two link shapes npm writes with `..` in them: `node_modules/.bin/<x>` →
 * `../<pkg>/<path>` (or `../@scope/<pkg>/<path>`), and a global install's `<prefix>/bin/<x>` →
 * `../lib/node_modules/<pkg>/<path>`. Only one leading `..`, then plain names. Their realpath is
 * still checked.
 */
function npmLink(p: string, raw: string, root: string): boolean {
  const segs = raw.split('/');
  if (segs[0] !== '..') return false;
  const rest = segs.slice(1);
  if (rest.length < 2 || rest.some((x) => x === '..' || x === '.' || x === '')) return false;
  const dir = path.dirname(p);
  if (path.basename(dir) === '.bin' && path.basename(path.dirname(dir)) === 'node_modules') {
    return rest[0]?.startsWith('@') === true ? rest.length >= 3 : true;
  }
  if (dir === path.join(root, 'bin')) {
    return rest[0] === 'lib' && rest[1] === 'node_modules' && rest.length >= 4;
  }
  return false;
}

function walk(
  root: string,
  cap: number,
  opts: TreeOptions & { strict: boolean },
): Untrusted | undefined {
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const home = opts.home === undefined ? undefined : (realpathOf(opts.home) ?? opts.home);
  const groupOk = opts.groupOk ?? ((gid: number) => groupCanBecomeRoot(gid));
  // Never chmod or chown a tree like this: its files may not be what npm put there, and either
  // would make them yours. Remove it and install it again (PR #78 review, N1). A copy of the
  // user's own: rebuild or reinstall it, or use the managed copy.
  const again = opts.strict
    ? `rm -r ${sh(root)} && oort setup`
    : `rebuild or reinstall ${sh(root)} somewhere only you can write, or use the managed copy (oort setup)`;
  const bad = (p: string, why: string): Untrusted =>
    opts.strict ? { dir: p, why, fix: again, command: again } : { dir: p, why, fix: again };
  /** Owner and mode of one entry (not a link's target): undefined when fine. */
  const judge = (p: string, st: fs.Stats): Untrusted | undefined => {
    const inHome = home !== undefined && (p === home || p.startsWith(home + path.sep));
    if (me !== undefined && st.uid !== me && (opts.strict || inHome || st.uid !== 0)) {
      return bad(p, 'belongs to another user');
    }
    if (st.isSymbolicLink()) return undefined; // a link's own mode means nothing
    if (opts.strict) {
      return (st.mode & 0o022) !== 0 ? bad(p, 'can be written by group or others') : undefined;
    }
    if ((st.mode & 0o002) !== 0) return bad(p, 'can be written by others');
    if ((st.mode & 0o020) !== 0 && (inHome || !groupOk(st.gid))) {
      return bad(p, 'can be written by its group');
    }
    return undefined;
  };
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
    const own = judge(p, st);
    if (own !== undefined) return own;
    if (st.isSymbolicLink()) {
      // Judged by where the kernel takes it, not by its text: `x/../../y` through a link `x`
      // resolves elsewhere than it reads (PR #78 review). In the managed copy, `..` only in npm's
      // own link shapes, and only into the copy.
      let raw: string;
      try {
        raw = fs.readlinkSync(p);
      } catch {
        return bad(p, 'is a link that cannot be read');
      }
      if (opts.strict && raw.split(/[\\/]/).includes('..') && !npmLink(p, raw, root)) {
        return bad(p, `is a link with .. in it (${raw}) that is not one of npm's`);
      }
      let real: string;
      try {
        real = fs.realpathSync.native(p);
      } catch {
        return bad(p, 'is a link that leads nowhere');
      }
      if (opts.strict) {
        if (real !== root && !real.startsWith(root + path.sep)) {
          return bad(p, `is a link out of the managed copy (to ${real})`);
        }
        // What it leads to is walked anyway; checked here too, explicitly.
        let tst: fs.Stats;
        try {
          tst = fs.lstatSync(real);
        } catch {
          return bad(p, 'is a link that leads nowhere');
        }
        const target = judge(real, tst);
        if (target !== undefined) return target;
      } else {
        // A copy of your own may link out (pnpm's store): every step to what it opens must pass.
        const u = trustedPath(real, {
          home: opts.home ?? '/',
          strict: false,
          ...(opts.groupOk !== undefined && { groupOk: opts.groupOk }),
        });
        if (u !== undefined) return bad(p, `is a link to ${real}, where ${u.dir} ${u.why}`);
      }
      continue;
    }
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
