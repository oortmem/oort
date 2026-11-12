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
  /** Where it is (CON-84): its place path, when it has one. */
  place?: string;
  /** With `near`: metres from the query point to its region. */
  distance_m?: number;
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
  /** `unknown`: Oort Cloud answered an outcome this version does not know. */
  outcome: 'added' | 'reinforced' | 'updated' | 'superseded' | 'corrected' | 'skipped' | 'unknown';
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
  /**
   * The backend filters by place (CON-84): `recall` offers `within` and `near`, `remember` offers
   * `place`. Without it those arguments are not offered, and stripped if a model sends them.
   */
  readonly spatial?: true;
  recall(input: ToolInput<'recall'>): Promise<RecallOutput>;
  /** `note`: what the person should know, e.g. that a suggested share still needs confirming. */
  remember(input: ToolInput<'remember'>): Promise<{ results: RememberOutcome[]; note?: string }>;
  /**
   * Forgets one memory. A copy shared to a Constellation stays (it is the team's memory): a
   * backend that can tell lists those Constellations in `stillShared` and says in `note` how the
   * person withdraws them. The model never withdraws them itself (CON-67).
   */
  forget(input: { id: string }): Promise<{
    forgotten: string;
    stillShared?: string[];
    /** Later memories that restated it, rewritten without it (CON-144). */
    rewritten?: string[];
    /** Later memories written from it that were left as they were; `note` says what to do. */
    notRewritten?: string[];
    note?: string;
  }>;
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

/**
 * The tool error for `forget` with `everywhere` (CON-67): withdrawing shared copies is the
 * person's confirmed step, like sharing, so the model gets the command to suggest instead.
 */
const everywhereNeedsPerson = (id: string): string =>
  `Withdrawing shared copies needs the person's confirmation. Nothing was forgotten. Ask them to run: oort forget ${commandSafeId(id)} --everywhere`;

/**
 * The id as it may appear in a command the person copies into a shell: the model chose it, so
 * anything but a plain id (letters, digits, hyphens) becomes a placeholder instead of shell text.
 */
const commandSafeId = (id: string): string => (/^[A-Za-z0-9-]{1,64}$/.test(id) ? id : '<id>');

/**
 * The tool error for a spatial argument on a backend without places (CON-84), such as Oort
 * Cloud: refused, never stripped, so the model never believes a recall was filtered by place or
 * a place was stored. The same `local-only` refusal the SDK and the CLI give.
 */
const SPATIAL_LOCAL_ONLY =
  'Places (within, near, place) are local-only for now: this memory does not hold them, so nothing was recalled or saved. Ask the person to use local Oort for them (oort cloud use --local).';

function refuseSpatial(input: unknown, keys: readonly string[], spatial: boolean): void {
  if (spatial) return;
  const i = input as Record<string, unknown>;
  if (keys.some((k) => i[k] !== undefined)) throw new MemoryToolError(SPATIAL_LOCAL_ONLY);
}

/** Only the keys `schema` declares: what a loose schema let through stays here. */
function own<T extends object>(input: T, schema: { shape: object }): T {
  const keys = new Set(Object.keys(schema.shape));
  return Object.fromEntries(Object.entries(input).filter(([k]) => keys.has(k))) as T;
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
  const schemas = inputSchemasFor(spaces, { spatial: b.spatial === true });
  const visibility = new Set(['private', ...spaces.visibility]);
  const server = new McpServer(
    { name: 'oort', title: 'Oort memory', version: opts.version ?? VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  // Zod already limits both to the spaces; these are the second line, so a schema change can't
  // widen what a connection reaches.
  const handlers: { [N in ToolName]: (input: ToolInput<N>) => Promise<unknown> } = {
    recall: (raw) => {
      refuseSpatial(raw, ['within', 'near'], b.spatial === true);
      const i = own(raw, schemas.recall);
      if (i.include === undefined) return b.recall(i);
      const include = i.include.filter((l) => spaces.include.includes(l));
      if (include.length === 0) {
        throw new MemoryToolError('This connection cannot read those levels.');
      }
      return b.recall({ ...i, include });
    },
    remember: (raw) => {
      refuseSpatial(raw, ['place'], b.spatial === true);
      const i = own(raw, schemas.remember);
      return b.remember({
        ...i,
        facts: [...new Set(i.facts)],
        visibility: visibility.has(i.visibility) ? i.visibility : 'private',
      });
    },
    forget: (i) => {
      // Never forget less than was asked: `everywhere` is refused before anything is forgotten,
      // with the command the person runs to confirm it (CON-67).
      const asked = (i as Record<string, unknown>)['everywhere'];
      if (asked !== undefined && asked !== false) {
        throw new MemoryToolError(everywhereNeedsPerson(i.id));
      }
      return b.forget({ id: i.id });
    },
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
