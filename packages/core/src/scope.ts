import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Scope } from './model.js';

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

export function projectIdFor(cwd: string): string | undefined {
  const root = findGitRoot(cwd);
  if (root === undefined) return undefined;
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `${path.basename(root)}-${hash}`;
}
