import type { McpServer } from '@modelcontextprotocol/server';
import { createMcpServer, type MemoryBackend } from '@oortmem/mcp';
import { filterFor, grantFor } from '@oortmem/claude-code';
import { VERSION, activation, isCurrent, scrub, type Memory, localGrant } from '@oortmem/core';
import { supersedeChain } from './commands/inspect.js';
import { runRecall } from './commands/recall.js';
import { rememberFacts } from './remember.js';
import { OortCloudError, findCloudMemory, type CloudClient } from './cloud.js';
import { Refusal, findMemory, fixed } from './util.js';
import type { Wired } from './wire.js';

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

export interface OortServerDeps {
  wired: Wired;
  now?: () => Date;
}

/** The local store as an MCP memory backend. */
export function localBackend(deps: OortServerDeps): MemoryBackend {
  const w = deps.wired;
  const now = deps.now ?? (() => new Date());
  const filter = filterFor(w.scope);
  return {
    async recall({ query, as_of, limit }) {
      const result = await runRecall(w, query, as_of, now());
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
          why: why.join(', ') || 'activation',
        };
      });
      const lexicalOnly = w.mode !== 'cloud' && (w.embed === undefined || w.rerank === undefined);
      const refused = w.relayErrors?.at(-1);
      return {
        memories,
        ...(refused !== undefined
          ? { note: `recall degraded: ${refused.message}` }
          : lexicalOnly && {
              note: 'lexical-only recall: no Voyage key (run `oort keys set voyage`, or `oort login` for Oort Pro).',
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
      await w.store.forget(grantFor(w.scope), m.id);
      return { forgotten: m.id };
    },

    async pin({ id, pinned }) {
      const m = await findMemory(w.store, filter, id);
      if (m.pinned === pinned) return { id: m.id, pinned, changed: false };
      await w.store.upsert(grantFor(w.scope), { ...m, pinned, updatedAt: now().toISOString() });
      return { id: m.id, pinned, changed: true };
    },

    async explain({ id }) {
      const at = now();
      const m = await findMemory(w.store, filter, id);
      const { links, hidden } = await supersedeChain(w.store, m, filter);
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

    async remember({ facts, type }) {
      // The same turn the local engine observes for a fact, sent to the cloud's write path.
      const hint = type === undefined ? '' : ` (a ${type} fact)`;
      const results = [];
      for (const [i, fact] of facts.entries()) {
        const r = await client.observe({
          ...(project !== undefined && { project }),
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
      return { results };
    },

    async forget({ id }) {
      const m = await findCloudMemory(client, id, project);
      await client.forget(m.id);
      return { forgotten: m.id };
    },

    async pin({ id, pinned }) {
      const m = await findCloudMemory(client, id, project);
      if (m.pinned === pinned) return { id: m.id, pinned, changed: false };
      await client.pin(m.id, pinned);
      return { id: m.id, pinned, changed: true };
    },

    async explain({ id }) {
      const at = now();
      const m = (await findCloudMemory(client, id, project)) as Memory;
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
      const me = await client.whoami();
      return {
        mode: 'cloud',
        account: me.account,
        plan: me.plan,
        note: 'Memories live in Oort Cloud (EU) for this account.',
        project: project ?? null,
        scope: project === undefined ? 'global' : 'project, plus global memories',
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
    version: VERSION,
    isRefusal: (e) => e instanceof Refusal,
  });
}
