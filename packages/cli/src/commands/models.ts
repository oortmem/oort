import * as fs from 'node:fs';
import * as path from 'node:path';
import { OortConfig, resolveHome, writePrivateFile } from '@oortmem/core';
import { readEmbedderBinding } from '@oortmem/store-sqlite';
import type { ModelSpec } from '@oortmem/local-models';
import { LOCAL_PROVIDER, embedderId, importLocalModels } from '../local-models.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, echo, tilde, type Ctx } from '../util.js';

type LocalModels = Exclude<Awaited<ReturnType<typeof importLocalModels>>, Error>;

const mb = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

async function localModels(): Promise<LocalModels> {
  const lm = await importLocalModels();
  if (lm instanceof Error) throw new Refusal(lm.message);
  return lm;
}

function readHomeConfig(home: string): Record<string, unknown> {
  const file = path.join(home, 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw new Refusal(`${file} is not a JSON object; fix it, then run this again.`);
}

type LocalRole = 'embed' | 'rerank' | 'decide';

/**
 * Sets (or with `model` null, removes) one role's provider and model in the home config. Every
 * other key, `embed.dimension` included, is kept; the result must still be a valid config.
 * `decide` names no model (the downloaded decision model is used), only `provider: "local"`.
 */
export function setHomeModel(home: string, role: LocalRole, model: string | null): void {
  const config = readHomeConfig(home);
  const section: Record<string, unknown> = {
    ...(config[role] as Record<string, unknown> | undefined),
  };
  if (model === null) {
    delete section['provider'];
    delete section['model'];
  } else {
    section['provider'] = LOCAL_PROVIDER;
    if (role !== 'decide') section['model'] = model;
  }
  if (Object.keys(section).length === 0) delete config[role];
  else config[role] = section;
  OortConfig.parse(config);
  writePrivateFile(path.join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Which local model each role of the home config uses, if any. */
function activeLocal(lm: LocalModels, home: string): Partial<Record<LocalRole, string>> {
  let config: OortConfig;
  try {
    config = OortConfig.parse(readHomeConfig(home));
  } catch {
    return {};
  }
  const out: Partial<Record<LocalRole, string>> = {};
  if (config.embed.provider === LOCAL_PROVIDER) out.embed = config.embed.model;
  if (config.rerank.provider === LOCAL_PROVIDER) out.rerank = config.rerank.model;
  if (config.decide.provider === LOCAL_PROVIDER) out.decide = lm.decideModelId(home);
  return out;
}

function specsFor(lm: LocalModels, ids: readonly string[]): ModelSpec[] {
  return ids.map((id) => {
    const spec = lm.findModel(id);
    if (spec === undefined) {
      throw new Refusal(
        `${echo(id)} is not a local model; choose from ${lm.MODELS.map((m) => m.id).join(', ')}.`,
      );
    }
    return spec;
  });
}

/** `oort models [list] [--json]`: the catalog, what is downloaded, and what is in use. */
export async function modelsListCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  const lm = await localModels();
  const home = resolveHome(ctx.io.env);
  const active = activeLocal(lm, home);
  const rows = lm.MODELS.map((m) => ({
    id: m.id,
    role: m.role,
    size: m.size,
    bytes: lm.downloadBytes(m),
    licence: m.licence,
    upstream: m.upstream,
    state: lm.modelState(home, m),
    active: active[m.role] === m.id,
  }));
  if (opts.json === true) {
    ctx.io.out(`${JSON.stringify({ models: rows }, null, 2)}\n`);
    return 0;
  }
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('models', tilde(lm.modelsRoot(home), ctx.io.env['HOME'] ?? '')));
  ctx.io.out(
    `${ui.table(
      ['model', 'role', 'download', 'licence', 'state'],
      rows.map((r) => [
        r.active ? ui.bold(r.id) : r.id,
        r.role,
        `${mb(r.bytes)}${r.size === 'large' ? ui.dim(' (large)') : ''}`,
        r.licence,
        r.state === 'ready'
          ? ui.green(r.active ? 'in use' : 'downloaded')
          : r.state === 'missing'
            ? ui.dim('not downloaded')
            : ui.yellow(r.state),
      ]),
    )}\n`,
  );
  if (rows.every((r) => r.state === 'missing')) {
    ctx.io.out(ui.dim('\nRun `oort models pull` to download the defaults and use them.\n'));
  }
  return 0;
}

export interface PullOptions {
  /** false with `--no-use`: download only, leave the config. */
  use?: boolean;
}

/**
 * `oort models pull [ids...]`: downloads (default: the small embedder and reranker), verifies
 * every file against its pinned SHA-256, writes the optimised cache, and switches the home
 * config to them. The only command that downloads a model.
 */
export async function modelsPullCommand(
  ids: string[],
  opts: PullOptions,
  ctx: Ctx,
): Promise<number> {
  const lm = await localModels();
  const ui = uiFor(ctx.io);
  const home = resolveHome(ctx.io.env);
  const wanted = ids.length > 0 ? ids : [lm.DEFAULT_EMBED_MODEL, lm.DEFAULT_RERANK_MODEL];
  const specs = specsFor(lm, wanted);
  for (const role of ['embed', 'rerank', 'decide'] as const) {
    if (specs.filter((s) => s.role === role).length > 1) {
      throw new Refusal(`pull one ${role} model at a time.`);
    }
  }
  const baseUrl = ctx.io.env['OORT_MODELS_URL'];
  const runtime = lm.onnxRuntime();
  ctx.io.out(ui.header('models pull', tilde(lm.modelsRoot(home), ctx.io.env['HOME'] ?? '')));
  for (const spec of specs) {
    const state = lm.modelState(home, spec);
    if (state === 'ready') {
      ctx.io.out(`${ui.ok(`${spec.id} is already downloaded`)}\n`);
    } else {
      ctx.io.out(
        `${ui.info(`${spec.id}: downloading ${mb(lm.downloadBytes(spec))} (${spec.licence}, from ${spec.source.repo})`)}\n`,
      );
      let shown = -1;
      try {
        await lm.pullModel(home, spec, {
          ...(ctx.fetch !== undefined && { fetch: ctx.fetch }),
          ...(baseUrl !== undefined && baseUrl !== '' && { baseUrl }),
          onProgress: ({ file, received, total }) => {
            if (!ctx.io.stdoutIsTTY || file !== 'model.onnx') return;
            const pct = Math.floor((received / total) * 20);
            if (pct === shown) return;
            shown = pct;
            ctx.io.err(`\r  ${ui.bar(received, total)} ${mb(received)} / ${mb(total)}`);
          },
        });
      } catch (e) {
        if (shown >= 0) ctx.io.err('\n');
        throw new Refusal(`${(e as Error).message}`);
      }
      if (shown >= 0) ctx.io.err('\n');
      ctx.io.out(`${ui.ok(`${spec.id}: verified (SHA-256 of every file matches its pin)`)}\n`);
    }
    // The decision model is 1.8 GB and loads once per drain: an optimised copy would double the
    // disk it takes for a load time nobody waits on.
    if (spec.role === 'decide') continue;
    try {
      await runtime.optimize?.(lm.modelDir(home, spec.id));
    } catch (e) {
      ctx.io.out(
        `${ui.warn(`${spec.id}: optimised cache skipped (${(e as Error).name}); loads are slower`)}\n`,
      );
    }
  }
  if (opts.use === false) {
    ctx.io.out(
      ui.dim('\nDownloaded only (--no-use). Use them with `oort models pull` without --no-use.\n'),
    );
    return 0;
  }
  const changed: string[] = [];
  for (const spec of specs) {
    setHomeModel(home, spec.role, spec.id);
    changed.push(`${spec.role}: ${LOCAL_PROVIDER} ${spec.id}`);
  }
  ctx.io.out(`\n${ui.ok(`~/.oort/config.json now uses ${changed.join(', ')}`)}\n`);
  ctx.io.out(ui.dim('Undo: oort models rm (deletes the files and switches back).\n'));
  const embed = specs.find((s) => s.role === 'embed');
  if (embed !== undefined)
    mismatchNote(ctx, ui, home, embedderId({ provider: LOCAL_PROVIDER, model: embed.id }));
  return 0;
}

/** After switching embedders: how to bring a store with memories over. */
function mismatchNote(ctx: Ctx, ui: Ui, home: string, active: string): void {
  const binding = readEmbedderBinding(path.join(home, 'oort.sqlite'));
  if (!binding.hasMemories) return;
  const bound = binding.model ?? 'voyage/voyage-3.5-lite';
  if (bound === active) return;
  ctx.io.out(
    `${ui.warn(`Your memories are embedded with ${bound}. Run \`oort reembed\` to re-embed them with ${active}; until then dense recall and saving are off.`)}\n`,
  );
}

/** `oort models verify [ids...]`: re-hashes downloaded models against their pins. */
export async function modelsVerifyCommand(ids: string[], ctx: Ctx): Promise<number> {
  const lm = await localModels();
  const ui = uiFor(ctx.io);
  const home = resolveHome(ctx.io.env);
  const specs =
    ids.length > 0
      ? specsFor(lm, ids)
      : lm.MODELS.filter((m) => lm.modelState(home, m) !== 'missing');
  if (specs.length === 0) {
    ctx.io.out('No local models are downloaded.\n');
    return 0;
  }
  let bad = 0;
  for (const spec of specs) {
    const r = await lm.verifyModel(home, spec);
    if (r.ok) ctx.io.out(`${ui.ok(`${spec.id}: every file matches its SHA-256`)}\n`);
    else {
      bad++;
      ctx.io.out(
        `${ui.fail(`${spec.id}: ${r.bad.join(', ')} changed or missing; run \`oort models pull ${spec.id}\``)}\n`,
      );
    }
  }
  return bad === 0 ? 0 : 1;
}

/**
 * `oort models rm [ids...]`: deletes downloaded models (default: all), and switches any role
 * that used one back to the default provider.
 */
export async function modelsRmCommand(ids: string[], ctx: Ctx): Promise<number> {
  const lm = await localModels();
  const ui = uiFor(ctx.io);
  const home = resolveHome(ctx.io.env);
  const specs =
    ids.length > 0
      ? specsFor(lm, ids)
      : lm.MODELS.filter((m) => lm.modelState(home, m) !== 'missing');
  const active = activeLocal(lm, home);
  for (const spec of specs) {
    if (lm.removeModel(home, spec.id)) ctx.io.out(`${ui.ok(`deleted ${spec.id}`)}\n`);
    if (active[spec.role] === spec.id) {
      setHomeModel(home, spec.role, null);
      ctx.io.out(
        `${ui.ok(`${spec.role} is back to the default provider (${spec.role === 'decide' ? 'TypeSafe Jev' : 'Voyage'}, when a key or Oort Pro is set)`)}\n`,
      );
      if (spec.role === 'embed') {
        const embed = OortConfig.parse(readHomeConfig(home)).embed;
        mismatchNote(ctx, ui, home, embedderId(embed));
      }
    }
  }
  if (specs.length === 0) ctx.io.out('No local models are downloaded.\n');
  return 0;
}
