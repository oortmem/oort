/**
 * Opt-in calibration of the gate-miss rerank's floors (`recall.gateMissDenseFloor` and
 * `recall.gateMissRerankFloor`) on the multilingual eval, with the Voyage models. Never run by
 * tests. Needs VOYAGE_API_KEY; it sends the eval's synthetic texts to Voyage (about 2,800 texts to
 * embed and 650 rerank calls on 2026-11-12, a few US cents).
 *
 *   VOYAGE_API_KEY=... pnpm --filter @oortmem/bench run calibrate:gate-miss -- --out floors.json
 *
 * One recording run with both floors at 0 keeps every gate miss's dense score and rerank scores;
 * every pair of floors is then replayed from it (`gate-miss.ts`), so the grid costs no more calls.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfig } from '@oortmem/core';
import { voyageEmbedder } from '@oortmem/embed-voyage';
import { voyageReranker } from '@oortmem/rerank-voyage';
import { EMBEDDING_DIMENSION } from './generate.js';
import {
  chooseCheaper,
  grid,
  judge,
  measure,
  OFF,
  perLanguage,
  recordGateMiss,
  replay,
  rerankLatency,
} from './gate-miss.js';
import { unrelatedRows } from './multilingual.js';

async function main(): Promise<number> {
  const apiKey = process.env['VOYAGE_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write('calibrate:gate-miss: set VOYAGE_API_KEY (this script calls Voyage).\n');
    return 2;
  }
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      out: { type: 'string' },
      // How much macro cross recall@10 the choice may give up for a higher dense floor.
      slack: { type: 'string', default: '0.02' },
    },
  });
  // The default models, never a config file on this machine.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-gate-miss-'));
  const config = resolveConfig(home, { OORT_HOME: home }, { projectConfig: false });
  const records = await recordGateMiss({
    embed: voyageEmbedder({
      apiKey,
      model: config.embed.model,
      dimension: EMBEDDING_DIMENSION,
    }),
    rerank: voyageReranker({ apiKey, model: config.rerank.model }),
    extraRows: unrelatedRows(),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const choice = chooseCheaper(records, Number(values.slack));
  const floors = choice?.chosen.floors ?? OFF;
  const rate = (f: (r: (typeof records)[number]) => boolean) => {
    const xs = records.filter(f);
    return xs.filter((r) => replay(r, floors).reranked).length / Math.max(1, xs.length);
  };
  const result = {
    models: { embed: `${config.embed.model}@${EMBEDDING_DIMENSION}`, rerank: config.rerank.model },
    best: choice?.best ?? null,
    chosen: choice?.chosen ?? null,
    off: judge(records, OFF),
    cells: { off: measure(records, OFF), chosen: measure(records, floors) },
    perLanguage: perLanguage(records),
    firing: {
      unrelated: rate((r) => r.unrelated),
      cross: rate((r) => !r.unrelated && r.condition === 'cross'),
      enMono: rate((r) => !r.unrelated && r.lang === 'en' && r.condition === 'mono'),
    },
    denseSweep: grid(0.3, 0.7, 0.05).map((d) =>
      judge(records, { dense: d, rerank: floors.rerank }),
    ),
    rerankLatencyMs: rerankLatency(records, floors),
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out !== undefined) fs.writeFileSync(values.out, text);
  else process.stdout.write(text);
  process.stderr.write(
    `floors: ${choice === undefined ? 'none meet the bars' : JSON.stringify(floors)}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`calibrate:gate-miss: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
