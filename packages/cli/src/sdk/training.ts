import * as path from 'node:path';
import { runTrainingExport, TrainingExportError, VERSION } from '@oortmem/core';
import { localOnly } from './cloud.js';
import { storeOf, type Ctx } from './context.js';
import { OortRefusedError, OortUsageError } from './errors.js';
import type { ExportTrainingOptions, TrainingExportView } from './types.js';
import { iso } from './validate.js';

/**
 * The training export from code: what `oort export training` writes, for a handle in the expert
 * role. It reads what this handle's grant reads: a handle scoped to one project exports that
 * project's predictions and feedback only, while judgments belong to the expert and come from
 * every project. An agent-role handle is refused: the labels are a person's to hand out. `out`
 * must be an absolute path, so it never depends on the process's working directory.
 */
export async function exportTraining(
  ctx: Ctx,
  o: ExportTrainingOptions,
): Promise<TrainingExportView> {
  if (ctx.engine.mode === 'cloud') throw localOnly('The training export');
  if (ctx.judge.role !== 'expert') {
    throw new OortRefusedError(
      'Only a person exports training data: create the handle with judge: { role: "expert" } in a code path where a person asked for it.',
      { reason: 'expert-only' },
    );
  }
  if (!path.isAbsolute(o.out)) {
    throw new OortUsageError('out must be an absolute path.', { reason: 'invalid-argument' });
  }
  const dir = path.resolve(o.out);
  try {
    const { export: exp } = await runTrainingExport(
      dir,
      {
        kind: o.kind,
        ...(o.expert !== undefined && { expert: o.expert }),
        ...(o.since !== undefined && { since: iso(o.since) }),
        ...(o.split !== undefined && { split: o.split }),
        ...(o.include !== undefined && { include: o.include }),
        ...(o.exclude !== undefined && { exclude: o.exclude }),
        ...(o.preferenceReasons === true && { preferenceReasons: true }),
      },
      { store: storeOf(ctx), grant: ctx.principal.grant, version: VERSION, now: ctx.now() },
      { force: o.force === true },
    );
    return { dir, manifest: exp.manifest };
  } catch (e) {
    if (!(e instanceof TrainingExportError)) throw e;
    if (e.kind === 'invalid') {
      throw new OortUsageError(`${e.message}.`, { reason: 'invalid-argument' });
    }
    if (e.kind === 'store-changing') {
      throw new OortRefusedError(e.message, { reason: 'store-changing', retryable: true });
    }
    const reason =
      e.kind === 'exists'
        ? 'export-exists'
        : e.kind === 'unsafe-directory'
          ? 'unsafe-directory'
          : 'not-a-directory';
    throw new OortRefusedError(e.message, { reason });
  }
}
