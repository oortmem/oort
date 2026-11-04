import { describe, expect, it } from 'vitest';
import * as core from './index.js';
import { VERSION } from './index.js';

describe('core', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.0.0');
  });

  it('exports adapters, fusion and the in-memory store but not the conformance suite', () => {
    expect(typeof core.scopeMatches).toBe('function');
    expect(typeof core.rrf).toBe('function');
    expect(typeof core.fuse).toBe('function');
    expect(typeof core.createMemoryStore).toBe('function');
    expect('storeConformance' in core).toBe(false);
  });
});
