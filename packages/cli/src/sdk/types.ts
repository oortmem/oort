/**
 * The public types of `oortmem`'s root export (CON-108 §4). Hand-written, so core's internal types
 * never leak into the published `.d.ts`: a change inside the engine cannot break a caller's types.
 * Callers must ignore result fields they do not know (additive changes are allowed in any minor).
 */

/** `auto`: the store `oort setup` chose on this machine (`$OORT_HOME/cloud.json`), else local. */
export type OortMode = 'auto' | 'local' | 'cloud';

/** Where a key may come from: given in code, the environment, or the Keychain (credentials.json). */
export type KeySource = 'explicit' | 'env' | 'keychain';

/** Keys given in code. Held in memory only; never written, logged or put into an error. */
export interface OortKeys {
  voyage?: string;
  typesafe?: string;
  anthropic?: string;
  /** The Oort key: cloud mode, or the Oort Pro relay for a role with no vendor key. */
  oort?: string;
}

/** Who records judgments through this handle (§6.3). */
export type JudgeRole = 'agent' | 'expert';

/**
 * A deep partial of the home config, laid over the resolved config (local mode). Checked against
 * the config's strict schema when the handle is created: an unknown key is a usage error. `serve`
 * cannot be set from code.
 */
export interface OortConfigOverlay {
  embed?: { provider?: string; model?: string; dimension?: number; [key: string]: unknown };
  rerank?: { provider?: string; model?: string; [key: string]: unknown };
  decide?: { provider?: string; [key: string]: unknown };
  writer?: { provider?: string; model?: string; [key: string]: unknown };
  activation?: Record<string, unknown>;
  recall?: Record<string, unknown>;
  project?: { private?: boolean };
  /** Who counts as an expert (the host's code is the operator here). */
  judge?: { experts?: string[]; operator?: string };
  /** The local store's dense index (0.9.0 or newer): `auto`, `int8`, `binary`, or `rabitq` (0.10.0 or newer). */
  store?: { vectorIndex?: 'auto' | 'int8' | 'binary' | 'rabitq'; binaryAutoThreshold?: number };
}

export interface OortOptions {
  /** Default `auto`. */
  mode?: OortMode;
  /** `OORT_HOME`, else `~/.oort` (local, auto). */
  home?: string;
  /** Used only to find the project and its config; default `process.cwd()`. */
  cwd?: string;
  /**
   * The project: an id (`cfg:<id>`, as `oort project link`), `null` for global memories only, or
   * omitted to derive it from `cwd` exactly as the CLI does.
   */
  project?: string | null;
  /** `false` skips the repository's `oort.config.json` (a server whose cwd is a checkout); local and cloud. */
  projectConfig?: boolean;
  /** The agent to act as; default `OORT_AGENT`, else anonymous (the Planet only). */
  agent?: string;
  /**
   * An end user: their Planet only, never a Star. Requires `org`, not `local`. In cloud mode it
   * also needs Oort Cloud with server keys (CON-132) and a server key ("Acts for end users").
   */
  user?: string;
  /**
   * The tenant; default `local`. Local mode: the storage and deletion boundary. Cloud mode: the
   * Oort key's account is that boundary, so `org` is your name for it and is not sent; `user`
   * still needs it, so a handle made for the account's own memory never derives an end user.
   */
  org?: string;
  /** Keys given in code (local; cloud takes `oort` only). */
  keys?: OortKeys;
  /** Default all three; `keychain` is dropped when `OORT_NO_KEYCHAIN=1`. */
  keySources?: readonly KeySource[];
  /** Laid over the resolved config (local mode). */
  config?: OortConfigOverlay;
  /** Oort Cloud's URL (cloud mode); default `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`. */
  url?: string;
  /** Per request, cloud mode; default 30 000. */
  timeoutMs?: number;
  /** Default true. `false` refuses an older store (`refused`, `migration-required`). */
  migrate?: boolean;
  /** Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** The fetch cloud mode uses; default the keep-alive pool. */
  fetch?: typeof fetch;
  /** Default `{ role: 'agent' }`. */
  judge?: { role: JudgeRole; operator?: string };
}

