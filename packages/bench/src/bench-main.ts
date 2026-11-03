import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RealNotConfirmedError, renderMarkdown, runBench, type RealEstimate } from './bench.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    json: { type: 'boolean', default: false },
    real: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    count: { type: 'string' },
    seed: { type: 'string' },
  },
});

/** Prints the estimate, then proceeds only on `--yes` or an interactive "y". */
async function confirmReal(e: RealEstimate): Promise<boolean> {
  process.stderr.write(
    `bench: --real will call Voyage for up to ${e.queries} queries.\n` +
      `bench: estimated tokens (about 4 chars each): embed ${e.embedTokens}, rerank ${e.rerankTokens}.\n` +
      'bench: it pairs real query embeddings with fake stored embeddings, so only its latency is meaningful.\n',
  );
  if (values.yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question('bench: proceed? [y/N] ')).trim());
  } finally {
    rl.close();
  }
}

try {
  const result = await runBench({
    ...(values.count !== undefined ? { count: Number(values.count) } : {}),
    ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
    real: values.real,
    confirmReal,
    log: (m) => process.stderr.write(`bench: ${m}\n`),
  });
  process.stdout.write(
    values.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMarkdown(result)}\n`,
  );
} catch (e) {
  if (e instanceof RealNotConfirmedError) {
    process.stderr.write(`bench: ${e.message}\n`);
    process.exitCode = 2;
  } else {
    throw e;
  }
}
