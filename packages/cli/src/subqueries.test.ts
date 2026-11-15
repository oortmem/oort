import { describe, expect, it } from 'vitest';
import { TG } from '@oortmem/core/store-conformance';
import { data, harness, memory } from '../test/helpers.js';

/** A question about two things in `oort explain`: its parts, and each part's best. */

describe('oort explain with a question about two things', () => {
  it('subqueries.explain-shows-the-parts-and-each-part-best-match', async () => {
    const h = harness();
    await h.store.upsert(
      TG,
      memory({
        id: '11111111-1111-4111-8111-111111111111',
        text: 'Bought the standing desk for the home office.',
      }),
    );
    await h.store.upsert(
      TG,
      memory({
        id: '22222222-2222-4222-8222-222222222222',
        text: 'Bought the ergonomic chair at the furniture store.',
      }),
    );
    const q = 'Which did I buy first, the standing desk or the ergonomic chair?';
    const table = await h.run(['explain', q]);
    expect(table.code).toBe(0);
    expect(table.io.stdout).toContain('parts: 1 "buy standing desk", 2 "buy ergonomic chair"');
    expect(table.io.stdout).toMatch(/^rank .* part /m);
    const json = await h.run(['explain', q, '--json']);
    const r = data<{
      subQueries: string[];
      memories: { id: string; explanation: { part?: number } }[];
    }>(json.io.stdout);
    expect(r.subQueries).toEqual(['buy standing desk', 'buy ergonomic chair']);
    expect(
      Object.fromEntries(r.memories.map((m) => [m.id.slice(0, 1), m.explanation.part])),
    ).toEqual({ '1': 1, '2': 2 });
    // A question that does not split shows neither.
    const plain = await h.run(['explain', 'standing desk']);
    expect(plain.io.stdout).not.toContain('parts:');
    expect(plain.io.stdout).not.toMatch(/^rank .* part /m);
  });
});
