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

/** Walk up from `start` to the first directory containing `.git`. */
export function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main repository root for a checkout root. A `.git` directory: the
 * checkout is the main root. A `.git` file (`gitdir: <path>`, a linked
 * worktree): `<gitdir>/commondir` names the main repository's git directory,
 * whose parent is the main root (a bare repository is its own root). Reads
 * files only; never spawns git.
 *
 * A `.git` file can be forged (an extracted archive, a nested folder), so the
 * mapping is accepted only when the main repository vouches for it, all paths
 * realpathed: `gitdir` must sit directly in `<commonDir>/worktrees/`, and the
 * back-pointer `<gitdir>/gitdir` (inside the main repository, which a forger
 * cannot write) must name this checkout's `.git`. Any mismatch, missing file
 * or read error (a submodule has no `commondir`) falls back to `root` itself.
 */
function mainRootOf(root: string): string {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (m?.[1] === undefined) return root;
    const written = path.resolve(root, m[1]);
    const gitdir = fs.realpathSync(written);
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    if (common === '') return root;
    const commonDir = fs.realpathSync(path.resolve(gitdir, common));
    if (!fs.statSync(commonDir).isDirectory()) return root;
    if (path.dirname(gitdir) !== path.join(commonDir, 'worktrees')) return root;
    const back = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    if (back === '') return root;
    if (fs.realpathSync(path.resolve(gitdir, back)) !== fs.realpathSync(dotGit)) return root;
    // Verified on realpaths; the id uses the path as written (`<main>/.git/worktrees/<name>`),
    // so it matches what the main checkout derives when reached through the same symlinks.
    const main = path.resolve(written, common);
    return path.basename(main) === '.git' ? path.dirname(main) : main;
  } catch {
    return root;
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

/** Binds main repository root `root` to project id `id` (unprefixed) in the user's trust file (0600). */
export function linkProject(home: string, root: string, id: string): void {
  if (id === '' || [...id].some((c) => c.charCodeAt(0) < 0x20)) {
    throw new RangeError('project id must be non-empty, without control characters');
  }
  writeProjectLinks(home, { ...readProjectLinks(home), [root]: id });
}

/** Removes `root`'s binding; false when there was none. */
export function unlinkProject(home: string, root: string): boolean {
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
