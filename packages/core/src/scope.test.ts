import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalPath,
  CONFIGURED_ID_PREFIX,
  findGitRoot,
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
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oort-scope-')));
}

/** `p` with its last component's case swapped, or undefined when the swap changes nothing. */
function recased(p: string): string | undefined {
  const base = path.basename(p);
  const swapped = [...base]
    .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
    .join('');
  return swapped === base ? undefined : path.join(path.dirname(p), swapped);
}

/** Whether the temp directory's filesystem ignores case (APFS and HFS+ defaults, NTFS). */
const caseInsensitiveTmp = ((): boolean => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-CaseProbe-'));
  try {
    const other = recased(probe);
    return other !== undefined && fs.existsSync(other);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();
/** Why the case tests skip on a case-sensitive filesystem. */
const CASE_SKIP = 'on a case-sensitive one, two spellings are two directories';

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
    // The main repository's back-pointer to the worktree, as `git worktree add` writes it.
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`);
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

  it('scope.forged-worktree-pointer-falls-back-to-own-root', () => {
    const victim = repo('private-payments');
    const victimId = projectIdFor(victim);
    // An attacker directory posing as a worktree's git dir, naming the victim as its main repo.
    const evil = path.join(tmp(), 'evil');
    const forged = path.join(tmp(), 'unzipped');
    fs.mkdirSync(forged);
    fs.writeFileSync(path.join(forged, '.git'), `gitdir: ${evil}\n`);
    const layouts: [string, () => void][] = [
      [
        'commondir only',
        () => {
          fs.mkdirSync(evil, { recursive: true });
          fs.writeFileSync(path.join(evil, 'commondir'), `${path.join(victim, '.git')}\n`);
        },
      ],
      [
        'with a back-pointer to the forged checkout',
        () => fs.writeFileSync(path.join(evil, 'gitdir'), `${path.join(forged, '.git')}\n`),
      ],
    ];
    for (const [label, build] of layouts) {
      build();
      expect(projectRootFor(forged), label).toBe(forged);
      expect(projectIdFor(forged), label).not.toBe(victimId);
      expect(projectIdFor(forged), label).toMatch(/^unzipped-[0-9a-f]{8}$/);
    }
    // A gitdir really inside the victim's worktrees/ whose back-pointer names another checkout.
    const real = worktreeOf(victim, 'wt');
    const pointed = path.join(victim, '.git', 'worktrees', 'wt');
    const other = path.join(tmp(), 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, '.git'), `gitdir: ${pointed}\n`);
    expect(projectIdFor(real)).toBe(victimId);
    expect(projectRootFor(other)).toBe(other);
  });

  it('scope.forged-worktree-pointer-through-symlink-falls-back', () => {
    // Lexical `..` from the forged gitdir path lands on the victim,
    // while the realpath lands on a fake main repo that passes both checks.
    const base = tmp();
    const victim = path.join(base, 'private');
    fs.mkdirSync(path.join(victim, '.git'), { recursive: true });
    const evil = path.join(base, 'evil');
    const fakeGitdir = path.join(evil, 'fake', '.git', 'worktrees', 'x');
    fs.mkdirSync(fakeGitdir, { recursive: true });
    fs.symlinkSync('.', path.join(evil, 'fake', 'private')); // fake/private -> fake
    fs.symlinkSync(path.join(evil, 'fake', '.git', 'worktrees'), path.join(evil, 'L'));
    fs.writeFileSync(path.join(fakeGitdir, 'commondir'), '../../../private/.git\n');
    const wt = path.join(evil, 'wt');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(fakeGitdir, 'gitdir'), `${path.join(wt, '.git')}\n`);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(evil, 'L', 'x')}\n`);
    const home = path.join(base, 'home');
    linkProject(home, projectRootFor(victim) ?? victim, 'secret');

    const cwd = path.join(wt, 'sub');
    expect(projectRootFor(cwd)).not.toBe(victim);
    expect(projectIdFor(cwd)).not.toBe(projectIdFor(victim));
    expect(resolveProjectId(cwd, home)).not.toBe('cfg:secret');
    expect(resolveProjectId(cwd, home)).not.toBe(resolveProjectId(victim, home));
    expect(resolveProjectId(victim, home)).toBe('cfg:secret');
  });

  it('scope.symlinked-dot-git-does-not-inherit-identity', () => {
    const main = repo('private-main');
    const wt = worktreeOf(main, 'private-wt');
    const id = projectIdFor(main);
    // The legitimate worktree still shares the main repo's id.
    expect(projectIdFor(wt)).toBe(id);
    for (const [label, target] of [
      ["the worktree's .git file", path.join(wt, '.git')],
      ["the main repo's .git directory", path.join(main, '.git')],
    ] as const) {
      // An extracted archive whose `.git` is a symlink to a guessable real checkout's.
      const attacker = path.join(tmp(), 'unpacked');
      fs.mkdirSync(path.join(attacker, 'src'), { recursive: true });
      fs.symlinkSync(target, path.join(attacker, '.git'));
      expect(projectRootFor(path.join(attacker, 'src')), label).toBe(attacker);
      expect(projectIdFor(attacker), label).not.toBe(id);
      expect(projectIdFor(attacker), label).toMatch(/^unpacked-[0-9a-f]{8}$/);
    }
  });

  it('scope.symlinked-main-checkout-and-worktree-share-id', () => {
    const real = tmp();
    const main = repo();
    // The same main checkout reached through a symlinked parent.
    const via = path.join(real, 'via');
    fs.symlinkSync(path.dirname(main), via);
    const mainViaLink = path.join(via, path.basename(main));
    // A legitimate worktree whose `.git` file names the main repo through the symlink.
    const gitdir = path.join(mainViaLink, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = path.join(tmp(), 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`);

    const id = projectIdFor(main);
    expect(projectIdFor(mainViaLink)).toBe(id);
    expect(projectIdFor(wt)).toBe(id);
    expect(projectRootFor(mainViaLink)).toBe(main);
    // The binding is keyed on the realpathed main root: linked one way, found every way.
    const home = path.join(real, 'home');
    linkProject(home, projectRootFor(mainViaLink) ?? '', 'oort');
    for (const cwd of [main, mainViaLink, wt]) expect(resolveProjectId(cwd, home)).toBe('cfg:oort');
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

  it('scope.canonical-path-normalises-symlinks-case-and-missing-paths', () => {
    const base = tmp();
    const real = path.join(base, 'RealDir');
    fs.mkdirSync(path.join(real, 'Sub'), { recursive: true });
    fs.symlinkSync(real, path.join(base, 'alias'));
    // A symlink resolves to its target; an existing path keeps its on-disk spelling.
    expect(canonicalPath(path.join(base, 'alias', 'Sub'))).toBe(path.join(real, 'Sub'));
    expect(canonicalPath(real)).toBe(real);
    // Relative input is resolved first; a path that does not exist comes back resolved, not thrown.
    const missing = path.join(base, 'gone', 'x');
    expect(canonicalPath(missing)).toBe(missing);
    expect(canonicalPath(path.join(missing, '..', 'y'))).toBe(path.join(base, 'gone', 'y'));
  });

  it.skipIf(!caseInsensitiveTmp)(
    `scope.canonical-path-folds-case (case-insensitive fs only: ${CASE_SKIP})`,
    () => {
      const base = tmp();
      const real = path.join(base, 'MixedCase');
      fs.mkdirSync(path.join(real, 'Inner'), { recursive: true });
      // Whatever case was typed, the result is the spelling on disk.
      expect(canonicalPath(path.join(base, 'mixedcase', 'inner'))).toBe(path.join(real, 'Inner'));
      expect(canonicalPath(path.join(base, 'MIXEDCASE'))).toBe(real);
    },
  );

  it.skipIf(!caseInsensitiveTmp)(
    `scope.repo-reached-with-different-case-has-one-id (case-insensitive fs only: ${CASE_SKIP})`,
    () => {
      const main = repo('CaseRepo');
      fs.mkdirSync(path.join(main, 'src'));
      const wt = worktreeOf(main, 'CaseWt');
      const id = projectIdFor(main);
      const lowerMain = recased(main) ?? '';
      const lowerWt = recased(wt) ?? '';
      expect(fs.existsSync(lowerMain)).toBe(true);
      // The main checkout and its worktree, each typed with the wrong case, map to one id.
      expect(projectRootFor(path.join(lowerMain, 'src'))).toBe(main);
      expect(projectIdFor(path.join(lowerMain, 'src'))).toBe(id);
      expect(findGitRoot(lowerWt)).toBe(wt);
      expect(projectIdFor(path.join(lowerWt, 'src'))).toBe(id);
      // A binding made through one spelling applies through the other.
      const home = path.join(tmp(), 'home');
      linkProject(home, lowerMain, 'cased');
      for (const cwd of [main, lowerMain, wt, lowerWt]) {
        expect(resolveProjectId(cwd, home)).toBe('cfg:cased');
      }
      expect(unlinkProject(home, main)).toBe(true);
    },
  );

  it('scope.symlinked-cwd-walks-from-its-real-path', () => {
    const base = tmp();
    const outer = path.join(base, 'outer');
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    const inner = path.join(base, 'inner');
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    fs.mkdirSync(path.join(inner, 'pkg', 'src'), { recursive: true });
    // A symlink inside `outer` leading into `inner`: a lexical walk would stop at `outer`.
    const inside = path.join(outer, 'vendored');
    fs.symlinkSync(path.join(inner, 'pkg'), inside);
    expect(findGitRoot(inside)).toBe(inner);
    expect(findGitRoot(path.join(inside, 'src'))).toBe(inner);
    expect(projectIdFor(path.join(inside, 'src'))).toBe(projectIdFor(inner));
    expect(projectIdFor(inside)).not.toBe(projectIdFor(outer));
    // A symlink from outside any repository still finds the repository it leads into.
    const loose = path.join(base, 'loose');
    fs.mkdirSync(loose);
    fs.symlinkSync(path.join(inner, 'pkg', 'src'), path.join(loose, 'here'));
    expect(findGitRoot(path.join(loose, 'here'))).toBe(inner);
    expect(projectRootFor(path.join(loose, 'here'))).toBe(inner);
    // A cwd that no longer exists is walked as written, never thrown on.
    expect(findGitRoot(path.join(inner, 'deleted', 'dir'))).toBe(inner);
  });

  it('scope.stale-worktree-with-moved-or-deleted-main-falls-back-to-own-root', () => {
    for (const fate of ['moved', 'deleted', 'replaced by an unrelated repo'] as const) {
      const main = repo('origin-main');
      const wt = worktreeOf(main, 'feature');
      const originalId = projectIdFor(main);
      expect(projectIdFor(wt), fate).toBe(originalId);
      if (fate === 'moved') {
        fs.renameSync(main, path.join(tmp(), 'origin-main'));
      } else {
        fs.rmSync(main, { recursive: true, force: true });
      }
      if (fate === 'replaced by an unrelated repo') {
        // Someone else's repository now sits at the old path, with its own worktree of the same name.
        fs.mkdirSync(path.join(main, '.git'), { recursive: true });
        worktreeOf(main, 'feature');
      }
      const resolution = resolveProject(path.join(wt, 'src'), path.join(tmp(), 'home'));
      expect(resolution.root, fate).toBe(wt);
      expect(resolution.projectId, fate).toBe(projectIdFor(wt));
      expect(resolution.projectId, fate).toMatch(/^feature-[0-9a-f]{8}$/);
      if (fate === 'replaced by an unrelated repo') {
        expect(resolution.projectId, fate).not.toBe(projectIdFor(main));
      }
    }
  });

  it('scope.recreated-worktree-path-matches-git (stale admin dir, documented)', () => {
    // Decision (CON-53): a worktree deleted without `git worktree prune` leaves its admin dir,
    // and a checkout recreated at exactly that path with the same `.git` file shares the main
    // repo's id. Git itself treats that directory as the worktree (it reads the main repo's
    // objects and refs from there), so Oort trusts it the same way. See `mainRootOf`.
    const main = repo('kept-main');
    const wt = worktreeOf(main, 'gone');
    const dotGit = fs.readFileSync(path.join(wt, '.git'), 'utf8');
    fs.rmSync(wt, { recursive: true, force: true });
    expect(fs.existsSync(path.join(main, '.git', 'worktrees', 'gone', 'gitdir'))).toBe(true);
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), dotGit);
    expect(projectRootFor(wt)).toBe(main);
    // A checkout recreated anywhere else is still refused by the back-pointer.
    const elsewhere = path.join(tmp(), 'gone');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, '.git'), dotGit);
    expect(projectRootFor(elsewhere)).toBe(elsewhere);
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
