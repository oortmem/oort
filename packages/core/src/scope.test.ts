import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localScope, projectIdFor } from './scope.js';

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

  it('localScope', () => {
    expect(localScope('p')).toEqual({
      orgId: 'local',
      customerId: 'self',
      agentId: 'claude-code',
      projectId: 'p',
    });
  });
});
