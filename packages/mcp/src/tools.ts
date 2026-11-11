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
  'share',
] as const;
/**
 * Judgment memory (CON-71): offered only by a backend that implements them (the local store
 * today), so the remote connector's tool set is unchanged until it does.
 */
export const JUDGMENT_TOOL_NAMES = ['record_judgment', 'judge'] as const;

export type ToolName = (typeof TOOL_NAMES)[number] | (typeof JUDGMENT_TOOL_NAMES)[number];

/** Every tool a server can offer, in registration order. */
export const ALL_TOOL_NAMES: readonly ToolName[] = [...TOOL_NAMES, ...JUDGMENT_TOOL_NAMES];

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
  .regex(/^[^\r\n\u0085\u2028\u2029]*$/, 'one line per fact')
  .describe('One standalone claim, true without the conversation around it');

export const MEMORY_TYPES = ['semantic', 'episodic', 'procedural', 'preference'] as const;

const Label = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .describe('A short lowercase label: letters, digits, "-" or "_"');

/** The temporal views `recall` reads (CON-34). */
export const RECALL_MODES = ['current', 'as-of', 'history', 'known-at'] as const;

/** The levels a recall can name (core's `IncludeLevel`, CON-62). */
export const INCLUDE_LEVELS = ['self', 'planet', 'star', 'constellation', 'galaxy'] as const;
export type IncludeLevel = (typeof INCLUDE_LEVELS)[number];

/** A shared text is at most this long (the cloud's share cap). */
export const SHARE_TEXT_MAX_CHARS = 4096;

/**
 * What one connection may reach (hive spec §9.1, CON-64), fixed when the server is built from
 * trusted configuration: the local config, or the grant a person approved on a consent screen.
 * The model can only choose inside it; no tool argument can widen it.
 */
export interface ToolSpaces {
  /** The levels `recall.include` may name. At least `planet`. */
  include: readonly IncludeLevel[];
  /** Constellation names `remember.visibility` may name, besides `private`. */
  visibility: readonly string[];
  /** Constellation names `share.to` may name. `share` is offered only when this is not empty. */
  share: readonly string[];
}

/** One person's Planet and nothing else: the default for every server. */
export const PLANET_ONLY: ToolSpaces = Object.freeze({
  include: Object.freeze(['planet'] as IncludeLevel[]),
  visibility: Object.freeze([] as string[]),
  share: Object.freeze([] as string[]),
});

/** A zod enum over `values`, which may be empty (then nothing passes). */
function oneOf(values: readonly string[], none: string): z.ZodType<string> {
  const v = [...new Set(values)];
  return v.length === 0 ? z.string().refine(() => false, none) : z.enum(v as [string, ...string[]]);
}

/** A finite coordinate in metres. */
const Metres = z.number().finite();
const PlacePath = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe('A place path, root first, whole segments: site:hq/room:B/shelf:B3');
const ToolPose = z.object({ x: Metres, y: Metres, z: Metres.optional() });

/** The spatial arguments (CON-84), offered only by a backend that can filter by place. */
const SPATIAL_RECALL = {
  within: PlacePath.optional().describe(
    'Only memories at this place or below it, e.g. room:B (matches whole path segments)',
  ),
  near: z
    .object({
      map_id: z.string().trim().min(1).max(128),
      frame: z.string().trim().min(1).max(128).optional().describe('Default map'),
      pose: ToolPose,
      radius: z.number().positive().describe('Metres'),
    })
    .optional()
    .describe('Only memories within radius metres of pose on this map'),
};
const SPATIAL_REMEMBER = {
  place: z
    .object({
      node_id: PlacePath.optional(),
      map_id: z.string().trim().min(1).max(128).optional(),
      map_version: z.number().int().nonnegative().optional(),
      frame: z.string().trim().min(1).max(128).optional(),
      pose: ToolPose.optional(),
      radius: z.number().positive().optional().describe('The size of the place, in metres'),
    })
    .optional()
    .describe('Where the facts are: a place path, map coordinates, or both'),
};

/** Options for `inputSchemasFor`. */
export interface ToolSchemaOptions {
  /** The backend filters by place (CON-84): offer `recall.within`, `recall.near` and `remember.place`. */
  spatial?: boolean;
}

/**
 * The tool input schemas for one connection's spaces: `recall.include` lists only the levels it
 * may read, `remember.visibility` only `private` and the Constellations it may share to, and
 * `share.to` only those. Unknown arguments (a `scope`, `project` or `agent` a model invents) are
 * stripped by zod and never reach a backend; so are the spatial ones on a backend without places.
 */
