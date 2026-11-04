// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logStatus } from '@/lib/log';

const SRC = resolve(import.meta.dirname, '..');
/** Files whose `console.` text is example code shown on the page, not code that runs. */
const SAMPLES = new Set(['routes/docs/frameworks.tsx']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'test' ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

afterEach(() => vi.restoreAllMocks());

/** Reads a wrangler.jsonc: strips comments outside strings and trailing commas. */
function jsonc(path: string): Record<string, unknown> {
  const src = readFileSync(path, 'utf8')
    .replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (_m, str: string | undefined) => str ?? '',
    )
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(src) as Record<string, unknown>;
}

describe('the site logs status and timing only (review I6)', () => {
  it('has no console call outside src/lib/log.ts', () => {
    const offenders = files(SRC)
      .map((p) => relative(SRC, p))
      .filter((p) => p !== 'lib/log.ts' && !SAMPLES.has(p) && p !== 'routeTree.gen.ts')
      .filter((p) => /\bconsole\.[a-z]+\s*\(/.test(readFileSync(join(SRC, p), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('turns Workers invocation logs off on the site and the relay', () => {
    for (const app of ['site', 'relay']) {
      const cfg = jsonc(resolve(SRC, '..', '..', app, 'wrangler.jsonc'));
      const o = cfg['observability'] as { logs?: { invocation_logs?: boolean } };
      expect(o.logs?.invocation_logs, app).toBe(false);
    }
  });

  it('logStatus writes one line with the status and duration, nothing else', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logStatus(500, 12);
    logStatus(500);
    expect(err.mock.calls.map((c) => c.join(' '))).toEqual([
      '{"status":500,"ms":12}',
      '{"status":500}',
    ]);
  });
});
