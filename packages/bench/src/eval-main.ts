import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveConfig, resolveHome, type Embedder, type Reranker } from '@oortmem/core';
import { voyageEmbedder } from '@oortmem/embed-voyage';
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  localEmbedder,
  localReranker,
} from '@oortmem/local-models';
import { voyageReranker } from '@oortmem/rerank-voyage';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { cell, loadEvalRows, renderReport, runEval } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import {
  CONDITIONS,
  LANGUAGES,
  renderMultilingual,
  runMultilingual,
  type Condition,
  type Language,
} from './multilingual.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { seedStore } from './seed.js';

const USAGE = `usage: pnpm eval <file.jsonl> [--store <path>] [--cold-dir <dir>] [--k 5,10]
                 [--min-recall10 <0..1>] [--dimension <n>] [--dense] [--now <iso>]
                 [--abstain-threshold <n>] [--no-gate] [--json]
                 [--vector-index auto|int8|binary] [--cold-share <0..1>] [--no-adaptive-stop]
       pnpm eval --demo [--json]    synthetic 1500-memory store + the bundled 23-row fixture
       pnpm eval --set multilingual [--embed none|fake|local[:model]|voyage[:model]]
                 [--rerank none|local[:model]|voyage[:model]] [--home <dir>]
                 [--lang en,ja,...] [--condition mono,cross,mixed] [--json] [--out <file>]
                 [--vector-index auto|int8|binary]

Runs recall for each row against a temp copy of the store (the live store is never written).`;

