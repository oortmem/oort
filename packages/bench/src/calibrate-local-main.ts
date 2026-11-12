/**
 * Calibrates the local MiniLM reranker's score scaling on the demo eval against Voyage's
 * recorded scores (CON-96). Never run by tests, and makes no network call: it needs the default
 * local models already pulled (`oort models pull`) under `--home` (default `$OORT_HOME`).
 *
 *   pnpm --filter @oortmem/bench run calibrate:local -- --home ~/.oort
 *   pnpm --filter @oortmem/bench run calibrate:local -- --home ~/.oort --record packages/bench/eval/minilm-logits.json
 *
 * 1. Seeds the demo store with bge-small vectors and recalls each eval row the way `calibrate`
 *    did for Voyage: relevance gate off, rerank never skipped. MiniLM's raw logit for every
 *    candidate it sees is kept.
 * 2. Finds the logits' margin on the eval (`separatingMargin`) and fits
 *    `sigmoid(scale * logit + shift)` so that margin lands on Voyage's (`fitLogitCalibration`).
 * 3. Runs the eval (gate on) for lexical-only, the local embedder alone, the local embedder with
 *    MiniLM under the catalog's calibration and under the fitted one, and the same two with the
 *    bench's fake embedder, whose logits `--record` writes for `local-rerank.test.ts` to replay.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  recall,
  resolveConfig,
  resolveHome,
  type Embedder,
  type Memory,
  type Reranker,
} from '@oortmem/core';
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  findModel,
  localEmbedder,
  localReranker,
  rerankScore,
  type RerankModelSpec,
} from '@oortmem/local-models';
import { openSqliteStore } from '@oortmem/store-sqlite';
import {
  fitLogitCalibration,
  logit,
  sampleFor,
  separatingMargin,
  VOYAGE_DEMO_MARGIN,
  type CalibrationSample,
} from './calibrate.js';
import { loadEvalRows, renderReport, runEval, type EvalReport } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { calibratedReranker, REPLAY_RECALL, type LogitTable } from './local-rerank.js';
import { ALL_SCOPE, seedStore } from './seed.js';

type Calibration = { scale: number; shift: number };

/** Raw MiniLM logits, cached per (query, memory id) so each pair runs through ONNX once. */
function minilm(home: string): {
  logits: LogitTable;
  /** A reranker ranking by raw logit (identity calibration), noting each pair it sees. */
  reranker(seen?: { query: string; id: string }[]): Reranker;
} {
  const spec = findModel(DEFAULT_RERANK_MODEL) as RerankModelSpec;
  // Identity calibration: the model then returns sigmoid(logit), which inverts exactly.
  const raw = localReranker({
    home,
    model: spec.id,
    spec: { ...spec, calibration: { scale: 1, shift: 0 } },
    threads: 1,
  });
  const logits: LogitTable = {};
  const score = async (query: string, docs: { id: string; text: string }[]): Promise<void> => {
    const row = (logits[query] ??= {});
    const todo = docs.filter((d) => row[d.id] === undefined);
    if (todo.length === 0) return;
    for (const r of await raw.rerank(query, todo, todo.length)) {
      row[r.id] = Number(logit(r.score).toFixed(4));
    }
  };
  return {
    logits,
    reranker: (seen) => ({
      async rerank(query, docs, topK) {
        await score(query, docs);
        for (const d of docs) seen?.push({ query, id: d.id });
        return calibratedReranker(logits, { scale: 1, shift: 0 }).rerank(query, docs, topK);
      },
    }),
  };
}

async function seed(dir: string, memories: Memory[]): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'oort.sqlite');
  const store = await openSqliteStore({
    path: dbPath,
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    log: () => {},
  });
  await seedStore(store, memories);
  await store.close();
  return dbPath;
}

/** The demo memories with their fake vectors replaced by `embed`'s. */
async function embedded(memories: Memory[], embed: Embedder): Promise<Memory[]> {
  const out: Memory[] = [];
  for (let i = 0; i < memories.length; i += 64) {
    const chunk = memories.slice(i, i + 64);
    const vectors = await embed.embed(
      chunk.map((m) => m.text),
      'document',
    );
    chunk.forEach((m, j) => out.push({ ...m, embedding: vectors[j] as Int8Array }));
  }
  return out;
}

