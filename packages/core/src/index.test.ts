import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from './index.js';
import { VERSION } from './index.js';

describe('core', () => {
  it('exports VERSION, equal to the published package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('exports adapters, fusion and the in-memory store but not the conformance suite', () => {
    expect(typeof core.scopeMatches).toBe('function');
    expect(typeof core.rrf).toBe('function');
    expect(typeof core.fuse).toBe('function');
    expect(typeof core.createMemoryStore).toBe('function');
    expect('storeConformance' in core).toBe(false);
  });
});
