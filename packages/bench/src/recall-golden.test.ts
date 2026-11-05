/**
 * Recall golden over the bench fixture: ids, order, every explanation score and
 * the injected text, for each fixture question, on the in-memory store and on
 * SQLite. The golden (`recall-golden.json`) was recorded by the engine before
 * memories had levels (0.2.1), so this test proves the level model changed
 * nothing a caller can see. The SQLite run also goes through the schema
 * migration: the store is seeded, taken down to the version 1 schema, and
 * opened again, which migrates it back up.
 *
 * `OORT_UPDATE_GOLDEN=1` rewrites the golden; only do that for an intended
 * change in recall, never to make this test pass after a storage change.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, expect, it } from 'vitest';
import {
  createMemoryStore,
  formatForInjection,
  recall,
  resolveConfig,
  type Memory,
  type MemoryStore,
  type RecallResult,
} from '@oortmem/core';
import { downgradeSqliteStore, openSqliteStore } from '@oortmem/store-sqlite';
import { fakeEmbedder } from './fake-embed.js';
import { buildFixtureRows, FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { ALL_GRANT, ALL_SCOPE, seedStore } from './seed.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recall-golden.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-recall-golden-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

interface GoldenRow {
  question: string;
  ids: string[];
  explanations: RecallResult['memories'][number]['explanation'][];
  abstained: boolean;
  gate: RecallResult['gate'] | null;
  embedSkipped: string | null;
  degraded: string[];
  temporal: RecallResult['temporal'] | null;
  injected: string;
}

type Golden = Record<'memory' | 'sqlite', GoldenRow[]>;

/** Every seventh unpinned memory goes cold, so recall hydrates some of them. */
async function demote(store: MemoryStore, memories: Memory[]): Promise<void> {
  const cold = memories.filter((m, i) => i % 7 === 0 && !m.pinned);
  const { skipped } = await store.coldPutMany(ALL_GRANT, cold);
  expect(skipped).toEqual([]);
}

async function run(store: MemoryStore, memories: Memory[]): Promise<GoldenRow[]> {
  const rows = buildFixtureRows(memories);
  const config = resolveConfig(root, { OORT_HOME: root }, { projectConfig: false });
  const embed = fakeEmbedder(EMBEDDING_DIMENSION);
  const out: GoldenRow[] = [];
  // In order, against one store: each recall's access record and hydration are part of the state
  // the next one reads, so the golden covers those writes too.
  for (const row of rows) {
    const r = await recall(
      { text: row.question, scope: ALL_SCOPE, ...(row.asOf !== undefined && { asOf: row.asOf }) },
      { store, config, embed, now: GENERATOR_NOW },
    );
    out.push({
      question: row.question,
      ids: r.memories.map((m) => m.id),
      explanations: r.memories.map((m) => m.explanation),
      abstained: r.abstained === true,
      gate: r.gate ?? null,
      embedSkipped: r.embedSkipped ?? null,
      degraded: r.degraded ?? [],
      temporal: r.temporal ?? null,
      injected: createHash('sha256')
        .update(formatForInjection(r, config.recall.budgetChars, GENERATOR_NOW))
        .digest('hex'),
    });
  }
  return out;
}

async function memoryRun(): Promise<GoldenRow[]> {
  const memories = generateMemories(FIXTURE_COUNT, FIXTURE_SEED);
  const store = createMemoryStore({ now: () => GENERATOR_NOW });
  try {
    await seedStore(store, memories);
    await demote(store, memories);
    return await run(store, memories);
  } finally {
    await store.close();
  }
}

async function sqliteRun(): Promise<GoldenRow[]> {
  const memories = generateMemories(FIXTURE_COUNT, FIXTURE_SEED);
  const dir = fs.mkdtempSync(path.join(root, 'sqlite-'));
  const opts = {
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    now: () => GENERATOR_NOW,
    log: () => {},
  };
  const seeded = await openSqliteStore(opts);
  try {
    await seedStore(seeded, memories);
    await demote(seeded, memories);
  } finally {
    await seeded.close();
  }
  await beforeReopen(opts.path);
  const store = await openSqliteStore(opts);
  expect(fs.existsSync(`${opts.path}.pre-v2`), 'the migration copies the store first').toBe(true);
  try {
    return await run(store, memories);
  } finally {
    await store.close();
  }
}

/** Takes the seeded store down to schema version 1, so the reopen migrates it back up. */
async function beforeReopen(dbPath: string): Promise<void> {
  downgradeSqliteStore({ path: dbPath });
  const db = new Database(dbPath, { readonly: true });
  try {
    const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(v.value).toBe('1');
  } finally {
    db.close();
  }
}

it('recall-golden.bench-fixture-unchanged', { timeout: 300_000 }, async () => {
  const got: Golden = { memory: await memoryRun(), sqlite: await sqliteRun() };
  if (process.env['OORT_UPDATE_GOLDEN'] === '1') {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden;
  // A sanity floor, so an empty golden cannot pass by accident.
  expect(want.sqlite.filter((r) => r.ids.length > 0).length).toBeGreaterThan(15);
  expect(got.memory).toEqual(want.memory);
  expect(got.sqlite).toEqual(want.sqlite);
});
