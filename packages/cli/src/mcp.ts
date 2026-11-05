import type { McpServer } from '@modelcontextprotocol/server';
import {
  MemoryToolError,
  createMcpServer,
  type MemoryBackend,
  type ToolSpaces,
} from '@oortmem/mcp';
import { filterFor } from '@oortmem/claude-code';
import { VERSION, activation, isCurrent, scrub, type Memory, localGrant } from '@oortmem/core';
import { supersedeChain } from './commands/inspect.js';
import { timeMode } from './commands/explain.js';
import { runRecall, viewIgnored, type TemporalView } from './commands/recall.js';
import { rememberFacts } from './remember.js';
import { OortCloudError, findCloudMemory, type CloudClient } from './cloud.js';
import {
  Refusal,
  findMemory,
  fixed,
  refuseStarInCloud,
  shapeLinks,
  writeGrantFor,
} from './util.js';
import { privacyStatement, type Wired } from './wire.js';

/**
 * `oort mcp`: the shared Oort tool set (`@oortmem/mcp`) over a local store. One server
 * instance serves one connection; its scope is fixed when it is wired (the directory the host
 * started it in, or `--project`), so no tool argument can reach another project's memories.
 */
export { INSTRUCTIONS, TOOL_NAMES } from '@oortmem/mcp';

const clean = (text: string): string => scrub(text).text;

function status(m: Memory, now: Date): 'current' | 'superseded' | 'expired' | 'not yet valid' {
  if (isCurrent(m, now)) return 'current';
  if (m.endReason === 'superseded') return 'superseded';
  if (m.expiredAt !== null || (m.validTo !== null && Date.parse(m.validTo) <= now.getTime()))
    return 'expired';
  return 'not yet valid';
}

/**
 * The MCP recall arguments as a view. `mode` names it and must come with its own date
 * (`as-of` with `as_of`, `known-at` with `known_at`, `current` and `history` with neither);
 * without `mode`, one date picks the view and none lets the query decide.
 */
function viewOf(
  mode: 'current' | 'as-of' | 'history' | 'known-at' | undefined,
  asOf: string | undefined,
  knownAt: string | undefined,
): TemporalView {
  const iso = (x: string) => new Date(x).toISOString();
  if (asOf !== undefined && knownAt !== undefined) {
    throw new MemoryToolError('Use as_of or known_at, not both.');
  }
  switch (mode) {
    case undefined:
      if (asOf !== undefined) return { mode: 'as-of', asOf: iso(asOf) };
      if (knownAt !== undefined) return { mode: 'known-at', knownAt: iso(knownAt) };
      return {};
    case 'as-of':
      if (asOf === undefined) throw new MemoryToolError('mode "as-of" needs as_of.');
      if (knownAt !== undefined)
        throw new MemoryToolError('mode "as-of" takes as_of, not known_at.');
      return { mode, asOf: iso(asOf) };
    case 'known-at':
      if (knownAt === undefined) throw new MemoryToolError('mode "known-at" needs known_at.');
      return { mode, knownAt: iso(knownAt) };
    case 'current':
    case 'history':
      if (asOf !== undefined || knownAt !== undefined) {
        throw new MemoryToolError(`mode "${mode}" takes no as_of or known_at.`);
      }
      return { mode };
  }
}

export interface OortServerDeps {
  wired: Wired;
  now?: () => Date;
  /** What the tools may reach (default: `localSpaces`); from trusted config, never the model. */
  spaces?: ToolSpaces;
}

/**
 * The spaces of a local server (CON-64): the person's Planet, plus the agent's own Star when an
 * agent is named. A store on this machine has no Constellations, so nothing to share to.
 */
export function localSpaces(w: Wired): ToolSpaces {
  return {
    include: w.agent.source === 'none' ? ['planet'] : ['planet', 'star'],
    visibility: [],
    share: [],
  };
}

/**
 * The spaces of a cloud-mode server, from `/v1/whoami` for this agent: the Planet, plus the
 * Constellations this key and agent may read; `remember` may suggest sharing with the ones it may
 * share to. There is no `share` tool here: `oort share` previews and confirms in the terminal.
 * Any failure falls back to the Planet alone.
 */
