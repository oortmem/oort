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
 * change. The trust boundary is: nothing that anyone other than you (or root) can write. Paths
 * that are yours and writable only by you are trusted; write access to your own files is already
 * full compromise of your account.
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
  opts: {
    home: string;
    strict: boolean;
    groupOk?: (gid: number) => boolean;
    /**
     * Directories that already passed during this one check (a closure asks about the same
     * ancestors thousands of times): skipped. Scoped to one check, never kept across checks.
     */
    passed?: Set<string>;
  },
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
  const memo = opts.passed;
  const tag = `\0${opts.strict ? 's' : 'l'}`;
  for (const p of steps) {
    if (memo !== undefined && p !== real && memo.has(p + tag)) continue;
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
    if (memo !== undefined && p !== real) memo.add(p + tag);
  }
  return undefined;
}

/** One sentence for people: `<dir> <why> (fix: <command>)`. */
export const untrustedText = (u: Untrusted): string => `${u.dir} ${u.why} (fix: ${u.fix})`;

/** The most entries `trustedTree` walks; a tree bigger than this is not vouched for. */
export const TREE_CAP = 20_000;
/**
 * The cap for a copy of your own (lenient): its package and everything its links lead to, which
 * for a pnpm checkout is the whole dependency closure, dev dependencies included.
 */
export const OWN_TREE_CAP = 100_000;

const treeCache = new Map<string, Untrusted | null>();
/**
 * Searched folders that passed (`searchedFolders`), for the rest of the process: a dev checkout's
 * `node_modules` is tens of thousands of entries, and every check above it asks again. Keyed by
 * the folder's realpath, rules and its own stat, so a change to the folder itself (a chmod, a
 * package added or removed) is seen; a change deeper in is not, until `forgetSearched`.
 */
const searchCache = new Set<string>();

/** Forgets what passed in the searched folder `dir` (something below it has just changed). */
export function forgetSearched(dir: string): void {
  const root = realpathOf(dir) ?? path.resolve(dir);
  for (const k of searchCache) if (k.startsWith(`${root}\0`)) searchCache.delete(k);
}

