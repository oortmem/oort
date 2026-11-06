import * as path from 'node:path';
import { MissingCredentialError } from '@oortmem/core';
import { reembedSqliteStore } from '@oortmem/store-sqlite';
import { LOCAL_PROVIDER } from '../local-models.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, adapterProblem, confirm, withWired, type Ctx } from '../util.js';

export interface ReembedCommandOptions {
  /** Re-embed even when the store is already bound to the configured embedder. */
  force?: boolean;
  /** Skip the question before a paid (non-local) embedder is called. */
  yes?: boolean;
}

/**
 * `oort reembed`: moves the store to the configured embedder. Every live memory's vector and
 * every cold copy's stored vector is recomputed from its text, then the store is bound to the
 * new embedder, which turns dense recall and saving back on. Text and metadata are untouched;
 * an interrupted run changes no binding and can simply be run again.
 */
export async function reembedCommand(opts: ReembedCommandOptions, ctx: Ctx): Promise<number> {
  const ui = uiFor(ctx.io);
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal(
        'This machine uses Oort Cloud, which embeds on the server; nothing to re-embed here.',
        { code: 'refused' },
      );
    }
    const embedder = w.reembedWith ?? w.embed;
    const binding = w.embedder;
    if (embedder === undefined || binding === undefined) {
      const why =
        adapterProblem(w.unavailable.embed, 'embed', w.keyStore !== false) ??
        'No embedder is configured.';
      throw new Refusal(
        `Re-embedding needs the configured embedder. ${why}`,
        w.unavailable.embed instanceof MissingCredentialError
          ? { code: 'needs-key', fix: 'oort models pull' }
          : {},
      );
    }
    if (binding.matches && opts.force !== true) {
      ctx.io.out(
        `${ui.ok(`Memories are already embedded with ${binding.active}; nothing to do (--force re-embeds anyway).`)}\n`,
      );
      if (jsonMode(ctx)) {
        emit(ctx, {
          embedder: binding.active,
          previous: binding.bound,
          reembedded: false,
          live: 0,
          cold: 0,
          withoutVector: 0,
        });
      }
      return 0;
    }
    ctx.io.out(ui.header('reembed', `${binding.bound} → ${binding.active}`));
    if (!binding.active.startsWith(`${LOCAL_PROVIDER}/`)) {
      const go = await confirm(
        ctx.io,
        `Re-embedding calls ${binding.active} once per memory (billed by the provider). Go on?`,
        opts.yes === true,
        're-embed through the provider',
        { json: jsonMode(ctx) },
      );
      if (!go) {
        ctx.io.out('Nothing re-embedded.\n');
        return 0;
      }
    }
    const t0 = performance.now();
    let shown = -1;
    const r = await reembedSqliteStore({
      path: path.join(w.config.home, 'oort.sqlite'),
      coldDir: path.join(w.config.home, 'cold'),
      dimension: w.config.embed.dimension,
      model: binding.active,
      embed: (texts) => embedder.embed(texts, 'document'),
      onProgress: ({ done, total }) => {
        if (!ctx.io.stdoutIsTTY) return;
        const pct = Math.floor((done / total) * 20);
        if (pct === shown) return;
        shown = pct;
        ctx.io.err(`\r  ${ui.bar(done, total)} ${done} / ${total}`);
      },
      log: (m) => ctx.io.err(`${m}\n`),
    });
    if (shown >= 0) ctx.io.err('\n');
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    ctx.io.out(
      `${ui.ok(`re-embedded ${r.live} ${r.live === 1 ? 'memory' : 'memories'} and ${r.cold} cold ${r.cold === 1 ? 'copy' : 'copies'} with ${binding.active} in ${secs}s`)}\n`,
    );
    if (r.withoutVector > 0) {
      ctx.io.out(ui.dim(`${r.withoutVector} saved without a vector stay lexical-only.\n`));
    }
    ctx.io.out(ui.dim('Dense recall and saving are on again.\n'));
    if (jsonMode(ctx)) {
      emit(ctx, {
        embedder: binding.active,
        previous: binding.bound,
        reembedded: true,
        live: r.live,
        cold: r.cold,
        withoutVector: r.withoutVector,
        seconds: Number(secs),
      });
    }
    return 0;
  });
}
