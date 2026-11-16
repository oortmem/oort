import * as path from 'node:path';
import {
  agentEnvMarker,
  buildTrainingExport,
  TrainingExportError,
  writeTrainingExport,
  type TrainingKind,
  type TrainingManifest,
} from '@oortmem/core';
import { emit, jsonMode } from '../output.js';
import { cliVersion } from '../serve-protocol.js';
import { Refusal, withWired, writeGrant, type Ctx } from '../util.js';

/**
 * `oort export training`: the labels people gave here (judgments, resolves of predictions,
 * recall feedback) as fine-tuning JSON Lines in `--out`, one file per kind and a manifest. It
 * reads what `oort judge list` and `oort feedback list` read in this directory: the cwd's project
 * and global records. Local store only. A person runs it, never an agent: it refuses while an
 * agent harness is running it (`AGENT_ENV_MARKERS`), and `--yes` does not change that.
 */

export interface TrainingExportCliOptions {
  kind: string;
  out: string;
  expert?: string;
  since?: string;
  split?: string;
  include?: string[];
  exclude?: string[];
  preferenceReasons?: boolean;
  force?: boolean;
  /** Accepted so that it can be refused plainly: it never skips the agent check. */
  yes?: boolean;
  json?: boolean;
}

/** A core refusal as the CLI says it: the option by its flag. */
function refusal(e: TrainingExportError): Refusal {
  if (e.kind === 'exists') {
    return new Refusal(e.message.replace('pass force', 'pass --force'), { code: 'refused' });
  }
  if (e.kind === 'not-a-directory' || e.kind === 'unsafe-directory') {
    return new Refusal(e.message, { code: 'refused' });
  }
  const flag = e.message.replace(/^(kind|split|since|expert|include|exclude)\b/, '--$1');
  return new Refusal(`${flag.charAt(0).toUpperCase()}${flag.slice(1)}.`, { code: 'usage' });
}

/** One line per file, then what was left out. */
function summary(dir: string, m: TrainingManifest): string {
  const files = m.files.map(
    (f) => `  ${f.name.padEnd(24)} ${f.rows} row${f.rows === 1 ? '' : 's'}`,
  );
  const left = (Object.keys(m.excluded) as TrainingKind[]).flatMap((k) => {
    const reasons = Object.entries(m.excluded[k] ?? {});
    return reasons.length === 0
      ? []
      : [`  ${k}: ${reasons.map(([r, n]) => `${r} ${n}`).join(', ')}`];
  });
  const scrubbed = Object.values(m.scrubbed).reduce((a, b) => a + (b ?? 0), 0);
  const unselected = Object.values(m.excluded).some((x) => (x?.['origin-not-selected'] ?? 0) > 0);
  const hint =
    unselected &&
    !m.filters.origins.includes('integration') &&
    !m.filters.exclude.includes('integration')
      ? [
          'Labels recorded by code, imports or without the prompt are integration: add --include integration to export them.',
        ]
      : [];
  return [
    `Wrote a training export to ${dir} (origins: ${m.filters.origins.join(', ')}):`,
    ...files,
    `  ${'manifest.json'.padEnd(24)} counts, filters and sha256 of each file`,
    ...(left.length === 0 ? [] : ['Left out:', ...left]),
    ...hint,
    ...(scrubbed === 0 ? [] : [`Cleaned or redacted text in ${scrubbed} rows.`]),
    '',
  ].join('\n');
}

export async function trainingExportCommand(
  o: TrainingExportCliOptions,
  ctx: Ctx,
): Promise<number> {
  // Before the store is opened: an agent never reads the labels out, whatever flags it passes.
  const marker = agentEnvMarker(ctx.io.env);
  if (marker !== undefined) {
    throw new Refusal(
      `oort export training runs only for a person, and an agent harness is running this one (${marker} is set). Run it yourself in your own terminal, outside the agent.`,
      { code: 'refused', reason: 'agent-harness' },
    );
  }
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal(
        'The training export reads judgments, predictions and feedback, which are local-only for now. Run `oort cloud use --local` to use it.',
        { code: 'refused' },
      );
    }
    const dir = path.resolve(ctx.io.cwd, o.out);
    try {
      const exp = await buildTrainingExport(
        {
          kind: o.kind as TrainingKind | 'all',
          ...(o.expert !== undefined && { expert: o.expert }),
          ...(o.since !== undefined && { since: o.since }),
          ...(o.split !== undefined && { split: o.split }),
          ...(o.include !== undefined && { include: o.include }),
          ...(o.exclude !== undefined && { exclude: o.exclude }),
          ...(o.preferenceReasons === true && { preferenceReasons: true }),
        },
        { store: w.store, grant: writeGrant(w), version: cliVersion() },
      );
      writeTrainingExport(dir, exp, { force: o.force === true });
      if (jsonMode(ctx)) emit(ctx, { dir, manifest: exp.manifest });
      else ctx.io.out(summary(dir, exp.manifest));
    } catch (e) {
      if (e instanceof TrainingExportError) throw refusal(e);
      throw e;
    }
    return 0;
  });
}
