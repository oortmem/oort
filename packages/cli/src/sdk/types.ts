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
  /** An end user (local mode). Requires `org`, not `local`. Their Planet only, never a Star. */
  user?: string;
  /** The tenant (local mode); default `local`. */
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
  hiddenLinks: number;
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

/** A handle on Oort memory, its scope fixed when it was made (`createOort`, `scoped`). */
export interface Oort {
  readonly mode: 'local' | 'cloud';
  readonly judge: OortJudge;
  recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
  observe(turn: Turn, opts?: { signal?: AbortSignal }): Promise<ObserveResult>;
  remember(
    facts: string | readonly string[],
    opts?: { type?: MemoryType },
  ): Promise<RememberResult>;
  forget(id: string, opts?: { everywhere?: boolean }): Promise<ForgetResult>;
  pin(id: string): Promise<PinResult>;
  unpin(id: string): Promise<PinResult>;
  recent(opts?: { since?: string | Date; limit?: number }): Promise<{
    memories: MemoryView[];
    warnings: Warning[];
  }>;
  explain(id: string): Promise<Explanation>;
  whoami(): Promise<Whoami>;
  /** Local only. */
  consolidate(opts?: { budgetMs?: number; signal?: AbortSignal }): Promise<ConsolidateResult>;
  /** A derived handle sharing this one's engine; its scope is fixed. */
  scoped(s: ScopedOptions): Oort;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
