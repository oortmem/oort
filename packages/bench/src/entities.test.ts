import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  localGrant,
  localScope,
  observe,
  resolveConfig,
  type MemoryWriter,
  type Observation,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { entityTextOf, writerEntities } from './entities.js';
import { loadLongMemEval } from './longmemeval.js';
import { publicMain, type PublicArgs } from './public-main.js';
import { observedOf, runPublicSet } from './public-sets.js';
import { fakeEmbedder } from './fake-embed.js';
import { EMBEDDING_DIMENSION } from './generate.js';
import { ALL_SCOPE } from './seed.js';
import { verbatimDecider, verbatimWriter, type EntitySource } from './verbatim.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-entities-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SAMPLE_LME = fileURLToPath(
  new URL('../eval/public/longmemeval-sample.json', import.meta.url),
);

const obs = (userText: string, assistantText = ''): Observation => ({
  userText,
  assistantText,
  toolSummaries: [],
  sessionId: 's',
  turnRef: 's#0',
  at: '2024-01-01T00:00:00.000Z',
});

/** A writer that names the capitalised words of the user's text, and counts its calls. */
function fakeWriter(): MemoryWriter & { calls: string[]; actions: string[] } {
  const calls: string[] = [];
  const actions: string[] = [];
  return {
    calls,
    actions,
    async write(o, action) {
      calls.push(entityTextOf(o));
      actions.push(action);
      if (o.userText.includes('FAIL')) throw new Error('model said no');
      return {
        text: `rewritten: ${o.userText}`,
        stub: 'rewritten',
        entities: o.userText.match(/\b[A-Z][a-z]+\b/g) ?? [],
        type: 'semantic',
      };
    },
  };
}

describe('verbatim writer entity switch', () => {
  it('entities.off-by-default-so-earlier-runs-stay-comparable', async () => {
    const w = await verbatimWriter().write(obs('Pottery with Mia', 'nice'), 'ADD');
    expect(w).toEqual({
      text: 'Pottery with Mia\nnice',
      stub: 'Pottery with Mia',
      entities: [],
      type: 'episodic',
    });
  });

  it('entities.on-keeps-the-turns-words-and-takes-the-entities', async () => {
    const src = writerEntities(fakeWriter(), { model: 'm' });
    const w = await verbatimWriter({ entities: src.source }).write(obs('Pottery with Mia'), 'ADD');
    // The writer's rewrite is not used: the memory is still the turn, so evidence maps by turnRef.
    expect(w).toMatchObject({ text: 'Pottery with Mia', type: 'episodic' });
    expect(w.entities).toEqual(['Pottery', 'Mia']);
  });
});

/** The memories `about` links reach from the first of two turns in different sessions. */
async function aboutNeighbours(entities?: EntitySource): Promise<number> {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const store = await openSqliteStore({
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    log: () => {},
  });
  try {
    const config = resolveConfig(dir, { OORT_HOME: dir }, { projectConfig: false });
    const ids: string[] = [];
    for (const [i, text] of ['Booked Kestrel for Friday', 'Kestrel moved to Monday'].entries()) {
      const r = await observe(
        { ...obs(text), sessionId: `s${i}`, turnRef: `s${i}#0` },
        localScope(),
        {
          store,
          embed: fakeEmbedder(EMBEDDING_DIMENSION),
          decide: verbatimDecider(),
          write: verbatimWriter(entities === undefined ? {} : { entities }),
          config,
          now: new Date(`2024-01-0${i + 1}T00:00:00.000Z`),
          harness: 'bench-test',
        },
      );
      ids.push(r.memoryId as string);
    }
    const found = await store.neighbours?.(localGrant(ALL_SCOPE), [ids[0] as string], {
      kinds: ['about'],
    });
    return (found?.neighbours ?? []).filter((n) => n.id === ids[1]).length;
  } finally {
    await store.close();
  }
}

