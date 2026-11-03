import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localScope, projectIdFor, resolveProjectId } from './scope.js';

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

  it('resolveProjectId-config-overrides-derived', () => {
    // A main checkout and a worktree of it: each has its own `.git`, so each derives its own id.
    const main = tmp();
    fs.mkdirSync(path.join(main, '.git'));
    const worktree = path.join(tmp(), 'phase-1');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
    const sub = path.join(worktree, 'src');
    fs.mkdirSync(sub);
    expect(resolveProjectId(main)).toBe(projectIdFor(main));
    expect(resolveProjectId(sub)).toBe(projectIdFor(worktree));
    expect(resolveProjectId(main)).not.toBe(resolveProjectId(sub));

    // A config without `project.id` keeps the derived id.
    for (const dir of [main, worktree]) {
      fs.writeFileSync(
        path.join(dir, 'oort.config.json'),
        JSON.stringify({ project: { private: false } }),
      );
    }
    expect(resolveProjectId(main)).toBe(projectIdFor(main));
    expect(resolveProjectId(sub)).toBe(projectIdFor(worktree));

    // The same `project.id` in both: one project.
    for (const dir of [main, worktree]) {
      fs.writeFileSync(
        path.join(dir, 'oort.config.json'),
        JSON.stringify({ project: { id: 'oort' } }),
      );
    }
    expect(resolveProjectId(main)).toBe('oort');
    expect(resolveProjectId(sub)).toBe('oort');
    // Outside any repository, a config still names the project.
    const loose = tmp();
    expect(resolveProjectId(loose)).toBeUndefined();
    fs.writeFileSync(
      path.join(loose, 'oort.config.json'),
      JSON.stringify({ project: { id: 'x' } }),
    );
    expect(resolveProjectId(loose)).toBe('x');
    // An empty id is refused, naming the file.
    fs.writeFileSync(path.join(loose, 'oort.config.json'), JSON.stringify({ project: { id: '' } }));
    expect(() => resolveProjectId(loose)).toThrow(path.join(loose, 'oort.config.json'));
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
