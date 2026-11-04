import * as path from 'node:path';
import { filterFor } from '@oortmem/claude-code';
import { localGrant, type Grant, type Memory, type MemoryStore, type Scope } from '@oortmem/core';
import { shapeLinks, toJson, withWired, writeOwnerOnly, type Ctx } from '../util.js';

/** Version of the export format documented in docs/export-format.md. */
export const EXPORT_VERSION = 1;

export interface ExportManifest {
  oort: 'export';
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  memories: number;
  scopes: Scope[];
}

/** A cold memory's main record has only its stub indexed; the cold copy holds the full text and embedding. */
async function decoded(m: Memory, store: MemoryStore, grant: Grant, ctx: Ctx): Promise<Memory> {
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

const scopeKey = (s: Scope): string => JSON.stringify(Object.entries(s).sort());

/**
 * `oort export [--out <file>]`: the v1 export format, a manifest line and one
 * JSON line per memory (every tier and validity state) visible from the cwd.
 */
export async function exportCommand(
  opts: { out?: string; force?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const filter = filterFor(w.scope);
    const grant = localGrant(filter);
    const listed = await w.store.list(grant, { validOnly: false });
    // Oldest first, so an importer replays supersede chains in order.
    listed.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1),
    );
    const memories: Memory[] = [];
    for (const m of listed) {
      memories.push(await shapeLinks(w.store, filter, await decoded(m, w.store, grant, ctx)));
    }
    const scopes = new Map<string, Scope>();
    for (const m of memories) scopes.set(scopeKey(m.scope), m.scope);
    const manifest: ExportManifest = {
      oort: 'export',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      memories: memories.length,
      scopes: [...scopes.values()],
    };
    const data = [manifest, ...memories.map(toJson)].map((x) => `${JSON.stringify(x)}\n`).join('');
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