/** Relative paths resolve against where `pnpm` was invoked, not the package directory. */
const fromUser = (p: string): string => path.resolve(process.env['INIT_CWD'] ?? process.cwd(), p);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    allowPositionals: true,
    options: {
      store: { type: 'string' },
      'cold-dir': { type: 'string' },
      k: { type: 'string', default: '5,10' },
      'min-recall10': { type: 'string', default: '0' },
      dimension: { type: 'string', default: String(EMBEDDING_DIMENSION) },
      dense: { type: 'boolean', default: false },
      now: { type: 'string' },
      'abstain-threshold': { type: 'string' },
      'no-gate': { type: 'boolean', default: false },
      'vector-index': { type: 'string' },
      'cold-share': { type: 'string', default: '0' },
      'no-adaptive-stop': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      set: { type: 'string' },
      embed: { type: 'string', default: 'none' },
      rerank: { type: 'string', default: 'none' },
      home: { type: 'string' },
      lang: { type: 'string' },
      condition: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.set !== undefined) {
    if (values.set !== 'multilingual') throw new Error(`unknown --set "${values.set}"`);
    const vi = values['vector-index'];
    if (vi !== undefined && !['auto', 'int8', 'binary'].includes(vi))
      throw new Error(`--vector-index must be auto, int8 or binary, got "${vi}"`);
    return multilingual(values);
  }
  const ks = values.k.split(',').map((s) => Number(s.trim()));
  if (ks.some((k) => !Number.isInteger(k) || k <= 0))
    throw new Error(`--k must be positive integers, got "${values.k}"`);
  const vectorIndex = values['vector-index'];
  if (vectorIndex !== undefined && !['auto', 'int8', 'binary'].includes(vectorIndex))
    throw new Error(`--vector-index must be auto, int8 or binary, got "${vectorIndex}"`);
  const coldShare = Number(values['cold-share']);
  if (!(coldShare >= 0 && coldShare <= 1)) throw new Error('--cold-share must be between 0 and 1');
  const minRecall10 = Number(values['min-recall10']);
  if (!(minRecall10 >= 0 && minRecall10 <= 1))
    throw new Error('--min-recall10 must be between 0 and 1');

  let tmp: string | undefined;
  try {
    let storePath: string;
    let coldDir: string;
    let rowsFile: string;
    let now = values.now !== undefined ? new Date(values.now) : undefined;
    let dense = values.dense;
    let dimension = Number(values.dimension);
    if (values.demo) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-eval-demo-'));
      storePath = path.join(tmp, 'oort.sqlite');
      coldDir = path.join(tmp, 'cold');
      const store = await openSqliteStore({
        path: storePath,
        coldDir,
        dimension: EMBEDDING_DIMENSION,
        log: () => {},
      });
      await seedStore(store, generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
      await store.close();
      rowsFile = fileURLToPath(new URL('../eval/fixture.jsonl', import.meta.url));
      now ??= GENERATOR_NOW;
      dimension = EMBEDDING_DIMENSION;
    } else {
      const file = positionals[0];
      if (file === undefined) throw new Error(`missing eval file\n${USAGE}`);
      rowsFile = fromUser(file);
      storePath =
        values.store !== undefined
          ? fromUser(values.store)
          : path.join(resolveHome(), 'oort.sqlite');
      coldDir =
        values['cold-dir'] !== undefined
          ? fromUser(values['cold-dir'])
          : path.join(path.dirname(storePath), 'cold');
    }
    if (now !== undefined && Number.isNaN(now.getTime()))
      throw new Error('--now must be an ISO timestamp');
    const loaded = loadEvalRows(fs.readFileSync(rowsFile, 'utf8'));
    const report = await runEval({
      rows: loaded.rows,
      skippedEmpty: loaded.skippedEmpty,
      storePath,
      coldDir,
      dimension,
      ks,
      ...(now !== undefined ? { now } : {}),
      ...(dense ? { embed: fakeEmbedder(dimension) } : {}),
      ...(values['no-gate'] && { gate: false }),
      ...(vectorIndex !== undefined && { vectorIndex: vectorIndex as 'auto' | 'int8' | 'binary' }),
      ...(coldShare > 0 && { coldShare }),
      ...(values['no-adaptive-stop'] && { recall: { adaptiveStop: 'off' as const } }),
      ...(values['abstain-threshold'] !== undefined
        ? { abstainThreshold: Number(values['abstain-threshold']) }
        : {}),
    });
    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`,
    );
    const r10 = report.groups['overall']?.recallAt[10];
    if (minRecall10 > 0 && (r10 === null || r10 === undefined || r10 < minRecall10)) {
      process.stderr.write(`eval: recall@10 ${cell(r10)} is below --min-recall10 ${minRecall10}\n`);
      return 1;
    }
    return 0;
  } finally {
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A comma list, each item checked against `allowed`. */
function list<T extends string>(raw: string | undefined, allowed: readonly T[], what: string): T[] {
  if (raw === undefined) return [...allowed];
  const items = raw.split(',').map((s) => s.trim());
  const bad = items.filter((s) => !(allowed as readonly string[]).includes(s));
  if (bad.length > 0) throw new Error(`unknown ${what}: ${bad.join(', ')}`);
  return items as T[];
}

/**
 * `--set multilingual` (CON-110): the multilingual eval in `eval/multilingual/`. `--embed` and
 * `--rerank` pick the models: `local` reads already-pulled models from `--home` (default
 * `$OORT_HOME`) and never downloads; `voyage` needs `VOYAGE_API_KEY` and is run by hand.
 */
async function multilingual(values: {
  'vector-index'?: string | undefined;
  embed: string;
  rerank: string;
  home?: string | undefined;
  lang?: string | undefined;
  condition?: string | undefined;
  json: boolean;
  out?: string | undefined;
}): Promise<number> {
  const home = values.home !== undefined ? fromUser(values.home) : resolveHome();
  const defaults = resolveConfig(home, { OORT_HOME: home }, { projectConfig: false });
  const [embedKind, embedModel] = values.embed.split(/:(.*)/s) as [string, string | undefined];
  const [rerankKind, rerankModel] = values.rerank.split(/:(.*)/s) as [string, string | undefined];
  let embed: Embedder | undefined;
  if (embedKind === 'fake') embed = fakeEmbedder(EMBEDDING_DIMENSION);
  else if (embedKind === 'local') {
    embed = localEmbedder({
      home,
      model: embedModel ?? DEFAULT_EMBED_MODEL,
      dimension: EMBEDDING_DIMENSION,
    });
  } else if (embedKind === 'voyage') {
    embed = voyageEmbedder({
      model: embedModel ?? defaults.embed.model,
      dimension: EMBEDDING_DIMENSION,
    });
  } else if (embedKind !== 'none') throw new Error(`unknown --embed "${values.embed}"`);
  let rerank: Reranker | undefined;
  if (rerankKind === 'local') {
    rerank = localReranker({ home, model: rerankModel ?? DEFAULT_RERANK_MODEL });
  } else if (rerankKind === 'voyage') {
    rerank = voyageReranker({ model: rerankModel ?? defaults.rerank.model });
  } else if (rerankKind !== 'none') throw new Error(`unknown --rerank "${values.rerank}"`);
  const report = await runMultilingual({
    languages: list<Language>(values.lang, LANGUAGES, 'language'),
    conditions: list<Condition>(values.condition, CONDITIONS, 'condition'),
    ...(embed !== undefined && { embed }),
    ...(rerank !== undefined && { rerank }),
    ...(values['vector-index'] !== undefined && {
      vectorIndex: values['vector-index'] as 'auto' | 'int8' | 'binary',
    }),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const json = `${JSON.stringify({ embed: values.embed, rerank: values.rerank, ...report }, null, 2)}\n`;
  if (values.out !== undefined) fs.writeFileSync(fromUser(values.out), json);
  process.stdout.write(values.json ? json : `${renderMultilingual(report)}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`eval: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