/** Forgets every `trustedTree` result (tests change trees between checks). */
export function clearTreeCache(): void {
  treeCache.clear();
  closureCache.clear();
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
  const cap = opts.cap ?? (opts.strict === false ? OWN_TREE_CAP : TREE_CAP);
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
  state: WalkState = { count: 0, visited: new Set([root]) },
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
  /** Linked directories already walked (lenient), by realpath: no cycle walks twice. */
  const visited = state.visited;
  visited.add(root);
  while (stack.length > 0) {
    const p = stack.pop() as string;
    if (++state.count > cap) {
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
      // And its text, read as text, stays inside too (belt and braces with the realpath below).
      const inRoot = (x: string): boolean => x === root || x.startsWith(root + path.sep);
      if (opts.strict && !inRoot(path.resolve(path.dirname(p), raw))) {
        return bad(p, `is a link whose text points out of the managed copy (${raw})`);
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
          ...(state.passed !== undefined && { passed: state.passed }),
        });
        if (u !== undefined) return bad(p, `is a link to ${real}, where ${u.dir} ${u.why}`);
        // A directory it leads to is code Node may load: walk it too, once. A package in a
        // node_modules (a dependency link: pnpm's store, a workspace package) is walked only when
        // something needs it at run time (`trustedClosure`), so dev dependencies are left out.
        let tst: fs.Stats | undefined;
        try {
          tst = fs.statSync(real);
        } catch {
          tst = undefined;
        }
        const parent = path.dirname(p);
        const depLink =
          path.basename(parent) === 'node_modules' ||
          (path.basename(parent).startsWith('@') &&
            path.basename(path.dirname(parent)) === 'node_modules');
        if (tst?.isDirectory() === true && !depLink && !visited.has(real) && !inRoot(real)) {
          visited.add(real);
          if (state.queueDir !== undefined) state.queueDir(real);
          else stack.push(real);
        }
      }
      continue;
    }
    if (st.isDirectory()) {
      // Walked already, as a package of the closure: not twice.
      if (p !== root && visited.has(p)) continue;
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

/** What `walk` shares across the packages of one closure: one count, one visited set. */
interface WalkState {
  count: number;
  visited: Set<string>;
  /** `trustedPath`'s memo for this one check. */
  passed?: Set<string>;
  /**
   * The closure takes over a directory a link leads to (`trustedClosure`): walked, its ancestors
   * checked and its runtime dependencies queued, as for any package. Without it, `walk` walks it.
   */
  queueDir?: (real: string) => void;
}

/**
 * Node's lookup directories above `start` (inclusive), up to `/`: each `<d>/node_modules`, or `d`
 * itself when it is a `node_modules`. Node loads from them whatever is not found nearer.
 */
function lookupDirs(start: string): string[] {
  const out: string[] = [];
  for (let d = start; ; d = path.dirname(d)) {
    out.push(path.basename(d) === 'node_modules' ? d : path.join(d, 'node_modules'));
    if (path.dirname(d) === d) break;
  }
  return [...new Set(out)];
}

/**
 * Node's global folders, searched by CommonJS `require` after every `node_modules`: each absolute
 * `NODE_PATH` entry (a relative one is refused: `relativeNodePath`) (from `env`, at check time), `~/.node_modules`, `~/.node_libraries` and
 * `<node prefix>/lib/node`. oortmem itself is ESM, which ignores them; its CommonJS dependencies
 * do not.
 */
export function globalFolders(
  env: Record<string, string | undefined>,
  home: string,
  execPath: string = process.execPath,
): string[] {
  const fromEnv = (env['NODE_PATH'] ?? '')
    .split(path.delimiter)
    .filter((p) => p !== '' && path.isAbsolute(p));
  return [
    ...new Set([
      ...fromEnv,
      path.join(home, '.node_modules'),
      path.join(home, '.node_libraries'),
      path.join(path.dirname(path.dirname(execPath)), 'lib', 'node'),
    ]),
  ];
}

/**
 * A relative `NODE_PATH` entry: Node resolves it against the hook's working directory (a repo the
 * agent is working in), so it is whatever someone put there, and `globalFolders` leaves it out.
 * Refused, with the fix of making it absolute or removing it (PR #78 review).
 */
export function relativeNodePath(env: Record<string, string | undefined>): Untrusted | undefined {
  const raw = env['NODE_PATH'] ?? '';
  const rel = raw.split(path.delimiter).find((p) => p !== '' && !path.isAbsolute(p));
  if (rel === undefined || process.platform === 'win32') return undefined;
  return {
    dir: rel,
    why: `is a relative NODE_PATH entry, which Node resolves against the working directory of whatever runs oort (such as a repo an agent is working in), so anyone who can write there decides what it loads`,
    fix: 'make it absolute, or remove it from NODE_PATH',
  };
}

/** The rules a searched folder is held to: strict inside `OORT_HOME`, lenient elsewhere. */
export interface SearchRules {
  home: string;
  /** Strict for this directory (the managed copy: inside OORT_HOME). */
  strictFor: (dir: string) => boolean;
  groupOk?: (gid: number) => boolean;
}

/**
 * Folders Node searches for anything not found nearer (`lookupDirs` above a package, or the
 * global folders), held to the trust boundary: nothing that anyone other than you (or root) can
 * write. Paths that are yours and writable only by you are trusted; write access to your own
 * files is already full compromise of your account. Each existing folder must pass
 * `trustedPath`, and everything in it is walked with the rules of its place (strict inside
 * OORT_HOME, lenient elsewhere), sharing the one cap of the check; a link in it is judged by
 * where the kernel takes it. A folder that passes is remembered for the process. Past the cap, or
 * on anything someone else can write, the fix is to move the folder aside: never chmod or chown
 * what is in a folder like this.
 */
export function searchedFolders(
  dirs: readonly string[],
  rules: SearchRules,
  state: WalkState,
  cap: number,
): Untrusted | undefined {
  if (process.platform === 'win32') return undefined;
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const dir of dirs) {
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue; // not there: nothing to load from it
    }
    const strict = rules.strictFor(dir);
    const ruleSet = {
      home: rules.home,
      strict,
      ...(rules.groupOk !== undefined && { groupOk: rules.groupOk }),
      ...(state.passed !== undefined && { passed: state.passed }),
    };
    const aside = (u: Pick<Untrusted, 'dir' | 'why'>): Untrusted => ({
      dir: u.dir,
      why: `${u.why}, and Node loads modules from ${dir} for anything not found nearer`,
      fix: `move ${sh(dir)} aside (Node searches it), or make everything in it writable only by you`,
    });
    const top = trustedPath(dir, ruleSet);
    if (top !== undefined) return aside(top);
    if (!st.isDirectory()) continue;
    const real = realpathOf(dir) ?? dir;
    // HOME only matters to a folder in it (or holding it): elsewhere the same folder passes or
    // fails the same for every HOME, so tests with a HOME each share the walk of a checkout above.
    const related = inside(real, [rules.home]) || inside(rules.home, [real]);
    const key = `${real}\0${strict ? 's' : 'l'}\0${related ? rules.home : ''}\0${cap}\0${st.mtimeMs}\0${st.ctimeMs}`;
    if (rules.groupOk === undefined && searchCache.has(key)) continue;
    const home = realpathOf(rules.home) ?? rules.home;
    let names: string[];
    try {
      names = fs.readdirSync(real);
    } catch {
      return aside({ dir: real, why: 'cannot be read' });
    }
    for (const n of names) {
      if (++state.count > cap) {
        return aside({ dir: real, why: `holds more than ${cap} entries to check` });
      }
      const p = path.join(real, n);
      let e: fs.Stats;
      try {
        e = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (e.isSymbolicLink()) {
        const inHome = p === home || p.startsWith(home + path.sep);
        if (me !== undefined && e.uid !== me && (strict || inHome || e.uid !== 0)) {
          return aside({ dir: p, why: 'belongs to another user' });
        }
        let target: string;
        try {
          target = fs.realpathSync.native(p);
        } catch {
          continue; // leads nowhere: nothing to load
        }
        const u = trustedPath(target, ruleSet);
        if (u !== undefined) {
          return aside({ dir: p, why: `is a link to ${target}, where ${u.dir} ${u.why}` });
        }
        // A directory it leads to is code Node loads: walked under the same rules and cap, once
        // (`visited`, by realpath), and remembered by its own mtime and ctime like a folder.
        let t: fs.Stats;
        try {
          t = fs.statSync(target);
        } catch {
          continue;
        }
        if (!t.isDirectory() || state.visited.has(target)) continue;
        const tkey = `${target}\0${strict ? 's' : 'l'}\0${related ? rules.home : ''}\0${cap}\0${t.mtimeMs}\0${t.ctimeMs}`;
        if (rules.groupOk === undefined && searchCache.has(tkey)) continue;
        const lw = walk(
          target,
          cap,
          {
            strict,
            home: rules.home,
            ...(rules.groupOk !== undefined && { groupOk: rules.groupOk }),
          },
          state,
        );
        if (lw !== undefined) {
          const capped = /holds more than/.test(lw.why);
          return aside(capped ? { dir: real, why: `holds more than ${cap} entries to check` } : lw);
        }
        if (rules.groupOk === undefined) searchCache.add(tkey);
        continue;
      }
      // A package, a scope folder or a file: all of it, by the same rules as the closure, under
      // the one cap. A package the closure walks as well is walked once (`visited`).
      if (e.isDirectory() && state.visited.has(p)) continue;
      const w = walk(
        p,
        cap,
        {
          strict,
          home: rules.home,
          ...(rules.groupOk !== undefined && { groupOk: rules.groupOk }),
        },
        state,
      );
      if (w !== undefined) {
        const capped = /holds more than/.test(w.why);
        return aside(capped ? { dir: real, why: `holds more than ${cap} entries to check` } : w);
      }
    }
    if (rules.groupOk === undefined) searchCache.add(key);
  }
  return undefined;
}

