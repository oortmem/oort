import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Lovable-hosted asset stubs (`*.asset.json`, `/__l5e/...` URLs) only resolve on Lovable's
// own hosting; on oortcloud.dev they 404. Every asset must live in the repo.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('site assets', () => {
  it('has no Lovable-hosted asset references', () => {
    const src = join(__dirname, '..');
    const offenders = files(src).filter(
      (f) => f.endsWith('.asset.json') || /\/__l5e\//.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.filter((f) => !f.endsWith('no-lovable-assets.test.ts'))).toEqual([]);
  });
});
