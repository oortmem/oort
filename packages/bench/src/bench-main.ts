import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RealNotConfirmedError, renderMarkdown, runBench, type RealEstimate } from './bench.js';
import { openLinkedStore } from './linked-store.js';
import {
  RECALL_PATHS,
  renderLinksLatency,
  runLinksLatency,
  type LinksWhich,
  type RecallPath,
} from './links-latency.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    json: { type: 'boolean', default: false },
    real: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    count: { type: 'string' },
    seed: { type: 'string' },
    // `--suite links` (CON-146): the links latency bar on cached 100k and 1M stores.
    suite: { type: 'string', default: 'default' },
    queries: { type: 'string' },
    repeats: { type: 'string' },
    paths: { type: 'string' },
    links: { type: 'string', default: 'both' },
    'cache-dir': { type: 'string' },
    rebuild: { type: 'boolean', default: false },
    'build-only': { type: 'boolean', default: false },
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

const positive = (raw: string, what: string): number => {
  const n = Number(raw.replace(/_/g, ''));
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${what} must be a positive integer, got "${raw}"`);
  return n;
};

async function links(): Promise<void> {
  const log = (m: string): void => {
    process.stderr.write(`bench: ${m}\n`);
  };
  const counts =
    values.count !== undefined
      ? values.count.split(',').map((c) => positive(c.trim(), '--count'))
      : [100_000, 1_000_000];
  const seed = values.seed !== undefined ? Number(values.seed) : 42;
  const cacheDir = values['cache-dir'];
  if (values['build-only']) {
    for (const count of counts) {
      const s = await openLinkedStore({
        count,
        seed,
        log,
        ...(cacheDir !== undefined && { cacheDir }),
        ...(values.rebuild && { rebuild: true }),
      });
      log(`${count}: ${s.built ? 'built' : 'cached'} at ${s.dir}`);
      await s.close();
    }
    return;
  }
  if (!['off', 'on', 'both'].includes(values.links)) {
    throw new Error(`--links must be off, on or both, got "${values.links}"`);
  }
  const paths = values.paths?.split(',').map((p) => p.trim());
  if (paths?.some((p) => !(RECALL_PATHS as readonly string[]).includes(p))) {
    throw new Error(`--paths takes ${RECALL_PATHS.join(', ')}`);
  }
  const result = await runLinksLatency({
    counts,
    seed,
    links: values.links as LinksWhich,
    log,
    ...(values.queries !== undefined && { queries: positive(values.queries, '--queries') }),
    ...(values.repeats !== undefined && { repeats: positive(values.repeats, '--repeats') }),
    ...(paths !== undefined && { paths: paths as RecallPath[] }),
    ...(cacheDir !== undefined && { cacheDir }),
    ...(values.rebuild && { rebuild: true }),
  });
  process.stdout.write(
    values.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderLinksLatency(result)}\n`,
  );
}

try {
  if (values.suite === 'links') {
    await links();
  } else if (values.suite !== 'default') {
    throw new Error(`unknown --suite "${values.suite}" (default or links)`);
  } else {
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
  }
} catch (e) {
  if (e instanceof RealNotConfirmedError) {
    process.stderr.write(`bench: ${e.message}\n`);
    process.exitCode = 2;
  } else {
    throw e;
  }
}