export function inputSchemasFor(spaces: ToolSpaces, opts: ToolSchemaOptions = {}) {
  const include = spaces.include.filter((l) => (INCLUDE_LEVELS as readonly string[]).includes(l));
  const recall = z.object({
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
    include: z
      .array(oneOf(include, 'This connection cannot read that level.') as z.ZodType<IncludeLevel>)
      .min(1)
      .max(INCLUDE_LEVELS.length)
      .optional()
      .describe('Only these levels: planet is your own memory; omit it to read everything allowed'),
  });
  const remember = z.object({
    facts: z.array(Fact).min(1).max(REMEMBER_MAX_FACTS),
    type: z
      .enum(MEMORY_TYPES)
      .optional()
      .describe('A hint for the kind of fact; Oort decides the final type'),
    visibility: oneOf(['private', ...spaces.visibility], 'Not a space this connection can use.')
      .default('private')
      .describe('private (the default), or a Constellation to suggest sharing the fact with'),
  });
  // Typed with the spatial fields either way (they are optional); without places they are left
  // out of the schema, so a model never sees them and zod strips any it sends.
  const spatialRecall = recall.extend(SPATIAL_RECALL);
  const spatialRemember = remember.extend(SPATIAL_REMEMBER);
  return {
    recall: opts.spatial === true ? spatialRecall : (recall as unknown as typeof spatialRecall),
    remember:
      opts.spatial === true ? spatialRemember : (remember as unknown as typeof spatialRemember),
    // Loose (CON-67): the model never withdraws shared copies (a person confirms that in the
    // terminal), so an `everywhere` it sends must reach the handler and be refused, never be
    // stripped into a plain forget. Other unknown arguments still never reach a backend: the
    // handler passes only `id`.
    forget: z.looseObject({ id: Id }),
    pin: z.object({ id: Id, pinned: z.boolean() }),
    explain: z.object({ id: Id }),
    list_recent: z.object({
      since: IsoTime.optional().describe('Only memories changed at or after this time'),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    whoami: z.object({}),
    share: z.object({
      id: Id,
      to: oneOf(spaces.share, 'This connection cannot share there.').describe(
        'The Constellation to share the memory with',
      ),
      text: z
        .string()
        .trim()
        .min(1)
        .max(SHARE_TEXT_MAX_CHARS)
        .optional()
        .describe('An edited text to share instead of the memory as it is'),
    }),
    record_judgment: z.object({
      subject: z.string().trim().min(1).max(500).describe('What was judged, in one line'),
      ref: z.string().trim().min(1).max(2000).optional().describe('A link or id of the item'),
      verdict: Label.describe("The expert's verdict: approved or rejected, or one of `verdicts`"),
      verdicts: z
        .array(Label)
        .min(2)
        .max(12)
        .optional()
        .describe('The verdict set, when it is not approved and rejected'),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("The expert's reason, exactly as they gave it; never reworded"),
      criteria: z
        .array(z.string().trim().min(1).max(64))
        .max(12)
        .optional()
        .describe('Tags the reason relies on, e.g. no-source'),
      domain: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe('The domain: legal, content, code-review, …'),
      by: z.string().trim().min(1).max(128).describe("The expert's id"),
      decided_at: IsoTime.optional().describe('When the expert decided (default now)'),
    }),
    judge: z.object({
      item: z.string().trim().min(1).max(2000).describe('The new item, summarised'),
      details: z.string().trim().min(1).max(4000).optional().describe('More about the item'),
      domain: z.string().trim().min(1).max(64).optional().describe('Use only this domain'),
      by: z.string().trim().min(1).max(128).optional().describe("Use only this expert's judgments"),
      limit: z.number().int().min(1).max(10).default(5).describe('Precedents to use'),
      include_imported: z
        .boolean()
        .default(false)
        .describe(
          'Also use judgments imported from packs, whose experts are as the pack states them',
        ),
      include_agent_recorded: z
        .boolean()
        .default(false)
        .describe('Also use agent-recorded judgments nobody has confirmed'),
    }),
  } as const satisfies Record<ToolName, z.ZodType>;
}

/** The schemas of a Planet-only connection (kept for importers from before spaces). */
export const inputSchemas = inputSchemasFor(PLANET_ONLY);

export type ToolInput<N extends ToolName> = z.output<ReturnType<typeof inputSchemasFor>[N]>;

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
    description:
      'Permanently delete one memory by id, from every storage tier. Copies shared to team Constellations stay; the result says how the person can withdraw them.',
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
      'Describe this Oort connection: local or cloud mode, the spaces it can reach, and which services are available.',
    annotations: read('Oort account'),
  },
  {
    name: 'share',
    title: 'Share with a Constellation',
    description:
      'Copy one memory into a Constellation the user belongs to, so its members can recall it. Secrets are redacted; the copy records who shared it.',
    annotations: {
      title: 'Share with a Constellation',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'record_judgment',
    title: 'Record a judgment',
    description:
      'Record one decision an expert explicitly made, with their reason verbatim. Saved as agent-recorded and unconfirmed until a person confirms it; only for experts this machine lists.',
    annotations: {
      title: 'Record a judgment',
      readOnlyHint: false,
      // It can change what judging answers for an expert, so hosts should ask first.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'judge',
    title: "Apply an expert's judgments",
    description:
      "Predict an expert's verdict on a new item from their judgments, with probability and cited precedents, or say it needs the expert. Sends the item and reasons to TypeSafe.",
    // Reads only, but sends the item and the precedents' reasons to TypeSafe for the prediction.
    annotations: { ...read("Apply an expert's judgments"), openWorldHint: true },
  },
];

/** The JSON Schema of every tool's input, for hosts and docs that need it without zod. */
export function toolJsonSchemas(
  spaces: ToolSpaces = PLANET_ONLY,
  opts: ToolSchemaOptions = {},
): Record<ToolName, Record<string, unknown>> {
  const schemas = inputSchemasFor(spaces, opts);
  return Object.fromEntries(
    ALL_TOOL_NAMES.map((n) => [n, z.toJSONSchema(schemas[n], { io: 'input' })]),
  ) as unknown as Record<ToolName, Record<string, unknown>>;
}
