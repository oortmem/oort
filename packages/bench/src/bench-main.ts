import { parseArgs } from 'node:util';
import { renderMarkdown, runBench } from './bench.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    json: { type: 'boolean', default: false },
    real: { type: 'boolean', default: false },
    count: { type: 'string' },
    seed: { type: 'string' },
  },
});

const result = await runBench({
  ...(values.count !== undefined ? { count: Number(values.count) } : {}),
  ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
  real: values.real,
  log: (m) => process.stderr.write(`bench: ${m}\n`),
});
process.stdout.write(
  values.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMarkdown(result)}\n`,
);
