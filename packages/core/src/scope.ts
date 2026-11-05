import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { configuredProjectId } from './config.js';
import type { Scope } from './model.js';
import { writePrivateFile } from './private-fs.js';

export type { Scope };

export function localScope(projectId?: string): Scope {
  const scope: Scope = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
  if (projectId !== undefined) scope.projectId = projectId;
  return scope;
}

/**
 * `p` resolved, then realpathed by the OS (`realpath(3)`), or `p` resolved when
 * it cannot be (it vanished, a permission error). The native call returns the
 * spelling on disk, so on a case-insensitive filesystem (APFS, HFS+, NTFS)
 * `~/Repos/Oort` and `~/repos/oort` give one path, where `fs.realpathSync`
 * would keep the case as typed and split one repository into two project ids.
 * Every path that feeds an id or a trust binding goes through this.
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Walk up from `start` to the first directory containing `.git`. The walk
 * starts from `start` realpathed, as git does (it walks from the physical
 * cwd): a symlink inside one repository that leads into another must land on
 * the other, never on the repository the symlink happens to sit in.
 */
export function findGitRoot(start: string): string | undefined {
  let dir = canonicalPath(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main repository root for a checkout root, always realpathed, so derived
 * ids and trust bindings agree however the checkout was reached. A `.git`
 * directory: the checkout is the main root. A `.git` file (`gitdir: <path>`,
 * a linked worktree): `<gitdir>/commondir` names the main repository's git
 * directory, whose parent is the main root (a bare repository is its own
 * root). Reads files only; never spawns git.
 *
 * A `.git` file can be forged (an extracted archive, a nested folder), so the
 * mapping is accepted only when the main repository vouches for it, all paths
 * realpathed: `gitdir` must sit directly in `<commonDir>/worktrees/`, and the
 * back-pointer `<gitdir>/gitdir` (inside the main repository, which a forger
 * cannot write) must name this checkout's own `.git` (`<realpath(root)>/.git`).
 * A `.git` that is itself a symlink is never followed. The root returned is derived
 * from that verified `commonDir` and nothing else: a lexical resolution of the
 * written path could run through an attacker's symlink to another repository.
 * Any mismatch, missing file or read error (a submodule has no `commondir`)
 * falls back to `root` itself. That includes a stale worktree whose main
 * checkout was moved or deleted (its `gitdir` no longer exists) or replaced
 * by an unrelated repository (no back-pointer naming this checkout): it gets
 * the id of its own root, never an error and never the new repository's id.
 *
 * Stale admin dirs (decided for CON-53): a worktree deleted without
 * `git worktree prune` leaves `<commonDir>/worktrees/<name>/` behind, so a
 * directory recreated at exactly that path with the same `.git` file passes
 * both checks and shares the main repository's id. This matches git, which
 * treats that directory as the worktree and serves it the main repository's
 * objects and refs, so the id grants nothing git does not already. An mtime
 * rule (the admin `gitdir` no older than the checkout's `.git`) was rejected:
 * `git worktree add` writes `gitdir` before `.git`, so it would refuse every
 * fresh worktree, and an extracted archive sets whatever mtimes it carries.
 */
function mainRootOf(root: string): string {
  const own = canonicalPath(root);
  const dotGit = path.join(root, '.git');
  try {
    // A symlinked `.git` (to a file or a directory) never inherits another
    // checkout's identity: archives carry symlinks, and checkout paths are guessable.
    const entry = fs.lstatSync(dotGit);
    if (entry.isSymbolicLink()) return own;
    if (entry.isDirectory()) return own;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (m?.[1] === undefined) return own;
    const gitdir = fs.realpathSync.native(path.resolve(root, m[1]));
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    if (common === '') return own;
    const commonDir = fs.realpathSync.native(path.resolve(gitdir, common));
    if (!fs.statSync(commonDir).isDirectory()) return own;
    if (path.dirname(gitdir) !== path.join(commonDir, 'worktrees')) return own;
    const back = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    if (back === '') return own;
    // The back-pointer must name this checkout's own `.git`, not wherever it leads.
    if (fs.realpathSync.native(path.resolve(gitdir, back)) !== path.join(own, '.git')) return own;
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  } catch {
    return own;
  }
}

/** The main repository root above `cwd` (a linked worktree resolves to its main checkout). */
export function projectRootFor(cwd: string): string | undefined {
  const root = findGitRoot(cwd);
  return root === undefined ? undefined : mainRootOf(root);
}

/**
 * The id derived from the main repository root above `cwd`:
 * `<basename>-<sha256(root) prefix>`, so every worktree of a repository shares
 * it. A `:` in the basename becomes `_`, so a derived id never contains `:`
 * and never equals a configured (`cfg:`) one.
 */
export function projectIdFor(cwd: string): string | undefined {
  const root = projectRootFor(cwd);
  if (root === undefined) return undefined;
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `${path.basename(root).replaceAll(':', '_')}-${hash}`;
}

/** The prefix of every configured project id: it keeps them apart from derived ids. */
export const CONFIGURED_ID_PREFIX = 'cfg:';

/** Trust bindings (main repository root to project id), under `OORT_HOME`. */
export const PROJECT_LINKS_FILE = 'project-links.json';

/**
 * The user's trust bindings: main repository root to configured project id.
 * A missing or unreadable file means none (so an untrusted id is never honoured
 * by accident).
 */
export function readProjectLinks(home: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(home, PROJECT_LINKS_FILE), 'utf8'));
  } catch {
    return {};
  }
  const links = (parsed as { links?: unknown } | null)?.links;
  if (typeof links !== 'object' || links === null || Array.isArray(links)) return {};
  const out: Record<string, string> = {};
  for (const [root, id] of Object.entries(links)) {
    if (typeof id === 'string' && id !== '') out[root] = id;
  }
  return out;
}