export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'preference' | 'judgment';
export type MemoryStatus =
  'current' | 'superseded' | 'corrected' | 'expired' | 'not-yet-valid' | 'withdrawn';
export type IncludeLevel = 'self' | 'planet' | 'star' | 'constellation' | 'galaxy';
export type RecallMode = 'current' | 'as-of' | 'history' | 'known-at';
export type JudgmentVia = 'cli' | 'mcp' | 'import' | 'pack' | 'sdk';

/** A judgment as a memory carries it (local mode). */
export interface JudgmentView {
  subject: { summary: string; ref?: string };
  verdict: string;
  verdicts: string[];
  reason: string;
  criteria: string[];
  domain: string;
  by: string;
  decidedAt: string;
  /** `mcp`: recorded by an agent (MCP, or an SDK in agent role). `sdk`: by expert-role SDK code. */
  via: JudgmentVia;
  status: MemoryStatus;
  /** A person recorded it, or confirmed an agent's record of it. */
  confirmed: boolean;
  /** Recorded by an agent and not confirmed: judging leaves it out by default. */
  agentRecorded: boolean;
  withdrawn?: { at: string; by: string };
  pack?: { id: string; name: string };
}

/** A position in metres on a map: x forward, y left, z up; yaw in radians. */
export interface Pose {
  x: number;
  y: number;
  z?: number;
  yaw?: number;
}

/**
 * Where a memory is (spatial memory, 0.9.0 or newer). Local mode only until Oort Cloud holds
 * places: in cloud mode a place is refused (`OortRefusedError`, reason `local-only`).
 */
export interface Place {
  /** A place path, root first, whole segments: `site:hq/floor:2/room:B/shelf:B3`. */
  nodeId?: string;
  /** The map the coordinates are in. Required with `pose`. */
  mapId?: string;
  /** Recorded, not filtered on. */
  mapVersion?: number;
  /** Default `map`. `odom` is refused: it drifts. */
  frame?: string;
  pose?: Pose;
  /** The region around `pose`: a box (full sizes, centred) or a sphere. Default: the point. */
  extent?: { dx: number; dy: number; dz?: number } | { radius: number };
  /** WGS84; stored and returned, not searchable yet. */
  geo?: { lat: number; lon: number; alt?: number };
  /** Pose uncertainty in metres (1 sigma). */
  sigma?: number;
}

/** `recall({ near })`: within `radius` metres of `pose` on the same map and frame. */
export interface NearQuery {
  mapId: string;
  /** Default `map`. */
  frame?: string;
  pose: { x: number; y: number; z?: number };
  /** Metres, more than 0. */
  radius: number;
}

export interface MemoryView {
  id: string;
  /** Scrubbed again on read. */
  text: string;
  type: MemoryType;
  tier: 'hot' | 'warm' | 'cold';
  pinned: boolean;
  status: MemoryStatus;
  validFrom: string;
  validTo: string | null;
  /** When it was recorded (transaction time). */
  recordedAt: string;
  updatedAt: string;
  entities: string[];
  origin?: { level: IncludeLevel; space: string; author?: string; overriddenBy?: string };
  judgment?: JudgmentView & { id: string };
  /** Where it is (0.9.0 or newer), when it was remembered with a place. */
  place?: Place;
}

export interface RecalledMemory extends MemoryView {
  /** The fused score, comparable only within one result. */
  score: number;
  stale?: true;
  /** @experimental Diagnostic; may change in a minor release. */
  why: {
    lexicalRank?: number;
    denseRank?: number;
    reranked?: number;
    coverage: number;
    dense?: number;
    activation: number;
    chain?: true;
    /** With `near` or `within`: the memory's place path. */
    placePath?: string;
    /** With `near`: metres from the query point to the memory's region (0 inside it). */
    distanceM?: number;
    /**
     * Set when the search did not find this memory and a link from a returned one did (local
     * mode only): the link's `kind` (`explicit`, `episode` or `about`), the id it was reached
     * `from`, and a `weight` from 0 to 1. It passed the same relevance gate as a hit.
     */
    via?: { kind: 'explicit' | 'episode' | 'about'; from: string; weight: number };
  };
}

