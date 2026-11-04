import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { filterFor } from '@oortmem/claude-code';
import { VERSION, activation, isCurrent, scrub, type Memory } from '@oortmem/core';
import { supersedeChain } from './commands/inspect.js';
import { runRecall } from './commands/recall.js';
import { FACT_MAX_CHARS, REMEMBER_MAX_FACTS, rememberFacts } from './remember.js';
import { Refusal, findMemory, fixed } from './util.js';
import type { Wired } from './wire.js';

/**
 * `oort mcp`: the connectors note's D2 tool set over a local store. One server
 * instance serves one connection; its scope is fixed when it is wired (the
 * directory the host started it in, or `--project`), so no tool argument can
 * reach another project's memories.
 */

export const TOOL_NAMES = [
  'recall',
  'remember',
  'forget',
  'pin',
  'explain',
  'list_recent',
  'whoami',
] as const;

/** The first paragraph stands alone (hosts may keep only the first 512 characters). */
export const INSTRUCTIONS = [
  "Oort is the user's own long-term memory, which they connected on purpose. `recall` searches facts the user chose to keep from earlier sessions: decisions, preferences, project details. Use it when the user refers to earlier work, or when their past context would change the answer; skip it for self-contained questions. Use `remember` only for durable facts the user stated or confirmed, one standalone sentence each, never secrets or credentials. `forget` deletes permanently.",
  'Memories belong to the project directory this server was started in, plus global ones. `recall` returns only facts that are current; pass `as_of` to ask what was true at an earlier time. A newer fact can supersede an older one: the older one stays visible to `explain` but stops being recalled. Batch the facts of one decision into a single `remember` call. Ids from `recall` and `list_recent` feed `forget`, `pin` and `explain`.',
].join('\n\n');

const Id = z.string().trim().min(1).max(64).describe('A memory id from recall or list_recent');
const IsoTime = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .describe('An ISO 8601 date or date-time');

const Fact = z
  .string()
  .trim()
  .min(1)
  .max(FACT_MAX_CHARS)
  .regex(/^[^\r\n]*$/, 'one line per fact')
  .describe('One standalone claim, true without the conversation around it');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Runs a tool body; a refusal or failure becomes a tool error with its message only. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Refusal) return fail(e.message);
    const err = e instanceof Error ? e : new Error(String(e));
    return fail(`oort: ${err.message}`);
  }
}

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

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** A new server instance with the seven tools; `serveStdio` calls this once per connection. */
export function createOortServer(deps: OortServerDeps): McpServer {
  const w = deps.wired;
  const now = deps.now ?? (() => new Date());
  const filter = filterFor(w.scope);
  const server = new McpServer(
    { name: 'oort', title: 'Oort memory', version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description:
        "Search the user's saved memories for facts relevant to a question. Returns up to 10 current facts with their date and why each matched.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe('What to look for, in plain words'),
        as_of: IsoTime.optional().describe('Recall what was true at this time instead of now'),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      annotations: { title: 'Recall memories', ...READ },
    },
    ({ query, as_of, limit }) =>
      guard(async () => {
        const result = await runRecall(w, query, as_of, now());
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
        const lexicalOnly = w.embed === undefined || w.rerank === undefined;
        const refused = w.relayErrors?.at(-1);
        if (result.abstained === true) {
          // Candidates were found, but none answers the question: say so rather than hand over noise.
          return ok({
            memories: [],
            abstained: true,
            note: 'No relevant memories: nothing stored answers this. Answer without memory.',
          });
        }
        return ok({
          memories,
          ...(refused !== undefined
            ? { note: `recall degraded: ${refused.message}` }
            : lexicalOnly && {
                note: 'lexical-only recall: no Voyage key (run `oort keys set voyage`, or `oort login` for Oort Pro).',
              }),
        });
      }),
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember facts',
      description:
        'Save one to five self-contained facts the user stated or confirmed. Oort skips secrets and dedupes, reinforces or supersedes older facts.',
      inputSchema: z.object({
        facts: z.array(Fact).min(1).max(REMEMBER_MAX_FACTS),
        type: z
          .enum(['semantic', 'episodic', 'procedural', 'preference'])
          .optional()
          .describe('A hint for the kind of fact; Oort decides the final type'),
      }),
      annotations: {
        title: 'Remember facts',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ facts, type }) =>
      guard(async () => {
        const unique = [...new Set(facts)];
        const results = await rememberFacts(w, unique, {
          harness: 'mcp',
          now: now(),
          ...(type !== undefined && { type }),
        });
        return ok({ results });
      }),
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget a memory',
      description: 'Permanently delete one memory by id, everywhere it is stored.',
      inputSchema: z.object({ id: Id }),
      annotations: {
        title: 'Forget a memory',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) =>
      guard(async () => {
        const m = await findMemory(w.store, filter, id);
        await w.store.forget(m.id);
        return ok({ forgotten: m.id });
      }),
  );

  server.registerTool(
    'pin',
    {
      title: 'Pin or unpin a memory',
      description: 'Keep a memory always available (never moved to cold storage), or release it.',
      inputSchema: z.object({ id: Id, pinned: z.boolean() }),
      annotations: {
        title: 'Pin or unpin a memory',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, pinned }) =>
      guard(async () => {
        const m = await findMemory(w.store, filter, id);
        if (m.pinned === pinned) return ok({ id: m.id, pinned, changed: false });
        await w.store.upsert({ ...m, pinned, updatedAt: now().toISOString() });
        return ok({ id: m.id, pinned, changed: true });
      }),
  );

  server.registerTool(
    'explain',
    {
      title: 'Explain a memory',
      description:
        'Show why a memory was stored: its source, the decisions behind it, and what it superseded.',
      inputSchema: z.object({ id: Id }),
      annotations: { title: 'Explain a memory', ...READ },
    },
    ({ id }) =>
      guard(async () => {
        const at = now();
        const m = await findMemory(w.store, filter, id);
        const { links, hidden } = await supersedeChain(w.store, m, filter);
        return ok({
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
        });
      }),
  );

  server.registerTool(
    'list_recent',
    {
      title: 'Recent memories',
      description: 'List memories saved or changed recently, newest first.',
      inputSchema: z.object({
        since: IsoTime.optional().describe('Only memories changed at or after this time'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { title: 'Recent memories', ...READ },
    },
    ({ since, limit }) =>
      guard(async () => {
        const at = now();
        const from = since === undefined ? -Infinity : Date.parse(since);
        const all = await w.store.list(filter, { validOnly: false });
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
        return ok({ memories });
      }),
  );

  server.registerTool(
    'whoami',
    {
      title: 'Oort account',
      description:
        'Describe this Oort connection: local mode, the project scope, and which adapters are available.',
      inputSchema: z.object({}),
      annotations: { title: 'Oort account', ...READ },
    },
    () =>
      guard(async () =>
        ok({
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
        }),
      ),
  );

  return server;
}