export async function cloudSpaces(w: Wired, client: CloudClient): Promise<ToolSpaces> {
  try {
    const me = await client.whoami(w.agent.source === 'none' ? undefined : w.agent.id);
    const hives = (me.spaces ?? []).filter(
      (s): s is Extract<typeof s, { level: 'constellation' }> =>
        s.level === 'constellation' && s.rights.includes('read'),
    );
    return {
      include: hives.length > 0 ? ['planet', 'constellation'] : ['planet'],
      visibility: hives.filter((s) => s.rights.includes('share')).map((s) => s.name),
      share: [],
    };
  } catch {
    return { include: ['planet'], visibility: [], share: [] };
  }
}

/** The local store as an MCP memory backend. */
export function localBackend(deps: OortServerDeps): MemoryBackend {
  const w = deps.wired;
  const now = deps.now ?? (() => new Date());
  const filter = filterFor(w.scope);
  return {
    async recall({ query, as_of, known_at, mode, limit, include }) {
      const view = viewOf(mode, as_of, known_at);
      const result = await runRecall(w, query, view, now(), include);
      const ignored = viewIgnored(view, result);
      if (result.abstained === true) {
        // Candidates were found, but none answers the question: say so rather than hand over noise.
        return {
          memories: [],
          abstained: true,
          note: 'No relevant memories: nothing stored answers this. Answer without memory.',
        };
      }
      const memories = result.memories.slice(0, limit).map((m) => {
        const e = m.explanation;
        const why = [
          e.lexicalRank !== undefined ? `lexical #${e.lexicalRank}` : undefined,
          e.denseRank !== undefined ? `dense #${e.denseRank}` : undefined,
          e.reranked !== undefined ? `rerank ${fixed(e.reranked)}` : undefined,
          m.pinned ? 'pinned' : undefined,
        ].filter((x) => x !== undefined);
        return {
          id: m.id,
          text: clean(m.text),
          type: m.type,
          tier: m.tier,
          valid_from: m.validFrom,
          ...(!isCurrent(m, now()) && { valid_to: m.validTo }),
          ...(e.stale === true && { stale: true as const }),
          why: why.join(', ') || (e.chain === true ? 'history chain' : 'activation'),
          ...(m.origin !== undefined && { from: m.origin.from }),
          ...(m.origin?.overriddenBy !== undefined && {
            overridden_by: m.origin.overriddenBy.id,
          }),
        };
      });
      const lexicalOnly = w.mode !== 'cloud' && (w.embed === undefined || w.rerank === undefined);
      const refused = w.relayErrors?.at(-1);
      return {
        memories,
        mode: timeMode(result.temporal),
        ...(refused !== undefined
          ? { note: `recall degraded: ${refused.message}` }
          : lexicalOnly && {
              note: 'lexical-only recall: no Voyage key (run `oort keys set voyage`, or `oort login` for Oort Pro).',
            }),
        // Last, so a store that ignored the requested time mode is the note the agent reads.
        ...(ignored && {
          mode_unsupported: true as const,
          note: `This memory store did not report the time mode, so "${view.mode}" may not have been applied: these may be current facts.`,
        }),
      };
    },

    async remember({ facts, type }) {
      const results = await rememberFacts(w, facts, {
        harness: 'mcp',
        now: now(),
        ...(type !== undefined && { type }),
      });
      return { results };
    },

    async forget({ id }) {
      const m = await findMemory(w.store, filter, id);
      await w.store.forget(writeGrantFor(w, m), m.id);
      return { forgotten: m.id };
    },

    async pin({ id, pinned }) {
      const m = await findMemory(w.store, filter, id);
      if (m.pinned === pinned) return { id: m.id, pinned, changed: false };
      await w.store.upsert(writeGrantFor(w, m), { ...m, pinned, updatedAt: now().toISOString() });
      return { id: m.id, pinned, changed: true };
    },

    async explain({ id }) {
      const at = now();
      // Shaped: a contradiction naming a memory this agent cannot read (another Star) is dropped.
      const raw = await findMemory(w.store, filter, id);
      const m = await shapeLinks(w.store, filter, raw);
      const { links, hidden } = await supersedeChain(w.store, raw, filter);
      return {
        memory: {
          id: m.id,
          text: clean(m.text),
          type: m.type,
          tier: m.tier,
          pinned: m.pinned,
          status: status(m, at),
          valid_from: m.validFrom,
          valid_to: m.validTo,
          salience: m.salience,
          activation: Number(fixed(activation(m.accessLog, m.salience, at, w.config.activation))),
          source: m.source.harness,
          created_at: m.createdAt,
        },
        decisions: m.source.decisions,
        chain: links.map((l) => ({
          id: l.id,
          text: clean(l.text),
          valid_from: l.validFrom,
          valid_to: l.validTo,
          end_reason: l.endReason,
        })),
        ...(hidden > 0 && { hidden_links: hidden }),
      };
    },

    async listRecent({ since, limit }) {
      const at = now();
      const from = since === undefined ? -Infinity : Date.parse(since);
      const all = await w.store.list(localGrant(filter), { validOnly: false });
      const memories = all
        .filter((m) => Date.parse(m.updatedAt) >= from)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          text: clean(m.text),
          type: m.type,
          tier: m.tier,
          status: status(m, at),
          valid_from: m.validFrom,
          updated_at: m.updatedAt,
        }));
      return { memories };
    },

    async whoami() {
      return {
        mode: 'local',
        account: null,
        note: 'Memories stay on this machine; there is no Oort account in local mode.',
        project: w.scope.projectId ?? null,
        scope: w.scope.projectId === undefined ? 'global' : 'project, plus global memories',
        // A named agent reads the person's Planet and its own Star; new memories land in
        // `writes_to`. With no --agent (an entry from before agents) it is anonymous: Planet only.
        agent: w.agent.source === 'none' ? null : w.agent.id,
        reads: w.agent.source === 'none' ? ['your Planet'] : ['your Planet', `Star ${w.agent.id}`],
        spaces: w.agent.source === 'none' ? ['your Planet'] : ['your Planet', `Star ${w.agent.id}`],
        writes_to: w.agent.home === 'star' ? `Star ${w.agent.id}` : 'your Planet',
        version: VERSION,
        adapters: {
          embed: w.embed !== undefined,
          rerank: w.rerank !== undefined,
          decide: w.decide !== undefined,
          write: w.write !== undefined,
        },
        // Per role: `oort-pro` (through the relay), `own-key` or `missing`. Never a key.
        keys: Object.fromEntries(
          Object.values(w.routes ?? {}).map((r) => [
            r.role,
            r.via === 'oort' ? 'oort-pro' : r.via === 'vendor' ? 'own-key' : 'missing',
          ]),
        ),
      };
    },
  };
}