/** An `oort.v1` warning code and one line for people. */
export interface Warning {
  code: string;
  message: string;
}

export interface RecallResult {
  memories: RecalledMemory[];
  abstained: boolean;
  temporal: { mode: RecallMode; asOf?: string; knownAt?: string; inferred: boolean };
  /** The spaces read, as labels. */
  read: string[];
  degraded: string[];
  warnings: Warning[];
}

export type Outcome = 'added' | 'reinforced' | 'updated' | 'superseded' | 'corrected' | 'skipped';

export interface ObserveResult {
  outcome: Outcome;
  memories: { outcome: Outcome; id?: string; supersedes?: string; reason?: string }[];
  counts: Partial<Record<Outcome, number>>;
  /** Cloud mode only: this `turnRef` was saved before. */
  duplicate?: true;
  warnings: Warning[];
}

export interface RememberResult {
  results: {
    fact: number;
    outcome: Outcome;
    id?: string;
    supersedes?: string;
    reason?: string;
  }[];
  warnings: Warning[];
}

export interface ForgetResult {
  forgotten: string;
  /**
   * Local: later memories of its chain that restated it, rewritten to their current fact (CON-144). Absent
   * when there were none.
   */
  rewritten?: string[];
  /**
   * Local: later memories that restate it and were left as they were (see `ForgetOutcome` for why, such as no memory writer or a rewrite
   * that added words). Absent when there were none.
   */
  notRewritten?: string[];
  /** Cloud `everywhere`: the Constellations (ids) whose copy only you contributed to, withdrawn. */
  withdrawn?: string[];
  /**
   * Cloud `everywhere`: the Constellations (ids) where others contributed too. Their maintainers
   * got a removal request, and the copy stays until they decide.
   */
  requested?: string[];
  /**
   * Cloud `everywhere`: the Constellations (ids) not reached. The copy stays: call it again later
   * with the full id (a Constellation you left needs a full key).
   */
  unreachable?: string[];
}

export interface PinResult {
  id: string;
  pinned: boolean;
  /** `null`: cloud mode cannot tell. */
  changed: boolean | null;
}

export interface Explanation {
  memory: MemoryView & { salience: number; activation: number; source: string };
  decisions: { stage: string; question: string; answer: string; probability: number }[];
  chain: {
    id: string;
    text: string;
    validFrom: string;
    validTo: string | null;
    endReason: 'superseded' | 'corrected' | 'expired' | null;
  }[];
  /**
   * Links of the memory (CON-148) whose other end this handle reads, oldest first. Cloud mode has
   * none yet.
   */
  links: LinkView[];
  /** Supersede-chain neighbours and stored links whose other end this handle cannot read. */
  hiddenLinks: number;
}

/** One stored link of a memory, as `explain` lists it. */
export interface LinkView {
  kind: 'explicit' | 'distilledFrom' | 'recalledWith';
  /** The memory at the other end. */
  id: string;
  /** `both` for explicit and recalledWith; `out` from a distilled memory, `in` to its evidence. */
  direction: 'both' | 'out' | 'in';
  /** Explicit links only: `user` when a person confirmed it on a terminal, else `agent`. */
  assertedBy?: 'user' | 'agent';
  createdAt: string;
}

export interface LinkResult {
  /** False when the two were already linked. */
  linked: boolean;
  /** An earlier unlink's block on the pair was removed. */
  unblocked: boolean;
  /** Who the link is asserted by: always `agent` from the SDK, unless a person linked it first. */
  assertedBy: 'user' | 'agent';
}

export interface UnlinkResult {
  /** A link between the two was removed. */
  removed: boolean;
  /** The pair is blocked: nothing links it again until someone links it explicitly. */
  blocked: boolean;
}

export interface RecordJudgmentView {
  outcome: 'added' | 'corrected' | 'unchanged';
  id: string;
  corrects?: string;
  status: 'agent-recorded' | 'recorded';
  /** Kinds of secret redacted before saving. */
  redacted: string[];
  embedFailed?: true;
}

