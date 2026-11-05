import { McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import { VERSION, scrub } from '@oortmem/core';
import {
  INSTRUCTIONS,
  PLANET_ONLY,
  TOOLS,
  inputSchemasFor,
  type ToolInput,
  type ToolName,
  type ToolSpaces,
} from './tools.js';
import { attachWidgets } from './ui.js';

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
  /** `note`: what the person should know, e.g. that a suggested share still needs confirming. */
  remember(input: ToolInput<'remember'>): Promise<{ results: RememberOutcome[]; note?: string }>;
  forget(input: ToolInput<'forget'>): Promise<{ forgotten: string }>;
  pin(input: ToolInput<'pin'>): Promise<{ id: string; pinned: boolean; changed: boolean }>;
  explain(input: ToolInput<'explain'>): Promise<Record<string, unknown>>;
  listRecent(input: ToolInput<'list_recent'>): Promise<{ memories: Record<string, unknown>[] }>;
  whoami(input: ToolInput<'whoami'>): Promise<Record<string, unknown>>;
  /**
   * Copies one memory into a Constellation (CON-64). Optional: a server offers the `share` tool
   * only when the backend has it and the connection's spaces name somewhere to share to. A backend
   * must refuse (MemoryToolError) rather than share text a person has not been shown when the
   * text holds personal data.
   */
  share?(input: ToolInput<'share'>): Promise<ShareOutcome>;
  /**
   * Judgment memory (CON-71). Optional: a server offers `record_judgment` and `judge` only when
   * the backend has them. `judge` must label a prediction as one and cite its precedents.
   */
  recordJudgment?(input: ToolInput<'record_judgment'>): Promise<Record<string, unknown>>;
  judge?(input: ToolInput<'judge'>): Promise<Record<string, unknown>>;
}

/** What `share` returns. */
export interface ShareOutcome {
  shared: boolean;
  /** The Constellation, as people name it. */
  constellation: string;
  /** The shared copy's id. */
  id?: string;
  /** Exactly the text that was shared (secrets redacted). */
  text: string;
  note?: string;
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
  /**
   * Offer the in-chat widgets (MCP Apps) to hosts that render them: a recall card, and a memory
   * card for explain and remember. Tool results are the same either way. Default true.
   */
  widgets?: boolean;
  /**
   * What this connection may reach, from trusted configuration (never from the model): the
   * levels `recall` may include, where `remember` may suggest sharing, and where `share` may
   * copy to. Default: the Planet alone, and no `share` tool.
   */
  spaces?: ToolSpaces;
}

/**
 * A new server with the Oort tools over `backend` (`share` only where `spaces` allow it), plus the widget resources for hosts that
 * render MCP Apps. Build one per connection (or per request, for stateless HTTP).
 */
export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const b = opts.backend;
  const isRefusal = opts.isRefusal ?? (() => false);
  const spaces = opts.spaces ?? PLANET_ONLY;
  const schemas = inputSchemasFor(spaces);
  const visibility = new Set(['private', ...spaces.visibility]);
  const server = new McpServer(
    { name: 'oort', title: 'Oort memory', version: opts.version ?? VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  // Zod already limits both to the spaces; these are the second line, so a schema change can't
  // widen what a connection reaches.
  const handlers: { [N in ToolName]: (input: ToolInput<N>) => Promise<unknown> } = {
    recall: (i) => {
      if (i.include === undefined) return b.recall(i);
      const include = i.include.filter((l) => spaces.include.includes(l));
      if (include.length === 0) {
        throw new MemoryToolError('This connection cannot read those levels.');
      }
      return b.recall({ ...i, include });
    },
    remember: (i) =>
      b.remember({
        ...i,
        facts: [...new Set(i.facts)],
        visibility: visibility.has(i.visibility) ? i.visibility : 'private',
      }),
    forget: (i) => b.forget(i),
    pin: (i) => b.pin(i),
    explain: (i) => b.explain(i),
    list_recent: (i) => b.listRecent(i),
    whoami: (i) => b.whoami(i),
    share: (i) => {
      if (b.share === undefined || !spaces.share.includes(i.to)) {
        throw new MemoryToolError('This connection cannot share there.');
      }
      return b.share(i);
    },
    record_judgment: (i) => {
      if (b.recordJudgment === undefined) throw new MemoryToolError('No judgment memory here.');
      return b.recordJudgment(i);
    },
    judge: (i) => {
      if (b.judge === undefined) throw new MemoryToolError('No judgment memory here.');
      return b.judge(i);
    },
  };
  const offered = (name: ToolName): boolean => {
    if (name === 'share') return spaces.share.length > 0 && b.share !== undefined;
    if (name === 'record_judgment') return b.recordJudgment !== undefined;
    if (name === 'judge') return b.judge !== undefined;
    return true;
  };
  const registered = new Map<ToolName, RegisteredTool>();
  for (const t of TOOLS) {
    if (!offered(t.name)) continue;
    const handler = handlers[t.name] as (input: unknown) => Promise<unknown>;
    const tool = server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: schemas[t.name],
        annotations: t.annotations,
      },
      ((input: unknown) => run(() => handler(input), isRefusal)) as never,
    );
    registered.set(t.name, tool);
  }
  if (opts.widgets !== false) attachWidgets(server, registered);
  return server;
}
