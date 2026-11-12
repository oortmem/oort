/**
 * Forgetting a memory also takes its value out of the memories written from it (CON-144). The
 * writer records changes ("changed from 3000 to 8080"), so a successor can restate the value
 * that was forgotten. `forgetMemory` rewrites each such memory with the writer, while it still
 * has the forgotten text in hand, and re-links the chain over the gap.
 */
import { describe, expect, it } from 'vitest';
import type { Embedder, MemoryStore, MemoryWriter } from './adapters.js';
import { forgetMemory } from './forget.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory } from './model.js';
import { makeMemory, TG, vec } from './store-conformance.js';

const at = (day: number): string => new Date(Date.UTC(2026, 10, day)).toISOString();

/** Every string a record carries that a person or an export could read. */
function readable(m: Memory): string {
  return JSON.stringify({ text: m.text, stub: m.stub, entities: m.entities, src: m.source });
}

/** A writer that drops the "from <old>" part, as the model is asked to. */
function rewriter(calls: { memory: string; forgotten: string }[] = []): MemoryWriter {
  return {
    write: () => Promise.reject(new Error('not used')),
    async rewriteWithout(memory, forgotten) {
      calls.push({ memory: memory.id, forgotten: forgotten.id });
      const strip = (s: string) => s.replace(/ changed from 3000 to /, ' is ').replace('3000', '');
      return {
        text: strip(memory.text),
        stub: strip(memory.stub),
        entities: memory.entities.filter((e) => e !== '3000'),
        type: memory.type,
      };
    },
  };
}

const embed: Embedder = {
  dimension: 4,
  embed: async (texts) => texts.map(() => vec(0, 0, 9, 9)),
};

/** P (port 2000) superseded by A (port 3000), superseded by B, which restates A's value. */
async function chain(): Promise<{ store: MemoryStore; p: Memory; a: Memory; b: Memory }> {
  const store = createMemoryStore();
  const p = makeMemory({
    id: 'p',
    text: 'The dev server runs on port 2000.',
    createdAt: at(1),
    updatedAt: at(2),
    validFrom: at(1),
    validTo: at(2),
    expiredAt: at(2),
    endReason: 'superseded',
    supersededBy: 'a',
    embedding: vec(1, 0, 0, 0),
  });
  const a = makeMemory({
    id: 'a',
    text: 'The dev server runs on port 3000.',
    stub: 'dev server port 3000',
    entities: ['dev server', '3000'],
    createdAt: at(2),
    updatedAt: at(3),
    validFrom: at(2),
    validTo: at(3),
    expiredAt: at(3),
    endReason: 'superseded',
    supersedes: 'p',
    supersededBy: 'b',
    embedding: vec(0, 1, 0, 0),
  });
  const b = makeMemory({
    id: 'b',
    text: 'The dev server port changed from 3000 to 8080.',
    stub: 'dev server port changed from 3000 to 8080',
    entities: ['dev server', '3000', '8080'],
    createdAt: at(3),
    updatedAt: at(4),
    validFrom: at(3),
    supersedes: 'a',
    embedding: vec(0, 0, 1, 0),
    source: {
      harness: 'test',
      decisions: [
        // A refine keeps the earlier wording: it restates the value too.
        {
          stage: 'refine',
          question: 'previous-text',
          answer: 'Port went from 3000 to 8080.',
          probability: 0.9,
        },
        { stage: 'write', question: 'action', answer: 'SUPERSEDE', probability: 0.9 },
      ],
    },
  });
  await store.upsertMany(TG, [p, a, b]);
  return { store, p, a, b };
}

