import * as path from 'node:path';
import { reindexSqliteStore } from '@oortmem/store-sqlite';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, withWired, type Ctx } from '../util.js';

/**
 * `oort reindex`: rebuilds the store's RaBitQ index (CON-25) with a new centroid, from the int8
 * vectors it already holds (no model or vendor is called). `oort doctor` says when it is due: once
 * the store holds four times the vectors the index was built from. It runs in committed batches,
 * so the hooks and an MCP server keep working meanwhile (their dense search scans int8 until it
 * is done), and a stopped run is finished by the next `oort` command. Nothing else is rebuilt,
 * and a store without a RaBitQ index is left as it is.
 */
export async function reindexCommand(ctx: Ctx): Promise<number> {
  const ui = uiFor(ctx.io);
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal(
        'This machine uses Oort Cloud, which keeps its own index; nothing to reindex here.',
        { code: 'refused' },
      );
    }
    const t0 = performance.now();
    let shown = -1;
    const r = await reindexSqliteStore({
      path: path.join(w.config.home, 'oort.sqlite'),
      coldDir: path.join(w.config.home, 'cold'),
      dimension: w.config.embed.dimension,
      vectorIndex: w.config.store.vectorIndex,
      log: (m) => ctx.io.err(`${m}\n`),
      onProgress: ({ done, total }) => {
        if (!ctx.io.stdoutIsTTY || total === 0) return;
        const pct = Math.floor((done / total) * 20);
        if (pct === shown) return;
        shown = pct;
        ctx.io.err(`\r  ${ui.bar(done, total)} ${done} / ${total}`);
      },
    });
    if (shown >= 0) ctx.io.err('\n');
    const seconds = Number(((performance.now() - t0) / 1000).toFixed(1));
    const vectors = `${r.vectors} ${r.vectors === 1 ? 'vector' : 'vectors'}`;
    ctx.io.out(
      r.rebuilt
        ? `${ui.ok(`Rebuilt the RaBitQ vector index (${vectors}) in ${seconds}s, centred on today's vectors.`)}\n`
        : `${ui.ok(`The store searches its ${r.index === 'binary' ? 'binary' : 'int8'} index (${vectors}); only a RaBitQ index is rebuilt, so nothing to do.`)}\n`,
    );
    if (jsonMode(ctx)) emit(ctx, { ...r, seconds });
    return 0;
  });
}
