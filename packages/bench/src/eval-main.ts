import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveHome } from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { loadEvalRows, runEval, type EvalReport } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { seedStore } from './seed.js';

const USAGE = `usage: pnpm eval <file.jsonl> [--store <path>] [--cold-dir <dir>] [--k 5,10]
                 [--min-recall10 <0..1>] [--dimension <n>] [--dense] [--now <iso>]
                 [--abstain-threshold <n>] [--json]
       pnpm eval --demo [--json]    synthetic 1500-memory store + the bundled 20-row fixture

Runs recall for each row against a temp copy of the store (the live store is never written).`;

const cell = (n: number | null | undefined): string =>
  n === null || n === undefined ? '-' : n.toFixed(3);

export function renderReport(r: EvalReport): string {
  const head = [
    'Group',
    'Rows',
    ...r.ks.map((k) => `recall@${k}`),
    'MRR@10',
    'Stale-leak',
    'Abstain FP',
  ];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const [name, g] of Object.entries(r.groups)) {
    lines.push(
      `| ${[name, String(g.rows), ...r.ks.map((k) => cell(g.recallAt[k])), cell(g.mrr), cell(g.staleLeak), cell(g.abstainFp)].join(' | ')} |`,
    );
  }
  if (r.skippedEmpty > 0) {
    lines.push('', `Skipped ${r.skippedEmpty} row(s) with an empty question.`);
  }
  return lines.join('\n');
}

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
      json: { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const ks = values.k.split(',').map((s) => Number(s.trim()));
  if (ks.some((k) => !Number.isInteger(k) || k <= 0))
    throw new Error(`--k must be positive integers, got "${values.k}"`);
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

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`eval: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
