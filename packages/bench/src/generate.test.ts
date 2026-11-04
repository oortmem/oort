import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateMemories, PROJECTS } from './generate.js';

function digest(n: number, seed: number): string {
  const first = generateMemories(n, seed).slice(0, 100);
  const h = createHash('sha256');
  for (const m of first)
    h.update(JSON.stringify({ ...m, embedding: Array.from(m.embedding ?? []) }));
  return h.digest('hex');
}

it('generate.deterministic', () => {
  expect(digest(300, 42)).toBe(digest(300, 42));
  expect(digest(300, 42)).not.toBe(digest(300, 43));
});

describe('generate.shape', () => {
  const ms = generateMemories(2000, 7);

  it('has the requested count, unique ids, 512-d embeddings and valid fields', () => {
    expect(ms).toHaveLength(2000);
    expect(new Set(ms.map((m) => m.id)).size).toBe(2000);
    for (const m of ms) {
      expect(m.text.length).toBeGreaterThanOrEqual(40);
      expect(m.text.length).toBeLessThanOrEqual(500);
      expect(m.embedding).toHaveLength(512);
      expect(m.salience).toBeGreaterThanOrEqual(0.1);
      expect(m.salience).toBeLessThanOrEqual(1);
    }
  });

  it('covers all four types, five projects plus global, and about 10% pinned', () => {
    expect(new Set(ms.map((m) => m.type))).toEqual(
      new Set(['semantic', 'episodic', 'procedural', 'preference']),
    );
    expect(new Set(ms.map((m) => m.scope.projectId ?? null))).toEqual(new Set([null, ...PROJECTS]));
    const pinned = ms.filter((m) => m.pinned).length / ms.length;
    expect(pinned).toBeGreaterThan(0.06);
    expect(pinned).toBeLessThan(0.14);
  });

  it('puts about 5% of the memories in valid A to B to C supersede chains', () => {
    const byId = new Map(ms.map((m) => [m.id, m]));
    const inChain = ms.filter((m) => m.supersedes !== null || m.supersededBy !== null);
    expect(inChain.length / ms.length).toBeGreaterThan(0.04);
    expect(inChain.length / ms.length).toBeLessThan(0.06);
    const heads = ms.filter((m) => m.supersedes === null && m.supersededBy !== null);
    expect(heads.length).toBeGreaterThan(0);
    for (const a of heads) {
      const b = byId.get(a.supersededBy ?? '');
      const c = byId.get(b?.supersededBy ?? '');
      expect(b?.supersedes).toBe(a.id);
      expect(c?.supersedes).toBe(b?.id);
      expect(a.validTo).toBe(b?.validFrom);
      expect(b?.validTo).toBe(c?.validFrom);
      expect(c?.validTo).toBeNull();
      expect(a.endReason).toBe('superseded');
      expect(a.expiredAt).not.toBeNull();
      expect(c?.expiredAt).toBeNull();
      expect(Date.parse(a.validFrom)).toBeLessThan(Date.parse(b?.validFrom ?? ''));
    }
  });
});