describe('forgetMemory (CON-144)', () => {
  it('forget.rewrites-the-successor-without-the-forgotten-value', async () => {
    const { store } = await chain();
    const calls: { memory: string; forgotten: string }[] = [];
    const r = await forgetMemory(
      { store, write: rewriter(calls), embed, now: new Date(at(5)) },
      TG,
      'a',
    );
    expect(r).toEqual({
      forgotten: 'a',
      rewritten: [{ id: 'b', text: 'The dev server port is 8080.' }],
      notRewritten: [],
    });
    // Only memories written after it are asked about; P came before A.
    expect(calls).toEqual([{ memory: 'b', forgotten: 'a' }]);
    expect(await store.get(TG, 'a')).toBeNull();
    const live = await store.list(TG, { validOnly: false });
    expect(live.map((m) => m.id).sort()).toEqual(['b', 'p']);
    for (const m of live) expect(readable(m)).not.toContain('3000');
    const b = await store.get(TG, 'b');
    expect(b).toMatchObject({ text: 'The dev server port is 8080.', updatedAt: at(5) });
    // A new vector for the new text: the old one was computed from the forgotten value.
    expect(Array.from(b?.embedding ?? [])).toEqual([0, 0, 9, 9]);
    expect(b?.source.decisions).toContainEqual({
      stage: 'forget',
      question: 'rewritten',
      answer: 'without a forgotten memory',
      probability: 1,
    });
    // Recall finds nothing by the forgotten value.
    expect(await store.lexical(TG, '3000', 10)).toEqual([]);
  });

  it('forget.relinks-the-chain-over-the-gap', async () => {
    const { store } = await chain();
    await forgetMemory({ store, write: rewriter(), embed, now: new Date(at(5)) }, TG, 'a');
    expect((await store.get(TG, 'b'))?.supersedes).toBe('p');
    expect((await store.get(TG, 'p'))?.supersededBy).toBe('b');
  });

  it('forget.without-a-writer-names-the-successors-it-could-not-rewrite', async () => {
    const { store, b } = await chain();
    const r = await forgetMemory({ store, embed }, TG, 'a');
    expect(r).toEqual({
      forgotten: 'a',
      rewritten: [],
      notRewritten: [{ id: 'b', reason: 'no-writer' }],
    });
    expect(await store.get(TG, 'a')).toBeNull();
    // Kept as it was, re-linked only.
    expect(await store.get(TG, 'b')).toMatchObject({ text: b.text, supersedes: 'p' });
  });

  it('forget.a-failed-rewrite-still-forgets-and-says-so', async () => {
    const { store } = await chain();
    const write: MemoryWriter = {
      write: () => Promise.reject(new Error('not used')),
      rewriteWithout: () => Promise.reject(new Error('relay refused')),
    };
    const r = await forgetMemory({ store, write, embed }, TG, 'a');
    expect(r.notRewritten).toEqual([{ id: 'b', reason: 'failed' }]);
    expect(await store.get(TG, 'a')).toBeNull();
  });

  it('forget.leaves-a-successor-that-does-not-restate-it-alone', async () => {
    const { store, b } = await chain();
    const same: MemoryWriter = {
      write: () => Promise.reject(new Error('not used')),
      rewriteWithout: async (m) => ({
        text: m.text,
        stub: m.stub,
        entities: m.entities,
        type: m.type,
      }),
    };
    const r = await forgetMemory({ store, write: same, embed }, TG, 'a');
    expect(r).toEqual({ forgotten: 'a', rewritten: [], notRewritten: [] });
    const kept = await store.get(TG, 'b');
    expect(kept).toMatchObject({ text: b.text, supersedes: 'p' });
    expect(Array.from(kept?.embedding ?? [])).toEqual([0, 0, 1, 0]);
  });

  it('forget.without-an-embedder-drops-the-old-vector', async () => {
    const { store } = await chain();
    const r = await forgetMemory({ store, write: rewriter() }, TG, 'a');
    expect(r.rewritten.map((x) => x.id)).toEqual(['b']);
    expect((await store.get(TG, 'b'))?.embedding).toBeUndefined();
  });

  it('forget.rewrites-a-cold-successor-from-its-cold-copy', async () => {
    const { store, b } = await chain();
    await store.coldPut(TG, b);
    expect((await store.get(TG, 'b'))?.tier).toBe('cold');
    const r = await forgetMemory({ store, write: rewriter(), embed }, TG, 'a');
    expect(r.rewritten.map((x) => x.id)).toEqual(['b']);
    const after = await store.get(TG, 'b');
    expect(after?.tier).toBe('warm');
    expect(await store.coldGet(TG, 'b')).toBeNull();
    expect(readable(after as Memory)).not.toContain('3000');
  });

  it('forget.an-unknown-id-forgets-nothing', async () => {
    const { store } = await chain();
    expect(await forgetMemory({ store }, TG, 'nope')).toEqual({
      forgotten: null,
      rewritten: [],
      notRewritten: [],
    });
    expect((await store.list(TG, { validOnly: false })).length).toBe(3);
  });

  it('forget.the-newest-memory-leaves-its-predecessor-pointing-nowhere-missing', async () => {
    const { store } = await chain();
    const r = await forgetMemory({ store, write: rewriter(), embed }, TG, 'b');
    expect(r).toEqual({ forgotten: 'b', rewritten: [], notRewritten: [] });
    expect((await store.get(TG, 'a'))?.supersededBy).toBeNull();
  });
});