/**
 * Every existing `node_modules` Node would search above `start` (`lookupDirs`), checked and walked
 * as `searchedFolders` does. `checked` remembers the ones already done in this closure.
 */
export function ancestorModules(
  start: string,
  rules: SearchRules,
  state: WalkState = { count: 0, visited: new Set() },
  cap: number = OWN_TREE_CAP,
  checked: Set<string> = new Set(),
): Untrusted | undefined {
  const dirs = lookupDirs(start).filter((d) => !checked.has(d));
  for (const d of dirs) checked.add(d);
  return searchedFolders(dirs, rules, state, cap);
}

/** A package name as package.json may give it: `name` or `@scope/name`, never a path. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/** The packages `pkg` needs at run time: dependencies, optional ones, and peers when installed. */
function runtimeDeps(pkg: string): string[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const v = json[k];
    if (typeof v === 'object' && v !== null) for (const n of Object.keys(v)) names.add(n);
  }
  return [...names].filter((n) => PACKAGE_NAME.test(n));
}

/**
 * Where Node finds package `name` from a package at `fromReal` (its realpath): its `node_modules`
 * folders up to `/`, then the global folders (`NODE_PATH` and the rest). Undefined when none has it.
 */
function resolvePackage(
  fromReal: string,
  name: string,
  globals: readonly string[] = [],
): string | undefined {
  for (const dir of [...lookupDirs(fromReal), ...globals]) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

const closureCache = new Map<string, Untrusted | null>();

/**
 * A copy of your own (`--this-copy`, the fallback), walked as far as Node will load from it (PR
 * #78 review): its package, then every package it needs at run time (`dependencies`, optional
 * ones, installed peers), found the way Node finds them from each package's realpath, each walked
 * with the lenient rules, recursively, once each; and every `node_modules` Node would search above
 * them (`ancestorModules`). Dev dependencies are not walked: a pnpm checkout links them into
 * `node_modules` beside the runtime ones, and walking everything reachable from a dev checkout is
 * a whole pnpm store (about 194,000 entries and 5.6 s from this repository's own worktree). One
 * cap (`OWN_TREE_CAP`) for all of it; cached per process.
 */
export function trustedClosure(
  pkgRoot: string,
  opts: {
    home: string;
    env?: Record<string, string | undefined>;
    groupOk?: (gid: number) => boolean;
    cap?: number;
  },
): Untrusted | undefined {
  if (process.platform === 'win32') return undefined;
  const root = realpathOf(pkgRoot);
  if (root === undefined) {
    return { dir: pkgRoot, why: 'does not exist', fix: 'rebuild or reinstall it' };
  }
  const cap = opts.cap ?? OWN_TREE_CAP;
  const key = `${root}\0closure\0${cap}\0${opts.home}\0${opts.env?.['NODE_PATH'] ?? ''}`;
  const cached = opts.groupOk === undefined ? closureCache.get(key) : undefined;
  if (cached !== undefined) return cached ?? undefined;
  const rules = {
    home: opts.home,
    strict: false,
    ...(opts.groupOk !== undefined && { groupOk: opts.groupOk }),
  };
  const checked = new Set<string>();
  const queue = [root];
  const queued = new Set([root]);
  const enqueue = (real: string): void => {
    if (!queued.has(real)) {
      queued.add(real);
      queue.push(real);
    }
  };
  // A directory a link leads to is code too: walked, its ancestors checked, its deps queued.
  const state: WalkState = { count: 0, visited: new Set(), passed: new Set(), queueDir: enqueue };
  const search: SearchRules = {
    home: opts.home,
    strictFor: () => false,
    ...(opts.groupOk !== undefined && { groupOk: opts.groupOk }),
  };
  const globals = globalFolders(opts.env ?? {}, opts.home);
  let found: Untrusted | undefined =
    relativeNodePath(opts.env ?? {}) ?? searchedFolders(globals, search, state, cap);
  while (found === undefined && queue.length > 0) {
    const pkg = queue.shift() as string;
    state.visited.add(pkg);
    found =
      walk(pkg, cap, { ...rules, strict: false }, state) ??
      ancestorModules(path.dirname(pkg), search, state, cap, checked);
    if (found !== undefined) break;
    for (const name of runtimeDeps(pkg)) {
      const dep = resolvePackage(pkg, name, globals);
      if (dep === undefined) continue; // not installed (an optional or peer one): nothing to load
      const u = trustedPath(dep, { ...rules, passed: state.passed as Set<string> });
      if (u !== undefined) {
        found = {
          dir: u.dir,
          why: `${u.why} (on the way to ${name}, which ${path.basename(pkg)} loads)`,
          fix: u.fix,
        };
        break;
      }
      const real = realpathOf(dep);
      if (real !== undefined) enqueue(real);
    }
  }
  if (opts.groupOk === undefined) closureCache.set(key, found ?? null);
  return found;
}
