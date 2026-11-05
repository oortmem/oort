import * as path from 'node:path';
import { HOSTS } from '../connectors.js';
import type { Wired } from '../wire.js';
import {
  EXPORT_FORMAT_VERSION,
  fitsVersion1,
  formatExport,
  nodeGrant,
  planetNode,
  readAgents,
  starNode,
  type ExportManifestV1,
  type NodePattern,
  type ExportVersion,
  type Grant,
  type Memory,
  type MemoryStore,
  type Scope,
} from '@oortmem/core';
import {
  echo,
  cloudOf,
  Refusal,
  shapeLinks,
  withWired,
  writeOwnerOnly,
  type Ctx,
} from '../util.js';

/** Version of the export format `oort export` writes (docs/export-format.md). */
export const EXPORT_VERSION = EXPORT_FORMAT_VERSION;

/**
 * The version 1 manifest. `oort cloud import` still uploads version 1, which
 * Oort Cloud reads; a local store holds Planet memories only, so nothing is lost.
 */
export type ExportManifest = ExportManifestV1;

/** `--format`: 2 (the default) or 1, for readers that do not know version 2 yet. */
export function exportVersion(raw: string | undefined): ExportVersion {
  if (raw === undefined || raw === '2') return 2;
  if (raw === '1') return 1;
  throw new Refusal(`--format ${echo(raw)} must be 1 or 2.`);
}

/** A cold memory's main record has only its stub indexed; the cold copy holds the full text and embedding. */
export async function decoded(
  m: Memory,
  store: MemoryStore,
  grant: Grant,
  ctx: Ctx,
): Promise<Memory> {
  if (m.tier !== 'cold') return m;
  let blob: Memory | null;
  try {
    blob = await store.coldGet(grant, m.id);
  } catch (e) {
    // One unreadable blob must not block a backup: export what the main record holds.
    ctx.io.err(
      `oort: cold copy of ${m.id} is unreadable (${(e as Error).name}); exported its stub only.\n`,
    );
    return m;
  }
  if (blob === null) return m;
  const { embedding: _none, ...live } = m;
  return {
    ...live,
    text: blob.text,
    stub: blob.stub,
    entities: blob.entities,
    ...(blob.embedding !== undefined && { embedding: blob.embedding }),
  };
}

export const scopeKey = (s: Scope): string => JSON.stringify(Object.entries(s).sort());

/**
 * What `oort export` reads, in the cwd's project plus global memories. Version 2 is a backup of
 * everything the person owns: their Planet and the Star of every agent this machine knows (each
 * host, every agent in agents.json, and the acting one), read-only. Version 1 holds Planet
 * memories only, so it reads the Planet alone.
 */
export function exportGrant(w: Wired, version: ExportVersion): Grant {
  const { orgId, customerId, agentId, projectId } = w.scope;
  const projectIds = [...new Set([projectId ?? null, null])];
  const planet: NodePattern = { node: planetNode({ orgId, customerId }), projectIds };
  const agents =
    version === 1
      ? []
      : [
          ...new Set([
            ...HOSTS,
            ...Object.keys(readAgents(w.config.home)),
            ...(w.agent.source === 'none' ? [] : [w.agent.id]),
          ]),
        ];
  return nodeGrant({
    principal: { orgId, customerId, agentId },
    read: [planet, ...agents.map((a) => ({ node: starNode({ orgId, agentId: a }), projectIds }))],
    write: [],
  });
}

/**
 * `oort export [--out <file>] [--format 1|2]`: a manifest line and one JSON
 * line per memory (every tier and validity state) visible from the cwd, in
 * format version 2 unless `--format 1` asks for the old one.
 */
export async function exportCommand(
  opts: { out?: string; force?: boolean; format?: string },
  ctx: Ctx,
): Promise<number> {
  const version = exportVersion(opts.format);
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud !== undefined) {
      // The whole account, in the same v1 format: `oort cloud export` is how you leave the cloud.
      const data = await cloud.exportText();
      const memories = Math.max(0, data.split('\n').filter((l) => l.length > 0).length - 1);
      if (opts.out === undefined) ctx.io.out(data);
      else {
        const file = path.resolve(ctx.io.cwd, opts.out);
        writeOwnerOnly(file, data, opts.force === true);
        ctx.io.out(`Exported ${memories} memories from Oort Cloud to ${file}\n`);
      }
      return 0;
    }
    const grant = exportGrant(w, version);
    const listed = await w.store.list(grant, { validOnly: false });
    // Oldest first, so an importer replays supersede chains in order.
    listed.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1),
    );
    const memories: Memory[] = [];
    for (const m of listed) {
      memories.push(await shapeLinks(w.store, grant, await decoded(m, w.store, grant, ctx)));
    }
    if (version === 1 && !memories.every(fitsVersion1)) {
      throw new Refusal(
        'these memories include some outside your Planet, which format 1 cannot hold; use --format 2.',
      );
    }
    const data = formatExport(memories, version);
    if (opts.out === undefined) {
      ctx.io.out(data);
    } else {
      const file = path.resolve(ctx.io.cwd, opts.out);
      writeOwnerOnly(file, data, opts.force === true);
      ctx.io.out(`Exported ${memories.length} memories to ${file}\n`);
    }
    return 0;
  });
}