function writeProjectLinks(home: string, links: Record<string, string>): void {
  writePrivateFile(
    path.join(home, PROJECT_LINKS_FILE),
    `${JSON.stringify({ version: 1, links }, null, 2)}\n`,
  );
}

/**
 * Binds main repository root `root` to project id `id` (unprefixed) in the
 * user's trust file (0600). The key is `canonicalPath(root)`, the form
 * `projectRootFor` returns, so a binding made through a symlink or with other
 * case still applies.
 */
export function linkProject(home: string, root: string, id: string): void {
  if (id === '' || [...id].some((c) => c.charCodeAt(0) < 0x20)) {
    throw new RangeError('project id must be non-empty, without control characters');
  }
  writeProjectLinks(home, { ...readProjectLinks(home), [canonicalPath(root)]: id });
}

/** Removes `root`'s binding (canonicalised, as `linkProject` keys it); false when there was none. */
export function unlinkProject(home: string, root: string): boolean {
  root = canonicalPath(root);
  const links = readProjectLinks(home);
  if (!(root in links)) return false;
  delete links[root];
  writeProjectLinks(home, links);
  return true;
}

export interface ProjectResolution {
  /** The project id, or undefined outside a repository. */
  projectId: string | undefined;
  /** The main repository root, when inside one. */
  root?: string;
  /** A repository file's `project.id` that was ignored: no trust binding for `root`. */
  untrustedId?: string;
}

/**
 * The project for `cwd` (spec §8). `oort.config.json` is committed with the
 * repository, so its `project.id` is attacker-controlled in a cloned repo and
 * cannot choose a memory scope by itself. The id is:
 * - `cfg:<id>` when `OORT_HOME` binds the main repository root to `<id>`
 *   (`oort project link`), whatever the repository file says;
 * - otherwise the id derived from the main repository root (shared by every
 *   worktree). A `project.id` in the repository file is then reported as
 *   `untrustedId` and ignored.
 * Every scope resolution goes through this.
 */
export function resolveProject(cwd: string, home: string): ProjectResolution {
  const root = projectRootFor(cwd);
  if (root === undefined) return { projectId: undefined };
  const bound = readProjectLinks(home)[root];
  if (bound !== undefined) return { projectId: `${CONFIGURED_ID_PREFIX}${bound}`, root };
  let configured: string | undefined;
  try {
    configured = configuredProjectId(cwd);
  } catch {
    configured = undefined; // An invalid file is reported by config resolution, not here.
  }
  return {
    projectId: projectIdFor(cwd),
    root,
    ...(configured !== undefined && { untrustedId: configured }),
  };
}

/** `resolveProject(cwd, home).projectId`. */
export function resolveProjectId(cwd: string, home: string): string | undefined {
  return resolveProject(cwd, home).projectId;
}