describe('writer entities', () => {
  it('entities.make-about-links-form-between-sessions', async () => {
    // Off (the default): no memory names an entity, so turns of different sessions never relate.
    expect(await aboutNeighbours()).toBe(0);
    // On: both turns name Kestrel, so the second is an `about` neighbour of the first.
    const src = writerEntities(fakeWriter(), { model: 'm' });
    expect(await aboutNeighbours(src.source)).toBe(1);
  });

  it('entities.asks-the-writer-to-add-and-caches-by-model-and-text', async () => {
    const file = path.join(root, 'ent.sqlite');
    const writer = fakeWriter();
    const a = writerEntities(writer, { model: 'm', file });
    expect(await a.source(obs('Hello Kim'))).toEqual(['Hello', 'Kim']);
    expect(await a.source(obs('Hello Kim'))).toEqual(['Hello', 'Kim']);
    expect(writer.calls).toEqual(['Hello Kim\n']);
    expect(writer.actions).toEqual(['ADD']);
    expect(a.usage()).toEqual({ calls: 1, failed: 0, hits: 1 });
    a.close();
    // Kept in the file: a later run calls nothing for it; another model does not share it.
    const b = writerEntities(writer, { model: 'm', file });
    expect(b.has('Hello Kim\n')).toBe(true);
    expect(await b.source(obs('Hello Kim'))).toEqual(['Hello', 'Kim']);
    expect(writer.calls).toHaveLength(1);
    b.close();
    const other = writerEntities(writer, { model: 'n', file });
    expect(other.has('Hello Kim\n')).toBe(false);
    other.close();
  });

  it('entities.prefetch-asks-once-per-distinct-text', async () => {
    const writer = fakeWriter();
    const src = writerEntities(writer, { model: 'm', concurrency: 3 });
    await src.prefetch([obs('A Bc'), obs('A Bc'), obs('Dd'), obs('Ee'), obs('Ff'), obs('Gg')]);
    expect(writer.calls.sort()).toEqual(['A Bc\n', 'Dd\n', 'Ee\n', 'Ff\n', 'Gg\n']);
    await src.source(obs('Dd'));
    expect(src.usage()).toEqual({ calls: 5, failed: 0, hits: 1 });
  });

  it('entities.a-failed-call-stores-no-entities-but-many-stop-the-run', async () => {
    const src = writerEntities(fakeWriter(), { model: 'm', maxFailures: () => 1 });
    expect(await src.source(obs('FAIL One'))).toEqual([]);
    // A failure is not cached: the next ask tries again.
    expect(src.has('FAIL One\n')).toBe(false);
    await expect(src.source(obs('FAIL Two'))).rejects.toThrow(
      /2 of 2 writer calls failed, stopping. Last error: model said no/,
    );
  });

  it('entities.a-public-run-asks-for-every-observed-turn', async () => {
    const set = loadLongMemEval(JSON.parse(fs.readFileSync(SAMPLE_LME, 'utf8')) as unknown);
    const writer = fakeWriter();
    const src = writerEntities(writer, { model: 'm' });
    const r = await runPublicSet({ set, entities: src, links: 'about' });
    // Every distinct observed turn text was asked for once, up front; observe then hit the cache.
    const texts = new Set(
      set.haystacks.flatMap((h) => h.turns.flatMap((t) => observedOf(t) ?? []).map(entityTextOf)),
    );
    expect(new Set(writer.calls)).toEqual(texts);
    expect(writer.calls).toHaveLength(texts.size);
    expect(src.usage()).toMatchObject({ calls: texts.size, hits: r.turns });
  });

  it('entities.writer-is-a-paid-model-and-plans-before-sending', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'not-a-key');
    const net = vi.fn(() => {
      throw new Error('the network was called');
    });
    vi.stubGlobal('fetch', net);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    const args: PublicArgs = {
      set: 'longmemeval',
      file: SAMPLE_LME,
      unpinned: true,
      fetch: false,
      plan: false,
      yes: false,
      embed: 'none',
      rerank: 'none',
      entities: 'writer:some-model',
      links: 'off',
      noGate: false,
      k: '5,10',
      json: false,
      cacheDir: root,
    };
    expect(await publicMain(args, () => {})).toBe(2);
    expect(out.join('')).toMatch(
      /Nothing was sent[\s\S]*Entities \(writer some-model\): 7 distinct turn texts, 0 already cached; 7 writer calls/,
    );
    expect(net).not.toHaveBeenCalled();
    await expect(publicMain({ ...args, entities: 'spacy' }, () => {})).rejects.toThrow(
      /unknown --entities "spacy"/,
    );
  });
});