const fmt = (n: number): string => n.toFixed(3);

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      home: { type: 'string' },
      eval: { type: 'string' },
      record: { type: 'string' },
    },
  });
  const home = values.home ?? resolveHome();
  const rowsFile = values.eval ?? fileURLToPath(new URL('../eval/fixture.jsonl', import.meta.url));
  // Multi-hop rows (CON-146) answer with memories the question's words never reach, and their
  // memories are not in the generated store: the gate is calibrated on the other rows.
  const rows = loadEvalRows(fs.readFileSync(rowsFile, 'utf8')).rows.filter(
    (r) => r.category !== 'multi-hop',
  );
  const out = process.stdout;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-calibrate-local-'));
  try {
    const memories = generateMemories(FIXTURE_COUNT, FIXTURE_SEED);
    const fakeDb = await seed(path.join(tmp, 'fake'), memories);
    const embed = localEmbedder({
      home,
      model: DEFAULT_EMBED_MODEL,
      dimension: EMBEDDING_DIMENSION,
    });
    const localDb = await seed(path.join(tmp, 'local'), await embedded(memories, embed));
    const ml = minilm(home);

    // 1. Samples, as `calibrate` took them for Voyage: gate off, rerank never skipped. Every
    // candidate the reranker sees counts, not only those recall returns: Voyage's top abstention
    // score was over all its candidates too. Recall may hand the reranker the question without
    // its date cue, so candidates are collected per row rather than looked up by question.
    const base = resolveConfig(tmp, { OORT_HOME: tmp }, { projectConfig: false });
    const sample = async (dbPath: string, e: Embedder): Promise<CalibrationSample[]> => {
      const store = await openSqliteStore({
        path: dbPath,
        coldDir: path.join(path.dirname(dbPath), 'cold'),
        dimension: EMBEDDING_DIMENSION,
        log: () => {},
      });
      const samples: CalibrationSample[] = [];
      try {
        for (const row of rows) {
          const seen: { query: string; id: string }[] = [];
          await recall(
            {
              text: row.question,
              scope: ALL_SCOPE,
              ...(row.asOf !== undefined && { asOf: row.asOf }),
            },
            {
              store: { ...store, recordAccess: async () => {} },
              config: {
                ...base,
                recall: {
                  ...base.recall,
                  minRerankScore: 0,
                  minCoverage: 0,
                  minDenseScore: 0,
                  skipRerankWhenConfident: false,
                  lexicalFirst: false,
                  rerankBudgetMs: 0,
                },
              },
              rerank: ml.reranker(seen),
              embed: e,
              now: GENERATOR_NOW,
            },
          );
          samples.push(
            sampleFor(
              row,
              seen.map((c) => ({ id: c.id, score: ml.logits[c.query]?.[c.id] })),
            ),
          );
        }
      } finally {
        await store.close();
      }
      return samples;
    };
    const samples = await sample(localDb, embed);
    const fakeSamples = await sample(fakeDb, fakeEmbedder(EMBEDDING_DIMENSION));

    // 2. The fit.
    const margin = separatingMargin(samples);
    if (margin === undefined) throw new Error('the eval needs answerable and abstention rows');
    const fitted = fitLogitCalibration(margin);
    const rounded = {
      scale: Number(fitted.scale.toFixed(2)),
      shift: Number(fitted.shift.toFixed(2)),
    };
    const current = (findModel(DEFAULT_RERANK_MODEL) as RerankModelSpec).calibration;
    out.write(`rows: ${rows.length} (${rowsFile})\n\nMiniLM best logit per row:\n`);
    rows.forEach((r, i) => {
      const s = samples[i] as CalibrationSample;
      const v = s.category === 'abstention' ? s.top : Math.max(...s.expected);
      const shown = v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(2);
      out.write(`  ${shown.padStart(6)}  ${s.category}  ${r.question}\n`);
    });
    const showMargin = (name: string, m: ReturnType<typeof separatingMargin>): void => {
      if (m === undefined) return;
      out.write(
        `${name}: lowest answerable ${fmt(m.lowestAnswerable)}, highest abstention ` +
          `${fmt(m.highestAbstention)}; given up: ${m.answerableBelow}/${m.answerable} answerable, ` +
          `${m.abstentionAbove}/${m.abstention} abstention\n`,
      );
    };
    out.write('\n');
    showMargin('MiniLM margin (bge-small candidates)', margin);
    showMargin('MiniLM margin (fake-embedder candidates)', separatingMargin(fakeSamples));
    out.write(
      `Voyage rerank-3-lite margin: lowest answerable ${VOYAGE_DEMO_MARGIN.lowestAnswerable}, ` +
        `highest abstention ${VOYAGE_DEMO_MARGIN.highestAbstention}\n`,
    );
    out.write(
      `fitted: scale ${fmt(fitted.scale)}, shift ${fmt(fitted.shift)} (rounded ${rounded.scale}, ` +
        `${rounded.shift}); catalog: ${current.scale}, ${current.shift}\n`,
    );
    const describe = (name: string, c: Calibration): void => {
      const gateAt = (logit(0.35) - c.shift) / c.scale;
      const pos = samples
        .filter((x) => x.category !== 'abstention' && x.expected.length > 0)
        .map((x) => rerankScore(Math.max(...x.expected), c))
        .sort((a, b) => a - b);
      const neg = samples
        .filter((x) => x.category === 'abstention' && x.top !== undefined)
        .map((x) => rerankScore(x.top as number, c))
        .sort((a, b) => a - b);
      out.write(
        `  ${name}: minRerankScore 0.35 at logit ${gateAt.toFixed(2)}; answerable best ` +
          `${fmt(pos[0] ?? NaN)} min, ${fmt(pos[Math.floor(pos.length / 2)] ?? NaN)} median ` +
          `(${pos.filter((x) => x >= 0.35).length}/${pos.length} pass); abstention top ` +
          `${neg.map(fmt).join(', ')} (${neg.filter((x) => x >= 0.35).length}/${neg.length} pass)\n`,
      );
    };
    describe('catalog', current);
    describe('fitted ', rounded);

    // 3. Eval reports, gate on, with the replay settings (rerank waits as long as it takes).
    const replay: LogitTable = {};
    const recordingFor = (c: Calibration): Reranker => {
      const seen: { query: string; id: string }[] = [];
      const scoring = ml.reranker(seen);
      return {
        async rerank(query, docs, topK) {
          await scoring.rerank(query, docs, docs.length);
          for (const { query: q, id } of seen.splice(0)) {
            (replay[q] ??= {})[id] = ml.logits[q]?.[id] as number;
          }
          return calibratedReranker(ml.logits, c).rerank(query, docs, topK);
        },
      };
    };
    const reports: [string, EvalReport][] = [];
    const run = async (
      name: string,
      dbPath: string,
      opts: { embed?: Embedder; rerank?: Reranker },
    ): Promise<void> => {
      const report = await runEval({
        rows,
        storePath: dbPath,
        coldDir: path.join(path.dirname(dbPath), 'cold'),
        dimension: EMBEDDING_DIMENSION,
        ks: [3, 5, 10],
        now: GENERATOR_NOW,
        scope: ALL_SCOPE,
        recall: REPLAY_RECALL,
        ...opts,
      });
      reports.push([name, report]);
    };
    const local = (c: Calibration): Reranker => calibratedReranker(ml.logits, c, ml.reranker());
    await run('lexical-only', fakeDb, {});
    await run('bge-small, no reranker', localDb, { embed });
    await run('bge-small + MiniLM, catalog calibration', localDb, {
      embed,
      rerank: local(current),
    });
    await run('bge-small + MiniLM, fitted calibration', localDb, {
      embed,
      rerank: local(rounded),
    });
    const fake = fakeEmbedder(EMBEDDING_DIMENSION);
    await run('fake embedder + MiniLM, catalog calibration', fakeDb, {
      embed: fake,
      rerank: recordingFor(current),
    });
    await run('fake embedder + MiniLM, fitted calibration', fakeDb, {
      embed: fake,
      rerank: recordingFor(rounded),
    });
    for (const [name, report] of reports) out.write(`\n## ${name}\n\n${renderReport(report)}\n`);

    if (values.record !== undefined) {
      const spec = findModel(DEFAULT_RERANK_MODEL) as RerankModelSpec;
      const file = path.resolve(process.env['INIT_CWD'] ?? process.cwd(), values.record);
      const sorted: LogitTable = {};
      for (const q of Object.keys(replay).sort()) {
        const row = replay[q] ?? {};
        sorted[q] = Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((id) => [id, row[id] as number]),
        );
      }
      fs.writeFileSync(
        file,
        `${JSON.stringify(
          {
            about:
              'Raw ms-marco-MiniLM-L6-v2 logits for every (query, memory) pair the reranker sees on the demo eval with the fake embedder. Written by `pnpm --filter @oortmem/bench run calibrate:local -- --record packages/bench/eval/minilm-logits.json`; replayed by src/local-rerank.test.ts.',
            model: spec.id,
            revision: spec.source.revision,
            sha256: spec.files.find((f) => f.name === 'model.onnx')?.sha256,
            logits: sorted,
          },
          null,
          2,
        )}\n`,
      );
      out.write(`\nrecorded ${Object.keys(sorted).length} queries' logits to ${file}\n`);
    }
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`calibrate-local: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
