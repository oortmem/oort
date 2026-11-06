import * as path from 'node:path';
import { readEmbedderBinding } from '@oortmem/store-sqlite';
import {
  ANONYMOUS_AGENT,
  addressOf,
  exportLine,
  fitsVersion1,
  principalGrant,
  readAgents,
  type Memory,
  type Scope,
} from '@oortmem/core';
import {
  OortCloudError,
  cloudUrl,
  createCloudClient,
  readCloudSettings,
  writeCloudSettings,
  type CloudClient,
  type ImportProgress,
} from '../cloud.js';
import { keyLookup } from '../credentials.js';
import { uiFor } from '../ui.js';
import { Refusal, confirm, shapeLinks, withWired, writeOwnerOnly, type Ctx } from '../util.js';
import type { Wired } from '../wire.js';
import { decoded, scopeKey, type ExportManifest } from './export.js';

/** One import request: at most this many memory lines and bytes (the API takes 1,000 and 10 MB). */
export const IMPORT_CHUNK_LINES = 500;
export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;

/** A client for this machine's Oort key, whichever store mode is set. */
export async function clientFor(ctx: Ctx): Promise<CloudClient> {
  const url = cloudUrl(ctx.io.env);
  if ('error' in url) throw new Refusal(url.error);
  const key = await keyLookup(ctx.io.env, ctx.keychain.read)('oort');
  if (key === undefined) {
    throw new Refusal('Oort Cloud needs the Oort key: run `oort login` first.');
  }
  return createCloudClient({
    url: url.url,
    key: key.key,
    ...(ctx.fetch !== undefined && { fetch: ctx.fetch }),
  });
}

/**
 * Every memory in the local store (all projects of this machine's principal),
 * oldest first, in export format version 1: the version Oort Cloud's import
 * reads: the person's Planet (every agent's Planet memories), which version 1
 * holds exactly. Stars stay on this machine (each is private to its agent),
 * and a contradiction naming one is left out. Each line keeps its author in
 * `scope.agentId`; Oort Cloud's import re-scopes every line to the account's
 * own Planet, keeping its project (see `test/fake-cloud.ts`).
 */
async function localExport(
  w: Wired,
  ctx: Ctx,
): Promise<{ manifest: ExportManifest; lines: string[]; withEmbedding: number }> {
  const s = w.scope;
  // The Planet alone, whoever acts: the anonymous principal has no Star.
  const grant = principalGrant({
    orgId: s.orgId,
    customerId: s.customerId,
    agentId: ANONYMOUS_AGENT,
  });
  // Judgments (CON-71) are local-only for now: Oort Cloud has no judgment memory yet.
  const all = (await w.store.list(grant, { validOnly: false })).filter(
    (m) => addressOf(m).level === 'user' && m.type !== 'judgment',
  );
  all.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
  const lines: string[] = [];
  const scopes = new Map<string, Scope>();
  let withEmbedding = 0;
  // Oort Cloud's vectors are Voyage's: a store embedded by a local model sends text only.
  const bound = readEmbedderBinding(path.join(w.config.home, 'oort.sqlite')).model;
  const voyageVectors = bound === null || bound.startsWith('voyage/');
  for (const m of all) {
    const read: Memory = await shapeLinks(w.store, grant, await decoded(m, w.store, grant, ctx));
    const { embedding, ...rest } = read;
    const full: Memory = voyageVectors || embedding === undefined ? read : rest;
    if (full.embedding !== undefined && full.embedding.length === w.config.embed.dimension)
      withEmbedding++;
    if (!fitsVersion1(full)) {
      throw new Refusal(
        `Memory ${full.id} is outside your Planet; Oort Cloud cannot import it yet.`,
      );
    }
    scopes.set(scopeKey(full.scope), full.scope);
    lines.push(JSON.stringify(exportLine(full, 1)));
  }
  const manifest: ExportManifest = {
    oort: 'export',
    version: 1,
    exportedAt: new Date().toISOString(),
    memories: lines.length,
    scopes: [...scopes.values()],
  };
  return { manifest, lines, withEmbedding };
}

/** Chunks of export lines, each within the line and byte caps. */
function chunks(lines: string[], from: number): { start: number; lines: string[] }[] {
  const out: { start: number; lines: string[] }[] = [];
  let cur: string[] = [];
  let bytes = 0;
  let start = from;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] as string;
    const b = Buffer.byteLength(line) + 1;
    if (cur.length > 0 && (cur.length >= IMPORT_CHUNK_LINES || bytes + b > IMPORT_CHUNK_BYTES)) {
      out.push({ start, lines: cur });
      cur = [];
      bytes = 0;
      start = i;
    }
    cur.push(line);
    bytes += b;
  }
  if (cur.length > 0) out.push({ start, lines: cur });
  return out;
}

