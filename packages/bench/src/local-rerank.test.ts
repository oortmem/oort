/**
 * The local reranker's calibration (CON-96) on the demo eval, without the model: MiniLM's raw
 * logits for every pair it scores there were recorded once (`eval/minilm-logits.json`, see
 * `calibrate-local-main.ts`) and are replayed through the catalog's calibration and recall's
 * relevance gate. Candidates come from lexical search and the bench's fake embedder, so the
 * whole run is deterministic. A change in recall's candidates fails loudly (no recorded logit)
 * instead of skipping pairs; re-record then.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RERANK_MODEL, findModel, type RerankModelSpec } from '@oortmem/local-models';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { loadEvalRows, runEval, type EvalReport, type EvalRow } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { calibratedReranker, REPLAY_RECALL, type LogitTable } from './local-rerank.js';
import { ALL_SCOPE, seedStore } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  fs.readFileSync(path.join(here, '../eval/minilm-logits.json'), 'utf8'),
) as { model: string; sha256: string; logits: LogitTable };
// The replay was recorded before the multi-hop rows existed (CON-146); it covers the others.
const rows: EvalRow[] = loadEvalRows(
  fs.readFileSync(path.join(here, '../eval/fixture.jsonl'), 'utf8'),
).rows.filter((r) => r.category !== 'multi-hop');

/**
 * The fitted calibration's result on this replay, recorded on 2026-11-06 (docs/cli.md, "Reranker
 * scores"): 17 of 19 answerable rows found in the top 3, MRR@10 0.868, no stale leak, and 1 of 4
 * abstention rows answered (Voyage answered none when its gate was calibrated).
 */
const FLOOR = { recallAt3: 17 / 19, recallAt10: 17 / 19, mrr: 0.868, abstainFp: 0.25 };

let dir: string;
let dbPath: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-local-rerank-'));
  dbPath = path.join(dir, 'oort.sqlite');
  const store = await openSqliteStore({
    path: dbPath,
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    log: () => {},
  });
  await seedStore(store, generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
  await store.close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function replay(calibration: { scale: number; shift: number }): Promise<EvalReport> {
  return runEval({
    rows,
    storePath: dbPath,
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    ks: [3, 5, 10],
    now: GENERATOR_NOW,
    scope: ALL_SCOPE,
    embed: fakeEmbedder(EMBEDDING_DIMENSION),
    rerank: calibratedReranker(recorded.logits, calibration),
    recall: REPLAY_RECALL,
    warn: () => {},
  });
}

describe('local reranker calibration on the demo eval', () => {
  const spec = findModel(DEFAULT_RERANK_MODEL) as RerankModelSpec;

  it('local-rerank.logits-were-recorded-with-the-catalog-model', () => {
    expect(recorded.model).toBe(spec.id);
    expect(recorded.sha256).toBe(spec.files.find((f) => f.name === 'model.onnx')?.sha256);
  });

  it('local-rerank.eval-quality-stays-at-or-above-the-recorded-run', async () => {
    const overall = (await replay(spec.calibration)).groups['overall'];
    expect(overall).toBeDefined();
    expect(overall!.recallAt[3]).toBeGreaterThanOrEqual(FLOOR.recallAt3 - 1e-9);
    expect(overall!.recallAt[10]).toBeGreaterThanOrEqual(FLOOR.recallAt10 - 1e-9);
    expect(overall!.mrr).toBeGreaterThanOrEqual(FLOOR.mrr);
    expect(overall!.staleLeak).toBe(0);
    expect(overall!.abstainFp).toBeLessThanOrEqual(FLOOR.abstainFp);
  });

  it('local-rerank.guessed-scaling-let-every-abstention-row-through', async () => {
    // The scaling the fit replaced put the 0.35 gate at logit -6, below almost any candidate.
    const guessed = (await replay({ scale: 0.5, shift: 2.4 })).groups['overall'];
    const fitted = (await replay(spec.calibration)).groups['overall'];
    expect(guessed!.abstainFp).toBe(1);
    expect(fitted!.abstainFp).toBeLessThan(guessed!.abstainFp!);
    // The gate moved, the ranking did not: an increasing map keeps MiniLM's order.
    expect(fitted!.recallAt[10]).toBe(guessed!.recallAt[10]);
    expect(fitted!.mrr).toBe(guessed!.mrr);
  });
});