/**
 * Oort Cloud as an MCP memory backend: the same seven tools, answered by the API for this
 * machine's project (plus account-wide memories). Recall goes through `runRecall`, which already
 * calls the cloud in cloud mode.
 */
export function cloudBackend(deps: OortServerDeps & { client: CloudClient }): MemoryBackend {
  const w = deps.wired;
  const client = deps.client;
  const now = deps.now ?? (() => new Date());
  const project = w.scope.projectId;
  const local = localBackend(deps);
  return {
    recall: local.recall,

    async remember({ facts, type, visibility }) {
      refuseStarInCloud(w);
      // The same turn the local engine observes for a fact, sent to the cloud's write path.
      const hint = type === undefined ? '' : ` (a ${type} fact)`;
      const results = [];
      for (const [i, fact] of facts.entries()) {
        const r = await client.observe({
          ...(project !== undefined && { project, ...privacyStatement(w) }),
          observation: {
            user: `Remember this${hint}: ${fact}`,
            assistant: `Noted: ${fact}`,
            at: now().toISOString(),
          },
        });
        const first = r.memories[0];
        results.push({
          fact: i,
          outcome: r.outcome as 'added',
          ...(first?.id !== undefined && { id: first.id }),
          ...(r.outcome === 'skipped' && { reason: 'not durable' }),
        });
      }
      // No proposals yet (hive slice 9): a fact meant for a Constellation is saved privately, and
      // sharing it stays the person's confirmed step.
      if (visibility !== 'private') {
        const id = results.find((x) => x.id !== undefined)?.id ?? '<id>';
        return {
          results,
          note: `Saved privately to your Planet. Sharing it with ${visibility} needs the person's confirmation: \`oort share ${id} --to ${visibility}\`.`,
        };
      }
      return { results };
    },

    async forget({ id }) {
      refuseStarInCloud(w);
      const m = await findCloudMemory(client, id);
      await client.forget(m.id);
      return { forgotten: m.id };
    },

    async pin({ id, pinned }) {
      refuseStarInCloud(w);
      const m = await findCloudMemory(client, id);
      if (m.pinned === pinned) return { id: m.id, pinned, changed: false };
      await client.pin(m.id, pinned);
      return { id: m.id, pinned, changed: true };
    },

    async explain({ id }) {
      const at = now();
      const m = (await findCloudMemory(client, id)) as Memory;
      const chain: Record<string, unknown>[] = [];
      let hidden = 0;
      for (const linkId of [m.supersedes, m.supersededBy]) {
        if (linkId === null) continue;
        try {
          const l = await client.get(linkId);
          chain.push({
            id: l.id,
            text: clean(l.text),
            valid_from: l.validFrom,
            valid_to: l.validTo,
            end_reason: l.endReason,
          });
        } catch (e) {
          if (e instanceof OortCloudError && e.kind === 'not-found') hidden++;
          else throw e;
        }
      }
      return {
        memory: {
          id: m.id,
          text: clean(m.text),
          type: m.type,
          tier: m.tier,
          pinned: m.pinned,
          status: status(m, at),
          valid_from: m.validFrom,
          valid_to: m.validTo,
          salience: m.salience,
          activation: Number(fixed(activation(m.accessLog, m.salience, at, w.config.activation))),
          source: m.source.harness,
          created_at: m.createdAt,
        },
        decisions: m.source.decisions,
        chain,
        ...(hidden > 0 && { hidden_links: hidden }),
      };
    },

    async listRecent({ since, limit }) {
      const at = now();
      const from = since === undefined ? -Infinity : Date.parse(since);
      const r = await client.list({ ...(project !== undefined && { project }), limit: 100 });
      const memories = (r.memories as Memory[])
        .filter((m) => Date.parse(m.updatedAt) >= from)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          text: clean(m.text),
          type: m.type,
          tier: m.tier,
          status: status(m, at),
          valid_from: m.validFrom,
          updated_at: m.updatedAt,
        }));
      return { memories };
    },

    async whoami() {
      const agent = w.agent.source === 'none' ? undefined : w.agent.id;
      const me = await client.whoami(agent);
      return {
        mode: 'cloud',
        account: me.account,
        plan: me.plan,
        note: 'Memories live in Oort Cloud (EU) for this account.',
        project: project ?? null,
        scope: project === undefined ? 'global' : 'project, plus global memories',
        agent: agent ?? null,
        spaces: (me.spaces ?? [{ level: 'planet' }]).map((s) =>
          s.level === 'planet'
            ? 'your Planet'
            : `Constellation ${s.name} (${s.role}: ${s.rights.join(', ')})`,
        ),
        version: VERSION,
      };
    },
  };
}

/** A new server instance with the seven tools; `serveStdio` calls this once per connection. */
export function createOortServer(deps: OortServerDeps): McpServer {
  const w = deps.wired;
  if (w.mode === 'cloud' && w.cloud === undefined) {
    throw new Refusal(w.cloudProblem ?? 'Oort Cloud is not set up.');
  }
  return createMcpServer({
    backend:
      w.mode === 'cloud' && w.cloud !== undefined
        ? cloudBackend({ ...deps, client: w.cloud })
        : localBackend(deps),
    spaces: deps.spaces ?? localSpaces(w),
    version: VERSION,
    isRefusal: (e) => e instanceof Refusal,
  });
}
