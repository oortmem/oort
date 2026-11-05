import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveHome, type DecisionController } from '@oortmem/core';
import { fitCalibration, type FitQuestion } from './decide-fit.js';
import {
  loadDecisionRows,
  renderDecisionReports,
  runDecisionEval,
  type DecisionReport,
  type DecisionRow,
} from './decide-eval.js';

/**
 * `pnpm eval --decisions`: the labelled decision questions put to each decider.
 *
 * - `local`: the decision model downloaded under `--home` (default `$OORT_HOME`); never downloads.
 *   `--rewrites` asks the whole reconcile tree (allowRewrites), as measured in docs/local-decider.md.
 * - `jev`: TypeSafe Jev, only when TYPESAFE_API_KEY is set (it sends the fixture rows to TypeSafe).
 * - `keyless`: what Oort does today with no decision model and no key: the drain leaves every
 *   turn in the queue, so nothing is stored (scored as "store nothing", reconcile not asked).
 */
export async function runDecisionsCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      decisions: { type: 'boolean' },
      decider: { type: 'string', default: 'local,jev,keyless' },
      model: { type: 'string' },
      home: { type: 'string' },
      file: { type: 'string' },
      threads: { type: 'string' },
      rewrites: { type: 'boolean', default: false },
      fit: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const file = values.file ?? fileURLToPath(new URL('../eval/decisions.jsonl', import.meta.url));
  const rows = loadDecisionRows(fs.readFileSync(file, 'utf8'));
  if (values.fit) return fit(rows, values);
  const reports: DecisionReport[] = [];
  for (const name of values.decider.split(',').map((s) => s.trim())) {
    let controller: DecisionController;
    let label = name;
    if (name === 'keyless') {
      controller = {
        async gate() {
          return { shouldStore: 0, salience: 0, types: {}, decisions: [] };
        },
        async reconcile() {
          return [];
        },
      };
      const gateRows = rows.filter((r) => r.kind === 'gate');
      reports.push(await runDecisionEval('keyless (today)', controller, gateRows));
      continue;
    }
    if (name === 'jev') {
      const key = process.env['TYPESAFE_API_KEY'];
      if (key === undefined || key === '') {
        process.stderr.write('eval: jev skipped (TYPESAFE_API_KEY is not set)\n');
        continue;
      }
      controller = (await import('@oortmem/decide-jev')).jevDecider({ apiKey: key });
    } else if (name === 'local') {
      const lm = await import('@oortmem/local-models');
      const home = values.home ?? resolveHome();
      const model = values.model ?? lm.decideModelId(home);
      label = `local ${model}${values.rewrites ? ' (rewrites on)' : ''}`;
      try {
        controller = lm.localDecider({
          home,
          model,
          ...(values.threads !== undefined && { threads: Number(values.threads) }),
          ...(values.rewrites && { allowRewrites: true }),
        });
      } catch (e) {
        process.stderr.write(`eval: local skipped (${(e as Error).message})\n`);
        continue;
      }
    } else {
      throw new Error(`--decider: unknown decider "${name}" (local, jev or keyless)`);
    }
    process.stderr.write(`eval: ${label} on ${rows.length} rows...\n`);
    reports.push(await runDecisionEval(label, controller, rows));
  }
  process.stdout.write(
    values.json ? `${JSON.stringify(reports, null, 2)}\n` : `${renderDecisionReports(reports)}\n`,
  );
  return 0;
}

/**
 * `--fit`: runs the local decider uncalibrated, with the whole reconcile tree, and prints the
 * calibration that separates the labelled rows best, per question, for the model's catalog entry.
 */
async function fit(
  rows: DecisionRow[],
  values: { model?: string; home?: string; threads?: string; json: boolean },
): Promise<number> {
  const lm = await import('@oortmem/local-models');
  const home = values.home ?? resolveHome();
  const model = values.model ?? lm.decideModelId(home);
  const spec = lm.findModel(model);
  if (spec?.role !== 'decide') throw new Error(`--fit: ${model} is not a decision model`);
  const samples: { question: FitQuestion; yes: number; row: DecisionRow }[] = [];
  let row: DecisionRow | undefined;
  const controller = lm.localDecider({
    home,
    model,
    spec: { ...spec, calibration: {} },
    allowRewrites: true,
    ...(values.threads !== undefined && { threads: Number(values.threads) }),
    onAnswer: (question, yes) => samples.push({ question, yes, row: row! }),
  });
  process.stderr.write(`eval: fitting ${model} on ${rows.length} rows...\n`);
  await runDecisionEval(model, controller, rows, (i) => (row = rows[i]));
  const results = fitCalibration(samples);
  if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    process.stdout.write('| Question | Rows | Bias | Right at 0.5 | Fitted | Leave-one-out |\n');
    process.stdout.write('| --- | --- | --- | --- | --- | --- |\n');
    for (const r of results) {
      process.stdout.write(
        `| ${r.question} | ${r.rows} | ${r.bias} | ${r.raw} | ${r.fitted} | ${r.leaveOneOut} |\n`,
      );
    }
    const cal = Object.fromEntries(results.map((r) => [r.question, r.bias]));
    process.stdout.write(`\ncalibration: ${JSON.stringify(cal)}\n`);
  }
  return 0;
}