export interface Precedent {
  id: string;
  subject: { summary: string; ref?: string };
  verdict: string;
  reason: string;
  criteria: string[];
  domain: string;
  by: string;
  decidedAt: string;
  similarity: number;
  near: boolean;
  agrees?: boolean;
  via: JudgmentVia;
  confirmed: boolean;
  agentRecorded: boolean;
  pack?: { id: string; name: string };
}

export interface JudgeResult {
  status: 'suggested' | 'needs-expert' | 'precedents-only';
  why?:
    | 'no-precedents'
    | 'too-far'
    | 'too-few'
    | 'precedents-disagree'
    | 'low-confidence'
    | 'no-decider'
    | 'decider-failed';
  /** A prediction from precedents, never the expert's decision. */
  prediction?: { verdict: string; probability: number; probabilities: Record<string, number> };
  precedents: Precedent[];
  verdicts: string[];
  agreement: Record<string, number>;
  similarity: 'dense' | 'lexical';
  threshold: number;
  minSimilarity: number;
  degraded?: string[];
  /** @experimental */
  decisions: { stage: string; question: string; answer: string; probability: number }[];
  importedExcluded?: number;
  agentRecordedExcluded?: number;
}

export interface ConsolidateResult {
  promoted: string[];
  demoted: string[];
  evicted: string[];
  expired: string[];
  skipped: number;
  complete: boolean;
}

export type RouteKind = 'own-key' | 'oort-pro' | 'local' | 'cloud' | 'missing';

export interface Whoami {
  mode: 'local' | 'cloud';
  account: string | null;
  agent: string | null;
  project: string | null;
  user: string | null;
  reads: string[];
  writesTo: string;
  version: string;
  routes: Record<'embed' | 'rerank' | 'decide' | 'write', RouteKind>;
}

export interface RecallOptions {
  /** 1 to 50, default 10. */
  limit?: number;
  mode?: RecallMode;
  /** Valid time. */
  asOf?: string | Date;
  /** Transaction time. */
  knownAt?: string | Date;
  /** Narrows only. */
  include?: IncludeLevel[];
  budgetChars?: number;
  includeWithdrawn?: boolean;
  /** `full`: embed and rerank; `fast`: no rerank; `lexical`: no model call. */
  speed?: 'full' | 'fast' | 'lexical';
  /** Default true: "on 2 April" picks as-of, as the CLI and MCP do. */
  inferTime?: boolean;
  /**
   * Only memories whose place path contains this path as whole segments (`room:B` keeps
   * `site:hq/room:B/shelf:B3`, never `room:B2`). 0.9.0 or newer; local mode only.
   */
  within?: string;
  /** Only memories within a radius on the same map and frame. 0.9.0 or newer; local mode only. */
  near?: NearQuery;
  signal?: AbortSignal;
}

export interface Turn {
  user: string;
  assistant: string;
  /** Tool-call summaries; truncated to 16 × 512 bytes, never refused. */
  tools?: string[];
  /** Default now. */
  at?: string | Date;
  sessionId?: string;
  /** At most 128 characters; deduplicated by Oort Cloud only. */
  turnRef?: string;
  /** Where this turn happened: the memories it writes carry it. 0.9.0 or newer; local mode only. */
  place?: Place;
}

export interface JudgmentInput {
  subject: string;
  ref?: string;
  verdict: string;
  verdicts?: readonly string[];
  reason: string;
  criteria?: readonly string[];
  domain: string;
  by: string;
  decidedAt?: string | Date;
}

export interface JudgeItem {
  summary: string;
  details?: string;
  ref?: string;
  domain?: string;
  by?: string;
}

export interface JudgeOptions {
  limit?: number;
  threshold?: number;
  minSimilarity?: number;
  minAgreement?: number;
  /** Also use judgments imported from packs. */
  includeImported?: boolean;
  /** Also use agent-recorded judgments nobody confirmed. */
  includeAgentRecorded?: boolean;
}

export interface ScopedOptions {
  user?: string;
  project?: string | null;
  agent?: string;
  /** Only ever narrows: `expert` to `agent`. */
  judgeRole?: 'agent';
}