/**
 * Uploads one chunk. The API imports at most 1,000 lines a call and answers `next` (an index into
 * the posted lines) when it stopped early; the same lines are posted again with `from = next`
 * until it is done. `progress` gets how many of the chunk's lines are in after each call.
 */
export async function uploadChunk(
  client: CloudClient,
  header: string,
  lines: string[],
  progress: (inChunk: number) => void,
): Promise<{ imported: number; skipped: number; reembedded: number; calls: number }> {
  const body = [header, ...lines];
  const total = { imported: 0, skipped: 0, reembedded: 0, calls: 0 };
  let from = 0;
  for (;;) {
    const r = await client.importLines(body, from);
    total.calls++;
    total.imported += r.imported;
    total.skipped += r.skipped;
    total.reembedded += r.reembedded;
    if (r.next === undefined) {
      progress(lines.length);
      return total;
    }
    // Line 0 is the manifest, so line `next` of the body is line `next - 1` of the chunk.
    if (!Number.isInteger(r.next) || r.next <= Math.max(from, 1) || r.next > lines.length) {
      throw new Refusal('Oort Cloud stopped making progress on the import; run it again later.');
    }
    progress(r.next - 1);
    from = r.next;
  }
}

const fingerprintOf = (lines: string[]): string => {
  const id = (l: string | undefined): string =>
    l === undefined ? '' : ((JSON.parse(l) as { id?: string }).id ?? '');
  return `${lines.length}:${id(lines[0])}:${id(lines.at(-1))}`;
};

/**
 * How many of `lines` (the local store, oldest first) an earlier `oort cloud import` uploaded:
 * all of them when the store is unchanged since, the first `total` when memories were only added
 * after it, else none known.
 */
export function importedCount(progress: ImportProgress | undefined, lines: string[]): number {
  if (progress === undefined) return 0;
  if (progress.fingerprint === fingerprintOf(lines)) return Math.min(progress.done, lines.length);
  if (
    progress.total < lines.length &&
    progress.fingerprint === fingerprintOf(lines.slice(0, progress.total))
  )
    return Math.min(progress.done, progress.total);
  return 0;
}

/** `oort cloud use [--local]`: switch this machine's store. */
export async function cloudUseCommand(opts: { local?: boolean }, ctx: Ctx): Promise<number> {
  const home = (await withWired(ctx, async (w) => w.config.home)) as string;
  const settings = readCloudSettings(home);
  const ui = uiFor(ctx.io);
  if (opts.local === true) {
    writeCloudSettings(home, { ...settings, store: 'local' });
    ctx.io.out(ui.header('cloud', 'local store'));
    ctx.io.out(
      `${ui.ok('This machine now uses the local store.')} Memories already in Oort Cloud stay there; \`oort cloud export\` downloads them.\n`,
    );
    return 0;
  }
  const stars = Object.entries(readAgents(home))
    .filter(([, a]) => a.star)
    .map(([id]) => id);
  if (stars.length > 0) {
    // Oort Cloud has no Stars yet: these agents' new memories would land on the shared Planet.
    throw new Refusal(
      `${stars.join(', ')} ${stars.length === 1 ? 'keeps its' : 'keep their'} memories in a Star, which Oort Cloud does not have yet. Run \`oort connect ${stars[0]} --no-star\`${stars.length > 1 ? ' for each' : ''} first, or stay local.`,
    );
  }
  const client = await clientFor(ctx);
  const me = await client.whoami();
  const lines = await withWired(ctx, async (w) => (await localExport(w, ctx)).lines);
  const local = lines.length;
  const left = local - importedCount(settings.import, lines);
  writeCloudSettings(home, { ...settings, store: 'cloud' });
  ctx.io.out(ui.header('cloud', 'Oort Cloud'));
  ctx.io.out(
    ui.kv([
      ['account', me.account],
      ['plan', me.plan],
      ['store', `Oort Cloud (${client.url}), stored in the EU`],
    ]),
  );
  ctx.io.out(
    `\n${ui.ok('Hooks, MCP and the oort commands now read and save in Oort Cloud.')}\n` +
      (left > 0
        ? `${left} ${left === 1 ? 'memory stays' : 'memories stay'} in the local store until you run \`oort cloud import\`.\n`
        : local > 0
          ? `${local === 1 ? 'The local memory is' : `All ${local} local memories are`} already in Oort Cloud.\n`
          : '') +
      ui.dim('Switch back any time with `oort cloud use --local`.') +
      '\n',
  );
  return 0;
}

