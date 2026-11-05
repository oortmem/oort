import { z } from 'zod';

/**
 * The connectors note's D2 tool set, defined once. The local `oort mcp` server and the remote
 * connector (CON-42) both serve these exact names, schemas and annotations.
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
export type ToolName = (typeof TOOL_NAMES)[number];

/** `remember` takes at most this many facts per call: distilled facts, never a transcript. */
export const REMEMBER_MAX_FACTS = 5;
/** And each fact at most this many characters. */
export const FACT_MAX_CHARS = 500;

/** The first paragraph stands alone (hosts may keep only the first 512 characters). */
export const INSTRUCTIONS = [
  "Oort is the user's own long-term memory, which they connected on purpose. `recall` searches facts the user chose to keep from earlier sessions: decisions, preferences, project details. Use it when the user refers to earlier work, or when their past context would change the answer; skip it for self-contained questions. Use `remember` only for durable facts the user stated or confirmed, one standalone sentence each, never secrets or credentials. `forget` deletes permanently.",
  'Memories are scoped to this connection: a local server reads the project directory it was started in plus global memories, a remote connection reads the signed-in account; `whoami` says which. `recall` returns facts that are current; pass `as_of` for what was true at an earlier time, `mode: "history"` for every version of a fact, or `known_at` for what was believed then. Without them Oort reads the mode from the query, and the result says which it used. A newer fact can supersede an older one: the older one stays visible to `explain` and history. A fact marked stale may be outdated; confirm it with the user. Batch the facts of one decision into a single `remember` call. Ids from `recall` and `list_recent` feed `forget`, `pin` and `explain`.',
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

export const MEMORY_TYPES = ['semantic', 'episodic', 'procedural', 'preference'] as const;

/** The temporal views `recall` reads (CON-34). */
export const RECALL_MODES = ['current', 'as-of', 'history', 'known-at'] as const;

export const inputSchemas = {
  recall: z.object({
    query: z.string().trim().min(1).max(500).describe('What to look for, in plain words'),
    as_of: IsoTime.optional().describe('Recall what was true at this time instead of now'),
    known_at: IsoTime.optional().describe(
      'Recall what was believed at this time, including facts corrected since',
    ),
    mode: z
      .enum(RECALL_MODES)
      .optional()
      .describe(
        'current, as-of (requires as_of), history (every version, oldest first) or known-at (requires known_at). Omit it to let Oort read the mode from the query.',
      ),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  remember: z.object({
    facts: z.array(Fact).min(1).max(REMEMBER_MAX_FACTS),
    type: z
      .enum(MEMORY_TYPES)
      .optional()
      .describe('A hint for the kind of fact; Oort decides the final type'),
  }),
  forget: z.object({ id: Id }),
  pin: z.object({ id: Id, pinned: z.boolean() }),
  explain: z.object({ id: Id }),
  list_recent: z.object({
    since: IsoTime.optional().describe('Only memories changed at or after this time'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  whoami: z.object({}),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolInput<N extends ToolName> = z.output<(typeof inputSchemas)[N]>;

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const read = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  annotations: ToolAnnotations;
}

/** Name, title, description and annotations of every tool, in TOOL_NAMES order. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'recall',
    title: 'Recall memories',
    description:
      "Search the user's saved memories for facts relevant to a question. Returns up to 10 facts with their dates, why each matched, and the time mode used.",
    annotations: read('Recall memories'),
  },
  {
    name: 'remember',
    title: 'Remember facts',
    description:
      'Save one to five self-contained facts the user stated or confirmed. Oort skips secrets and dedupes, reinforces or supersedes older facts; a superseded fact stays in history.',
    annotations: {
      title: 'Remember facts',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'forget',
    title: 'Forget a memory',
    description: 'Permanently delete one memory by id, everywhere it is stored.',
    annotations: {
      title: 'Forget a memory',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'pin',
    title: 'Pin or unpin a memory',
    description: 'Keep a memory always available (never moved to cold storage), or release it.',
    annotations: {
      title: 'Pin or unpin a memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'explain',
    title: 'Explain a memory',
    description:
      'Show why a memory was stored: its source, the decisions behind it, and what it superseded.',
    annotations: read('Explain a memory'),
  },
  {
    name: 'list_recent',
    title: 'Recent memories',
    description: 'List memories saved or changed recently, newest first.',
    annotations: read('Recent memories'),
  },
  {
    name: 'whoami',
    title: 'Oort account',
    description:
      'Describe this Oort connection: local or cloud mode, the scope, and which services are available.',
    annotations: read('Oort account'),
  },
];

/** The JSON Schema of every tool's input, for hosts and docs that need it without zod. */
export function toolJsonSchemas(): Record<ToolName, Record<string, unknown>> {
  return Object.fromEntries(
    TOOL_NAMES.map((n) => [n, z.toJSONSchema(inputSchemas[n], { io: 'input' })]),
  ) as unknown as Record<ToolName, Record<string, unknown>>;
}
