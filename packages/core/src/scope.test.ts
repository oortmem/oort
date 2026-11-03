import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIGURED_ID_PREFIX,
  linkProject,
  localScope,
  PROJECT_LINKS_FILE,
  projectIdFor,
  projectRootFor,
  resolveProject,
  resolveProjectId,
  unlinkProject,
} from './scope.js';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oort-scope-')));
}

describe('scope', () => {
  it('projectIdFor-git-root', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.git'));
    const sub = path.join(root, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const id = projectIdFor(sub);
    expect(id).toMatch(new RegExp(`^${path.basename(root)}-[0-9a-f]{8}$`));
    expect(projectIdFor(sub)).toBe(id);
    expect(projectIdFor(root)).toBe(id);
    const plain = tmp();
    expect(projectIdFor(plain)).toBeUndefined();
  });

  /** A main checkout at `main` and a linked worktree of it at `<tmp>/<name>`, as git lays them out. */
  function worktreeOf(main: string, name: string): string {
    const gitdir = path.join(main, '.git', 'worktrees', name);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = path.join(tmp(), name);
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    return wt;
  }

  function repo(name = 'main'): string {
    const root = path.join(tmp(), name);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    return root;
  }

  const config = (dir: string, project: object): void =>
    fs.writeFileSync(path.join(dir, 'oort.config.json'), JSON.stringify({ project }));

  it('scope.worktree-shares-main-root-id', () => {
    const main = repo();
    const wt = worktreeOf(main, 'phase-1');
    const id = projectIdFor(main);
    // A normal checkout keeps its id format: basename plus the root's hash.
    const hash = createHash('sha256').update(main).digest('hex').slice(0, 8);
    expect(id).toBe(`main-${hash}`);
    expect(projectIdFor(path.join(wt, 'src'))).toBe(id);
    expect(projectRootFor(wt)).toBe(main);

    // Malformed or partial layouts fall back to the worktree root.
    const broken = path.join(tmp(), 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.git'), 'not a gitdir line\n');
    expect(projectRootFor(broken)).toBe(broken);
    const submodule = path.join(tmp(), 'sub');
    fs.mkdirSync(path.join(main, '.git', 'modules', 'sub'), { recursive: true });
    fs.mkdirSync(submodule);
    fs.writeFileSync(
      path.join(submodule, '.git'),
      `gitdir: ${path.join(main, '.git', 'modules', 'sub')}\n`,
    );
    expect(projectRootFor(submodule)).toBe(submodule); // no commondir
  });

  it('scope.repo-config-id-ignored-without-trust-binding', () => {
    const home = tmp();
    const main = repo();
    config(main, { id: 'payments-private' });
    expect(resolveProject(main, home)).toEqual({
      projectId: projectIdFor(main),
      root: main,
      untrustedId: 'payments-private',
    });
    expect(resolveProjectId(main, home)).toBe(projectIdFor(main));
    // A config without an id, or no repository at all, reports nothing untrusted.
    config(main, { private: false });
    expect(resolveProject(main, home).untrustedId).toBeUndefined();
    const loose = tmp();
    config(loose, { id: 'x' });
    expect(resolveProject(loose, home)).toEqual({ projectId: undefined });
  });

  it('scope.repo-config-id-honoured-after-link', () => {
    const home = path.join(tmp(), 'oort-home');
    const main = repo();
    const wt = worktreeOf(main, 'feature');
    config(main, { id: 'oort' });
    linkProject(home, main, 'oort');
    const file = path.join(home, PROJECT_LINKS_FILE);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(resolveProjectId(main, home)).toBe('cfg:oort');
    // The binding is on the main root, so every worktree shares it.
    expect(resolveProjectId(path.join(wt, 'src'), home)).toBe('cfg:oort');
    // The binding is the user's choice: a later change to the repository file does not move it.
    config(main, { id: 'someone-elses' });
    expect(resolveProjectId(main, home)).toBe('cfg:oort');
    expect(unlinkProject(home, main)).toBe(true);
    expect(unlinkProject(home, main)).toBe(false);
    expect(resolveProjectId(main, home)).toBe(projectIdFor(main));
    expect(() => linkProject(home, main, '')).toThrow(RangeError);
  });

  it('scope.configured-id-cannot-equal-derived-id', () => {
    const home = tmp();
    // Even a directory named to look configured derives an id without `:`.
    const tricky = repo('cfg:victim');
    const derived = projectIdFor(tricky);
    expect(derived).toMatch(/^cfg_victim-[0-9a-f]{8}$/);
    const main = repo();
    for (const id of [derived ?? '', projectIdFor(main) ?? '', 'victim']) {
      linkProject(home, main, id);
      const configured = resolveProjectId(main, home);
      expect(configured).toBe(`${CONFIGURED_ID_PREFIX}${id}`);
      expect(configured).not.toBe(derived);
      expect(configured).not.toBe(projectIdFor(main));
      expect(configured?.includes(':')).toBe(true);
    }
  });

  it('localScope', () => {
    expect(localScope('p')).toEqual({
      orgId: 'local',
      customerId: 'self',
      agentId: 'claude-code',
      projectId: 'p',
    });
  });
});