/** `oort cloud status [--json]` */
export async function cloudStatusCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const settings = readCloudSettings(w.config.home);
    let account: Record<string, unknown> | { error: string };
    let stats: Record<string, unknown> | undefined;
    try {
      const client = await clientFor(ctx);
      account = (await client.whoami()) as unknown as Record<string, unknown>;
      stats = (await client.stats()) as unknown as Record<string, unknown>;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      account = { error: e.message };
    }
    const out = {
      store: settings.store,
      url: (() => {
        const u = cloudUrl(ctx.io.env);
        return 'url' in u ? u.url : u.error;
      })(),
      account,
      ...(stats !== undefined && { cloud: stats }),
      ...(settings.import !== undefined && { import: settings.import }),
    };
    if (opts.json === true) {
      ctx.io.out(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    const ui = uiFor(ctx.io);
    const acct =
      'error' in account
        ? ui.warn(String(account['error']))
        : `${String(account['account'])} (${String(account['plan'])})`;
    ctx.io.out(ui.header('cloud', settings.store === 'cloud' ? 'Oort Cloud' : 'local store'));
    ctx.io.out(
      ui.kv([
        ['store', settings.store === 'cloud' ? `Oort Cloud (${out.url})` : 'local (this machine)'],
        ['account', acct],
        ...(stats !== undefined
          ? [['cloud memories', String(stats['memories'])] as [string, string]]
          : []),
        ...(settings.import !== undefined
          ? [
              [
                'import',
                settings.import.done < settings.import.total
                  ? ui.warn(
                      `${settings.import.done}/${settings.import.total} uploaded (run \`oort cloud import\` to resume)`,
                    )
                  : ui.ok(`${settings.import.done}/${settings.import.total} uploaded`),
              ] as [string, string],
            ]
          : []),
      ]),
    );
    return 0;
  });
}

/** `oort cloud import [--dry-run] [--yes]`: uploads the local store, resumable and idempotent. */
export async function cloudImportCommand(
  opts: { dryRun?: boolean; yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const ui = uiFor(ctx.io);
    const { manifest, lines, withEmbedding } = await localExport(w, ctx);
    const settings = readCloudSettings(w.config.home);
    const fingerprint = fingerprintOf(lines);
    const resume =
      settings.import?.fingerprint === fingerprint
        ? Math.min(settings.import.done, lines.length)
        : 0;
    const plan = chunks(lines, resume);
    const bytes = lines.slice(resume).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    ctx.io.out(ui.header('cloud import', `${lines.length} local memories`));
    ctx.io.out(
      ui.kv([
        ['to upload', `${lines.length - resume}${resume > 0 ? ` (resuming after ${resume})` : ''}`],
        ['size', `${(bytes / (1024 * 1024)).toFixed(2)} MB in ${plan.length} requests`],
        [
          'embeddings',
          `${withEmbedding} reused; ${lines.length - withEmbedding} re-embedded in the cloud (counted toward your Pro embed use)`,
        ],
      ]),
    );
    if (opts.dryRun === true || lines.length === resume) {
      if (lines.length === resume && lines.length > 0) ctx.io.out('Already uploaded.\n');
      return 0;
    }
    const go = await confirm(
      ctx.io,
      `Upload ${lines.length - resume} memories to Oort Cloud (EU)?`,
      opts.yes === true,
      'upload them',
    );
    if (!go) {
      ctx.io.out('Nothing uploaded.\n');
      return 0;
    }
    const client = w.cloud ?? (await clientFor(ctx));
    const header = JSON.stringify(manifest);
    let done = resume;
    let imported = 0;
    let skipped = 0;
    let reembedded = 0;
    for (const c of plan) {
      const r = await uploadChunk(client, header, c.lines, (inChunk) => {
        done = c.start + inChunk;
        writeCloudSettings(w.config.home, {
          ...readCloudSettings(w.config.home),
          import: { fingerprint, done, total: lines.length, updatedAt: new Date().toISOString() },
        });
      });
      imported += r.imported;
      skipped += r.skipped;
      reembedded += r.reembedded;
      ctx.io.out(
        ui.color
          ? `  ${ui.bar(done, lines.length)} ${ui.dim('uploaded')} ${done}/${lines.length}\n`
          : `  uploaded ${done}/${lines.length}\n`,
      );
    }
    ctx.io.out(
      `${ui.ok('done')}: ${imported} imported, ${skipped} already in the cloud, ${reembedded} re-embedded.\n`,
    );
    if (w.mode !== 'cloud') ctx.io.out('Run `oort cloud use` to start using them.\n');
    return 0;
  });
}

/** `oort cloud export [--out <file>] [--force]`: the whole cloud account in the v1 format. */
export async function cloudExportCommand(
  opts: { out?: string; force?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  let data: string;
  try {
    data = await client.exportText();
  } catch (e) {
    if (e instanceof OortCloudError) throw e;
    throw new Refusal('Oort Cloud export failed; try again.');
  }
  const memories = Math.max(0, data.split('\n').filter((l) => l.length > 0).length - 1);
  if (opts.out === undefined) ctx.io.out(data);
  else {
    const file = path.resolve(ctx.io.cwd, opts.out);
    writeOwnerOnly(file, data, opts.force === true);
    ctx.io.out(`Exported ${memories} memories from Oort Cloud to ${file}\n`);
  }
  return 0;
}