export interface OortJudge {
  record(input: JudgmentInput): Promise<RecordJudgmentView>;
  apply(item: string | JudgeItem, opts?: JudgeOptions): Promise<JudgeResult>;
  list(opts?: {
    domain?: string;
    by?: string;
    all?: boolean;
    limit?: number;
  }): Promise<{ judgments: (JudgmentView & { id: string })[] }>;
  /** Expert role only. */
  confirm(id: string): Promise<{ id: string; changed: boolean }>;
}

/** How many end users the account has, and how many its plan includes. */
export interface EndUserCount {
  endUsers: number;
  limit: number;
}

/** What erasing an end user removed: the id you erased, and counts only. */
export interface EndUserErasure {
  erased: string;
  memories: number;
  coldCopies: number;
  turnRefs: number;
  cursors: number;
}

/**
 * One end user's memories, exported (CON-137): what an access or portability request asks for.
 * `jsonl` is the Oort export format (docs/export-format.md, version 1 from Oort Cloud): the
 * manifest line, then one memory per line, in every tier and validity state, oldest first. Write
 * it to a `.jsonl` file to hand over; `oort import <file>` reads it into a self-hosted store.
 */
export interface EndUserExport {
  /** The end user you exported. */
  exported: string;
  /** How many memories the export holds (0 for an end user who was erased or never had one). */
  memories: number;
  /** The export, JSON Lines: the manifest first, each line ending in a newline. */
  jsonl: string;
}

/**
 * The account's end users in Oort Cloud (CON-132): per-user memory a server key writes with
 * `scoped({ user })`. Requires Oort Cloud with server keys; refused with `end-users-unsupported`
 * when whoami does not list the key's `end-users` capability.
 */
export interface OortEndUsers {
  /**
   * Erases an end user: every memory stored for them, with its indexes and cold
   * copies. The account's own memory and every other end user are untouched. Erasing one who
   * has nothing is not an error. A write for them still in flight is refused (`end-user-erased`).
   */
  erase(user: string): Promise<EndUserErasure>;
  /**
   * Exports an end user's memories (CON-137): every memory stored for them, in every tier and
   * validity state, as Oort export JSON Lines. Nothing of the account's own memory or any other
   * end user. Exporting one who was erased, or never had a memory, is not an error: the export is
   * empty (`memories: 0`), the same either way.
   */
  export(user: string): Promise<EndUserExport>;
  /** How many end users the account has, and its plan's limit. */
  count(): Promise<EndUserCount>;
}

/** A handle on Oort memory, its scope fixed when it was made (`createOort`, `scoped`). */
export interface Oort {
  readonly mode: 'local' | 'cloud';
  readonly judge: OortJudge;
  recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
  observe(turn: Turn, opts?: { signal?: AbortSignal }): Promise<ObserveResult>;
  remember(
    facts: string | readonly string[],
    opts?: { type?: MemoryType; place?: Place },
  ): Promise<RememberResult>;
  forget(id: string, opts?: { everywhere?: boolean }): Promise<ForgetResult>;
  pin(id: string): Promise<PinResult>;
  unpin(id: string): Promise<PinResult>;
  recent(opts?: { since?: string | Date; limit?: number }): Promise<{
    memories: MemoryView[];
    warnings: Warning[];
  }>;
  explain(id: string): Promise<Explanation>;
  /**
   * Links two memories (CON-148), asserted by `agent`. Both must be memories this handle writes,
   * in the same Planet or Star; anything else is `not-found`, as for a missing id. Local only.
   */
  link(from: string, to: string): Promise<LinkResult>;
  /** Removes a link, or blocks a pair that was not linked. Same rules as `link`. Local only. */
  unlink(from: string, to: string): Promise<UnlinkResult>;
  whoami(): Promise<Whoami>;
  /** Local only. */
  consolidate(opts?: { budgetMs?: number; signal?: AbortSignal }): Promise<ConsolidateResult>;
  /**
   * The account's end users (Oort Cloud with server keys, CON-132): erase or export one, or count
   * them.
   * Cloud mode only, on a handle that is not scoped to an end user.
   */
  readonly endUsers: OortEndUsers;
  /** A derived handle sharing this one's engine; its scope is fixed. */
  scoped(s: ScopedOptions): Oort;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
