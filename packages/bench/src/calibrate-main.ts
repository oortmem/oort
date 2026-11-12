/**
 * Opt-in calibration of the relevance gate's provisional thresholds with real Voyage scores.
 * Never run by tests. Needs VOYAGE_API_KEY in the environment; it sends the eval questions and
 * candidate memory texts to Voyage (a few cents at most for the demo fixture).
 *
 *   VOYAGE_API_KEY=... pnpm --filter @oortmem/bench run calibrate
 *   VOYAGE_API_KEY=... pnpm --filter @oortmem/bench run calibrate -- --store ~/.oort/oort.sqlite --eval my-eval.jsonl
 *
 * The demo store holds fake embeddings, so the demo run calibrates `recall.minRerankScore` only.
 * A real store with a labelled eval file also calibrates `recall.minDenseScore`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { recall, resolveConfig } from '@oortmem/core';
import { voyageEmbedder } from '@oortmem/embed-voyage';
import { voyageReranker } from '@oortmem/rerank-voyage';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { sampleFor, suggestThreshold, type CalibrationSample } from './calibrate.js';
import { discoverScope, loadEvalRows } from './eval.js';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { ALL_SCOPE, seedStore } from './seed.js';

async function main(): Promise<number> {
  const apiKey = process.env['VOYAGE_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write('calibrate: set VOYAGE_API_KEY (this script calls Voyage).\n');
    return 2;
  }
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { store: { type: 'string' }, eval: { type: 'string' } },
  });
  const real = values.store !== undefined;
  if (real && values.eval === undefined) throw new Error('--store needs --eval <file.jsonl>');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-calibrate-'));
  try {
    let dbPath: string;
    if (real) {
      // Work on a copy: recall writes access records and hydrates cold memories.
      dbPath = path.join(tmp, 'oort.sqlite');
      fs.copyFileSync(values.store as string, dbPath);
    } else {
      dbPath = path.join(tmp, 'oort.sqlite');
      const seeded = await openSqliteStore({
        path: dbPath,
        coldDir: path.join(tmp, 'cold'),
        dimension: EMBEDDING_DIMENSION,
        log: () => {},
      });
      await seedStore(seeded, generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
      await seeded.close();
    }
    const store = await openSqliteStore({
      path: dbPath,
      coldDir: path.join(real ? path.dirname(values.store as string) : tmp, 'cold'),
      dimension: EMBEDDING_DIMENSION,
      log: () => {},
    });
    const base = resolveConfig(tmp, { OORT_HOME: tmp }, { projectConfig: false });
    const config = {
      ...base,
      recall: {
        ...base.recall,
        minRerankScore: 0,
        minCoverage: 0,
        minDenseScore: 0,
        skipRerankWhenConfident: false,
      },
    };
    const rowsFile =
      values.eval ?? fileURLToPath(new URL('../eval/fixture.jsonl', import.meta.url));
    // Multi-hop rows (CON-146) answer with memories the question's words never reach, and their
    // memories are not in the generated store: the gate is calibrated on the other rows.
    const rows = loadEvalRows(fs.readFileSync(rowsFile, 'utf8')).rows.filter(
      (r) => r.category !== 'multi-hop',
    );
    const rerank = voyageReranker({ apiKey, model: config.rerank.model });
    const embed = real
      ? voyageEmbedder({ apiKey, model: config.embed.model, dimension: config.embed.dimension })
      : undefined;
    const scope = real ? discoverScope(dbPath) : ALL_SCOPE;
    const rerankSamples: CalibrationSample[] = [];
    const denseSamples: CalibrationSample[] = [];
    for (const row of rows) {
      const r = await recall(
        { text: row.question, scope, ...(row.asOf !== undefined && { asOf: row.asOf }) },
        {
          store: { ...store, recordAccess: async () => {} },
          config,
          rerank,
          ...(embed !== undefined && { embed }),
          ...(real ? {} : { now: GENERATOR_NOW }),
        },
      );
      rerankSamples.push(
        sampleFor(
          row,
          r.memories.map((m) => ({ id: m.id, score: m.explanation.reranked })),
        ),
      );
      denseSamples.push(
        sampleFor(
          row,
          r.memories.map((m) => ({ id: m.id, score: m.explanation.dense })),
        ),
      );
    }
    await store.close();
    const show = (name: string, s: CalibrationSample[]): void => {
      const c = suggestThreshold(s);
      process.stdout.write(
        `${name}: suggested ${c.suggested} (keeps ${(c.keptAtSuggested * 100).toFixed(0)}% of ` +
          `${c.positives} answerable rows, ${(c.falsePositiveAtSuggested * 100).toFixed(0)}% of ` +
          `${c.negatives} abstention rows still answered; lowest answerable ` +
          `${c.lowestAnswerable?.toFixed(3) ?? 'n/a'}, highest abstention ${c.highestAbstention?.toFixed(3) ?? 'n/a'})\n`,
      );
    };
    show('recall.minRerankScore', rerankSamples);
    if (real) show('recall.minDenseScore', denseSamples);
    process.stdout.write(
      'Set these in ~/.oort/config.json under "recall", and record the run on CON-45.\n',
    );
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`calibrate: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
