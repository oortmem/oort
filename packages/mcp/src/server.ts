import { McpServer } from '@modelcontextprotocol/server';
import { VERSION, scrub } from '@oortmem/core';
import { INSTRUCTIONS, TOOLS, inputSchemas, type ToolInput, type ToolName } from './tools.js';

/** One recalled fact, as `recall` returns it. */
export interface RecalledFact {
  id: string;
  text: string;
  type: string;
  tier: string;
  valid_from: string;
  /** When the fact stopped holding; present for a version that is not current (history, as-of). */
  valid_to?: string | null;
  /** A volatile fact nobody confirmed lately: it may be outdated. */
  stale?: true;
  /** Why it matched, e.g. `lexical #1, rerank 0.81`. */
  why: string;
  /** Where it came from: `from your Planet`, `from this agent's Star`. */
  from?: string;
  /** A narrower memory in this result contradicts this one: its id (it ranks first). */
  overridden_by?: string;
}

export interface RecallOutput {
  memories: RecalledFact[];
  /** The time mode the recall used, e.g. `current` or `as-of 2026-04-02`. */
  mode?: string;
  /** A mode was asked for, but the backend reported none (it may not have applied it). */
  mode_unsupported?: true;
  /** True when candidates existed but none answers the question. */
  abstained?: boolean;
  /** A short, user-safe note (degraded recall, missing keys). */
  note?: string;
}

export interface RememberOutcome {
  fact: number;
  outcome: 'added' | 'reinforced' | 'updated' | 'superseded' | 'corrected' | 'skipped';
  id?: string;
  supersedes?: string;
  reason?: string;
}

/**
 * What the MCP tools need from a memory system. The local store (`oort mcp`) implements it
 * today; the Oort Cloud API (CON-76) and the remote connector (CON-42) implement it later.
 * Every method acts inside the scope the backend was built for: no argument can widen it.
 * Throw `MemoryToolError` for a refusal the user should read; anything else is reported as
 * `oort: <message>`.
 */
export interface MemoryBackend {
  recall(input: ToolInput<'recall'>): Promise<RecallOutput>;
  remember(input: ToolInput<'remember'>): Promise<{ results: RememberOutcome[] }>;
  forget(input: ToolInput<'forget'>): Promise<{ forgotten: string }>;
  pin(input: ToolInput<'pin'>): Promise<{ id: string; pinned: boolean; changed: boolean }>;
  explain(input: ToolInput<'explain'>): Promise<Record<string, unknown>>;
  listRecent(input: ToolInput<'list_recent'>): Promise<{ memories: Record<string, unknown>[] }>;
  whoami(input: ToolInput<'whoami'>): Promise<Record<string, unknown>>;
}

/** A refusal whose message is shown to the user as the tool error. */
export class MemoryToolError extends Error {
  override readonly name = 'MemoryToolError';
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * Scrubs every `text` string in a tool result, however deep. Backends already return clean
 * text; this is the last line before anything reaches the host.
 */
function scrubTexts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubTexts);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'text' && typeof v === 'string' ? scrub(v).text : scrubTexts(v),
      ]),
    );
  }
  return value;
}

async function run(
  fn: () => Promise<unknown>,
  isRefusal: (e: unknown) => boolean,
): Promise<ToolResult> {
  try {
    const data = scrubTexts(await fn());
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (e) {
    if (e instanceof MemoryToolError || isRefusal(e)) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    const err = e instanceof Error ? e : new Error(String(e));
    return fail(`oort: ${err.message}`);
  }
}

export interface CreateMcpServerOptions {
  backend: MemoryBackend;
  /** Server version reported to hosts; defaults to @oortmem/core's VERSION. */
  version?: string;
  /** Extra error classes whose messages are user-facing refusals (e.g. the CLI's `Refusal`). */
  isRefusal?: (e: unknown) => boolean;
}

/** A new server with the seven Oort tools over `backend`. Build one per connection. */
export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const b = opts.backend;
  const isRefusal = opts.isRefusal ?? (() => false);
  const server = new McpServer(
    { name: 'oort', title: 'Oort memory', version: opts.version ?? VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const handlers: { [N in ToolName]: (input: ToolInput<N>) => Promise<unknown> } = {
    recall: (i) => b.recall(i),
    remember: (i) => b.remember({ ...i, facts: [...new Set(i.facts)] }),
    forget: (i) => b.forget(i),
    pin: (i) => b.pin(i),
    explain: (i) => b.explain(i),
    list_recent: (i) => b.listRecent(i),
    whoami: (i) => b.whoami(i),
  };
  for (const t of TOOLS) {
    const handler = handlers[t.name] as (input: unknown) => Promise<unknown>;
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: inputSchemas[t.name],
        annotations: t.annotations,
      },
      ((input: unknown) => run(() => handler(input), isRefusal)) as never,
    );
  }
  return server;
}
