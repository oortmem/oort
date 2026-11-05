import { describe, expect, it } from 'vitest';
import { addressOf, authorOf, canonicalMemory, nodeOf } from './address.js';
import { exportLine, ExportFormatError, formatExport, parseExport } from './export-format.js';
import { nodeGrant } from './grant.js';
import { createMemoryStore } from './memory-store.js';
import { localScope } from './scope.js';
import { LEVEL_CASES, makeMemory, memoryAt, TG, vec } from './store-conformance.js';

const AT = new Date('2026-11-05T00:00:00.000Z');

function sample() {
  const planet = [
    makeMemory({ id: 'p-global', embedding: vec(1, -2, 3, -128) }),
    makeMemory({ id: 'p-project', scope: localScope('oort-1a2b3c4d'), pinned: true }),
  ];
  const levels = LEVEL_CASES.map((c, i) =>
    memoryAt(`l-${c.name}`, c.address, c.author, {
      embedding: vec(i, 1, 2, 3),
      ...(c.provenance !== undefined && { provenance: c.provenance }),
    }),
  );
  return { planet, levels };
}

describe('export format', () => {
  it('export.v2-roundtrips-every-level', () => {
    const { planet, levels } = sample();
    const all = [...planet, ...levels];
    const text = formatExport(all, 2, AT);
    const lines = text
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ oort: 'export', version: 2, memories: all.length });
    expect(lines[0]?.['addresses']).toHaveLength(all.length);
    for (const l of lines.slice(1)) {
      expect(l).toHaveProperty('address');
      expect(l).toHaveProperty('author');
      expect(l).toHaveProperty('provenance');
      expect('scope' in l).toBe((l['address'] as { level: string }).level === 'user');
    }
    const parsed = parseExport(text);
    expect(parsed.version).toBe(2);
    expect(parsed.memories).toEqual(all.map((m) => canonicalMemory(m)));
  });

  it('export.v1-still-reads-as-the-planet', () => {
    const { planet } = sample();
    const v1 = formatExport(planet, 1, AT);
    const head = JSON.parse(v1.split('\n')[0] ?? '') as Record<string, unknown>;
    expect(head).toEqual({
      oort: 'export',
      version: 1,
      exportedAt: AT.toISOString(),
      memories: 2,
      scopes: [localScope(), localScope('oort-1a2b3c4d')],
    });
    // Byte-compatible with what 0.2.1 wrote for the same memories: scope, no level fields.
    expect(Object.keys(exportLine(planet[0]!, 1))).not.toContain('address');
    const parsed = parseExport(v1);
    expect(parsed.memories).toEqual(planet);
    expect(parsed.memories.map((m) => addressOf(m).level)).toEqual(['user', 'user']);

    // Into another person's account: their Planet, same agent and project.
    const moved = parseExport(v1, { planet: { orgId: 'acct:7', customerId: 'self' } });
    expect(addressOf(moved.memories[1]!)).toEqual({
      level: 'user',
      orgId: 'acct:7',
      customerId: 'self',
      projectId: 'oort-1a2b3c4d',
    });
    expect(authorOf(moved.memories[1]!)).toEqual({ agentId: 'claude-code' });
  });

  it('export.v1-refuses-other-levels', () => {
    const { levels } = sample();
    for (const m of levels) {
      if (addressOf(m).level === 'user') {
        // Another agent's Planet memory is still a plain version 1 line (its scope names the agent).
        expect(exportLine(m, 1)['scope']).toEqual(m.scope);
      } else {
        expect(() => exportLine(m, 1), m.id).toThrow(ExportFormatError);
      }
    }
  });

  it('export.rejects-what-it-cannot-read', () => {
    const ok = formatExport([makeMemory({ id: 'x' })], 2, AT);
    const [head, line] = ok.trimEnd().split('\n');
    const bad: [string, RegExp][] = [
      ['', /line 1/],
      ['{"oort":"export","version":3,"memories":0}', /version 3/],
      [`${head}\n`, /counts 1 memories, the file has 0/],
      [`${head}\nnot json\n`, /line 2 is not JSON/],
      [`${head}\n{"text":"no id"}\n`, /line 2 is not a memory/],
      [
        `${head}\n${line?.replace('"level":"user"', '"level":"team"')}\n`,
        /line 2: address: unknown level/,
      ],
      [`${head}\n${line?.replace(/"address":\{[^}]*\},/, '')}\n`, /line 2: a version 2 line needs/],
    ];
    for (const [text, re] of bad) expect(() => parseExport(text), text).toThrow(re);
  });

  it('export.store-roundtrip', async () => {
    const { planet, levels } = sample();
    const nodes = [
      ...new Map(
        levels.map((m) => [JSON.stringify(nodeOf(addressOf(m))), nodeOf(addressOf(m))]),
      ).values(),
    ];
    const g = nodeGrant({
      principal: TG.principal,
      read: [...TG.readNodes, ...nodes.map((node) => ({ node, projectIds: 'all' as const }))],
    });
    const a = createMemoryStore();
    await a.upsertMany(TG, planet);
    await a.upsertMany(g, levels);
    const exported = await a.list(g, { validOnly: false });
    const b = createMemoryStore();
    await b.upsertMany(g, parseExport(formatExport(exported, 2, AT)).memories);
    expect(await b.list(g, { validOnly: false })).toEqual(exported);
  });
});
