import { createHash, randomUUID } from 'node:crypto';
import type { DecisionController, Embedder, JudgeChoice, MemoryStore } from './adapters.js';
import { addressed } from './address.js';
import { INVISIBLE_SOURCE } from './display.js';
import { homeAddress, type Grant } from './grant.js';
import { isCurrent, type Decision, type Memory, type Scope } from './model.js';
import { informativeTokens } from './relevance.js';
import { scrub } from './scrub.js';

/**
 * Judgment memory (CON-71): an expert's approve or reject decisions, with their reasons in their
 * own words, kept so an agent can apply them to a new item, say why, and say when it is not sure.
 *
 * A judgment is a `judgment` memory whose `judgment` field holds the decision. It is written only
 * through the judgment functions here (never inferred from a conversation), its reason is never
 * paraphrased (the write path skips judgments), and it is pinned so it never loses its embedding
 * to cold.
 *
 * Who recorded it matters. A judgment recorded by a person (the CLI, a bulk import) counts when
 * judging. One recorded by an agent over MCP (`via: 'mcp'`) is agent-recorded and unconfirmed: it
 * never corrects a person's judgment, and judging leaves it out until a person confirms it
 * (`confirmJudgment`, CLI only) or the caller asks for agent-recorded judgments explicitly. One
 * imported from a pack names an expert only as the pack states it, so judging leaves it out unless
 * asked.
 */

/** The verdict set a judgment uses when none is given. */
export const DEFAULT_VERDICTS: readonly string[] = Object.freeze(['approved', 'rejected']);

export const JUDGMENT_LIMITS = Object.freeze({
  summary: 500,
  ref: 2000,
  reason: 2000,
  details: 4000,
  criteria: 12,
  criterion: 64,
  verdicts: 12,
  by: 128,
  /** Rows one bulk import or pack may hold; a larger one is refused before anything is written. */
  importRows: 5000,
});

/** What was judged: a summary, and where the item itself lives. */
export interface JudgmentSubject {
  summary: string;
  /** A link or id of the item (a URL, a ticket, a file path). */
  ref?: string;
}

/**
 * Where a judgment came from, besides the expert who made it. `mcp` means an agent recorded it:
 * agent-recorded, unconfirmed until a person confirms it.
 */
export type JudgmentVia = 'cli' | 'mcp' | 'import' | 'pack' | 'sdk';

/**
 * A judgment that arrived in a pack: the pack it was imported from here (its digest id and the
 * manifest's name, exporter and time, all bound by the digest) and the id the line carried. Every
 * field comes from the pack this store imported, never from what a line claims about itself.
 */
export interface JudgmentPackOrigin {
  /** The pack's digest id (the first 16 hex characters of `packDigest`). */
  id: string;
  name: string;
  exportedAt: string;
  /** The agent that exported it. */
  exportedBy: string;
  /** The id the judgment had in the pack (its id in the exporting store). */
  originalId: string;
  importedAt: string;
  /**
   * What the line said about an earlier pack it came from, when the exporter had imported it
   * itself. Untrusted: the exporter could have written anything here, so nothing uses it for
   * deduplication, attribution or judging; it is kept only to be shown as a claim.
   */
  claimedEarlier?: ClaimedPackOrigin;
}

/** An earlier pack origin as a pack line claims it. Checked for shape only; never trusted. */
export interface ClaimedPackOrigin {
  untrusted: true;
  id: string;
  name: string;
  exportedAt: string;
  exportedBy: string;
  originalId: string;
}

/** The decision itself. Everything an expert said is kept as they said it (secrets redacted). */
export interface Judgment {
  subject: JudgmentSubject;
  /** One of `verdicts`. */
  verdict: string;
  /** The defined set the verdict comes from; `approved` and `rejected` by default. */
  verdicts: string[];
  /** The expert's own words. */
  reason: string;
  /** Tags the reason relies on (`no-source`, `pii`). */
  criteria: string[];
  domain: string;
  /** The expert's id. */
  by: string;
  decidedAt: string;
  /** How it was recorded. The agent that recorded it is the memory's author. */
  via: JudgmentVia;
  /** Set when it was withdrawn (and by which operator): it no longer counts anywhere. */
  withdrawn?: { at: string; by: string };
  /** Set on an agent-recorded (`mcp`) judgment a person confirmed: it then counts when judging. */
  confirmed?: { at: string; by: string };
  /** Set when its text was purged: only an audit stub (expert, domain, verdict, times) is left. */
  purged?: { at: string; by: string };
  /**
   * Set when it was withdrawn, corrected or purged: `tombstoneKey` of the decision as it was, so no
   * import brings the same decision back (it leaves out `decidedAt`, which a pack could shift).
   */
  tombstone?: string;
  /** Set on a judgment imported from a pack. */
  pack?: JudgmentPackOrigin;
}

/** A judgment's decision fields, as `normaliseJudgment` returns them. */
export type JudgmentCore = Omit<
  Judgment,
  'via' | 'pack' | 'withdrawn' | 'confirmed' | 'purged' | 'tombstone'
>;

/** A judgment as a caller describes it, before checking and normalising. */
export interface JudgmentInput {
  subject: string;
  ref?: string;
  verdict: string;
  verdicts?: readonly string[];
  reason: string;
  criteria?: readonly string[];
  domain: string;
  by: string;
  /** ISO time; defaults to now. */
  decidedAt?: string;
}

/** A judgment input that cannot be recorded; the message names the field, never its value. */
export class JudgmentInputError extends Error {
  override readonly name = 'JudgmentInputError';
}

// oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
/**
 * Bidi controls (Trojan Source) and zero-width or other invisible format characters: never in
 * anything a judgment holds. The same set the CLI's `shown()` escapes (core's display.ts).
 */
const INVISIBLE = new RegExp(INVISIBLE_SOURCE);
const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CRITERION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DOMAIN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function text(field: string, v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') throw new JudgmentInputError(`${field} must be text`);
  const t = v.trim();
  if (t === '') throw new JudgmentInputError(`${field} is empty`);
  if (t.length > max) throw new JudgmentInputError(`${field} is longer than ${max} characters`);
  if (CONTROL.test(t) || (!multiline && /[\r\n]/.test(t))) {
    throw new JudgmentInputError(`${field} holds control characters`);
  }
  // The raw value: trim() would quietly drop a leading or trailing U+FEFF.
  if (INVISIBLE.test(v)) {
    throw new JudgmentInputError(`${field} holds bidi or invisible format characters`);
  }
  return t;
}

/** A verdict or criterion label: lowercase, spaces as `-`. */
export function judgmentLabel(field: string, v: unknown, re = LABEL): string {
  if (typeof v !== 'string') throw new JudgmentInputError(`${field} must be text`);
  const t = v.trim().toLowerCase().replace(/\s+/g, '-');
  if (!re.test(t) || INVISIBLE.test(v)) {
    throw new JudgmentInputError(
      `${field} must be a short label: lowercase letters, digits, "-" or "_"`,
    );
  }
  return t;
}

/** A list of labels, its type and length checked before anything is mapped. */
function labels(field: string, v: unknown, max: number): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new JudgmentInputError(`${field} must be a list`);
  if (v.length > max) throw new JudgmentInputError(`${field} has more than ${max} entries`);
  if (!v.every((x) => typeof x === 'string')) {
    throw new JudgmentInputError(`${field} must be a list of text labels`);
  }
  return v as string[];
}

/** Checks and normalises `input` (labels lowercased, text trimmed). Throws `JudgmentInputError`. */
export function normaliseJudgment(input: JudgmentInput, now: Date): JudgmentCore {
  if (typeof input !== 'object' || input === null) {
    throw new JudgmentInputError('a judgment must be an object');
  }
  const rawVerdicts = labels('verdicts', input.verdicts, JUDGMENT_LIMITS.verdicts);
  const verdicts = [
    ...new Set((rawVerdicts ?? DEFAULT_VERDICTS).map((v) => judgmentLabel('verdicts', v))),
  ];
  if (verdicts.length < 2) throw new JudgmentInputError('verdicts needs at least two labels');
  const verdict = judgmentLabel('verdict', input.verdict);
  if (!verdicts.includes(verdict)) {
    throw new JudgmentInputError(`verdict must be one of: ${verdicts.join(', ')}`);
  }
  const criteria = [
    ...new Set(
      (labels('criteria', input.criteria, JUDGMENT_LIMITS.criteria) ?? [])
        .map((c) => c.trim())
        .filter((c) => c !== '')
        .map((c) => judgmentLabel('criteria', c, CRITERION)),
    ),
  ];
  let decidedAt = now.toISOString();
  if (input.decidedAt !== undefined) {
    if (typeof input.decidedAt !== 'string') {
      throw new JudgmentInputError('decidedAt must be an ISO date or time');
    }
    const t = Date.parse(input.decidedAt);
    if (Number.isNaN(t)) throw new JudgmentInputError('decidedAt is not an ISO date or time');
    decidedAt = new Date(t).toISOString();
  }
  if (input.ref !== undefined && typeof input.ref !== 'string') {
    throw new JudgmentInputError('ref must be text');
  }
  const ref = input.ref === undefined || input.ref.trim() === '' ? undefined : input.ref;
  return {
    subject: {
      summary: text('subject', input.subject, JUDGMENT_LIMITS.summary),
      ...(ref !== undefined && { ref: text('ref', ref, JUDGMENT_LIMITS.ref) }),
    },
    verdict,
    verdicts,
    reason: text('reason', input.reason, JUDGMENT_LIMITS.reason, true),
    criteria,
    domain: judgmentLabel('domain', input.domain, DOMAIN),
    by: text('by', input.by, JUDGMENT_LIMITS.by),
    decidedAt,
  };
}

/**
 * An expert id as agent-facing text may show it: letters, digits and `. _ @ + -` kept, anything
 * else `_`, at most 64 characters. Ids are checked on the way in; this is the second line.
 */
export function safeExpertId(by: string): string {
  return by.replace(/[^A-Za-z0-9._@+-]/g, '_').slice(0, 64);
}

/** The memory text recall shows for a judgment: who decided what, and why, in their words. */
export function judgmentText(j: Judgment): string {
  const criteria = j.criteria.length === 0 ? '' : ` Criteria: ${j.criteria.join(', ')}.`;
  const who =
    isAgentVia(j.via) && j.confirmed === undefined ? ' (agent-recorded, unconfirmed)' : '';
  return `Judgment by ${j.by}${who} (${j.domain}): ${j.verdict} "${j.subject.summary}". Reason: ${j.reason}${criteria}`;
}

/** True for a `judgment` memory that still counts: current, and not withdrawn. */
export function isActiveJudgment(m: Memory, now: Date): m is Memory & { judgment: Judgment } {
  return (
    m.type === 'judgment' && m.judgment !== undefined && !m.judgment.withdrawn && isCurrent(m, now)
  );
}

/**
 * True for a `via` that means an agent recorded the judgment (today only `mcp`, which also covers
 * agent-role SDK records, `source.harness: 'sdk'`). The one definition of agent-recorded: every
 * rule that keeps an agent from retracting a person's judgment asks it, so a later agent `via`
 * cannot slip past one site while the others hold.
 */
export function isAgentVia(via: JudgmentVia): boolean {
  return via === 'mcp';
}

/** Recorded by an agent (over MCP, or an SDK in agent role) and not confirmed by a person. */
export function isUnconfirmedAgentJudgment(j: Pick<Judgment, 'via' | 'confirmed'>): boolean {
  return isAgentVia(j.via) && j.confirmed === undefined;
}

/** Case and whitespace folded, for matching a decision whatever its spacing or capitals. */
const fold = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The key a withdrawn, corrected or purged decision leaves behind: expert, domain, folded subject,
 * folded reason and verdict, hashed. It leaves out `decidedAt` (a pack could shift it) and holds no
 * text (a purged judgment keeps it).
 */
export function tombstoneKey(
  j: Pick<Judgment, 'by' | 'domain' | 'subject' | 'reason' | 'verdict'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([j.by, j.domain, fold(j.subject.summary), fold(j.reason), j.verdict]))
    .digest('hex');
}

/** The exact decision, for spotting the same one again whatever its origin. */
function fingerprint(j: JudgmentCore): string {
  return JSON.stringify([
    j.by,
    j.domain,
    j.subject.summary,
    j.subject.ref ?? null,
    j.verdict,
    j.reason,
    j.decidedAt,
  ]);
}

function redactJudgment<J extends JudgmentCore>(j: J): { judgment: J; redacted: string[] } {
  const kinds = new Set<string>();
  const clean = (s: string): string => {
    const r = scrub(s);
    for (const x of r.redactions) kinds.add(x.kind);
    return r.text;
  };
  return {
    judgment: {
      ...j,
      subject: {
        summary: clean(j.subject.summary),
        ...(j.subject.ref !== undefined && { ref: clean(j.subject.ref) }),
      },
      reason: clean(j.reason),
      by: clean(j.by),
    },
    redacted: [...kinds],
  };
}

export interface RecordJudgmentDeps {
  store: MemoryStore;
  /** Where it is written: the grant's home node, unbound to any project. */
  grant: Grant;
  /** The acting principal's scope (its `agentId` is the author). */
  scope: Scope;
  /** Embeds the judgment for dense judging; without it judging is lexical. */
  embed?: Embedder;
  now?: Date;
  /** The harness or tool that recorded it, for `source`. */
  harness?: string;
}

export interface RecordJudgmentResult {
  /**
   * `added`: a new judgment. `corrected`: it replaced an earlier judgment of the same item by the
   * same expert, recorded the same way (by a person, or by an agent). `unchanged`: that earlier
   * judgment already says this.
   */
  outcome: 'added' | 'corrected' | 'unchanged';
  memory: Memory;
  /** The judgment it replaced (`corrected`). */
  supersedes?: string;
  /** Kinds of secret redacted from the text. */
  redacted: string[];
  /** The embedder failed: the judgment is kept, lexical-only. */
  embedFailed?: true;
}

/**
 * Who owns a judgment: a person (recorded by a person, or an agent's record a person confirmed) or
 * an agent (recorded over MCP, unconfirmed). A write only ever corrects a judgment of its own kind,
 * so an agent can never retract what a person recorded or confirmed.
 */
const recordedBy = (j: Pick<Judgment, 'via' | 'confirmed'>): 'agent' | 'person' =>
  isUnconfirmedAgentJudgment(j) ? 'agent' : 'person';

/** What the store already holds, read once per record or import. */
interface JudgmentIndex {
  /** Active judgments made here (not imported), by kind, item ref, domain and expert. */
  items: Map<string, Memory & { judgment: Judgment }>;
  fingerprints: Set<string>;
  tombstones: Set<string>;
  /** `packId:originalId` of every judgment imported from a pack. */
  imported: Set<string>;
}

const itemKey = (j: Pick<Judgment, 'via' | 'subject' | 'domain' | 'by'>): string | undefined =>
  j.subject.ref === undefined
    ? undefined
    : JSON.stringify([recordedBy(j), j.subject.ref, j.domain, j.by]);

async function indexJudgments(store: MemoryStore, grant: Grant, now: Date): Promise<JudgmentIndex> {
  const index: JudgmentIndex = {
    items: new Map(),
    fingerprints: new Set(),
    tombstones: new Set(),
    imported: new Set(),
  };
  const all = await store.list(grant, { validOnly: false, embeddings: false });
  for (const m of all) {
    if (m.type !== 'judgment' || m.judgment === undefined) continue;
    const j = m.judgment;
    const ended =
      j.withdrawn !== undefined || j.purged !== undefined || m.endReason === 'corrected';
    // An imported record (a pack's or an export file's) cannot speak for a person (CON-137): it
    // is evidence the decision is here only while it is active, and it leaves a tombstone only
    // when a person ended it here (withdrawing, purging or correcting writes `tombstone`, which
    // no import stores), so a file cannot plant either to keep a genuine decision out.
    const imported = j.pack !== undefined;
    // An agent's unconfirmed record is no evidence the decision is already here.
    if (!isUnconfirmedAgentJudgment(j) && (!imported || isActiveJudgment(m, now))) {
      index.fingerprints.add(fingerprint(j));
    }
    if (imported) index.imported.add(`${j.pack!.id}:${j.pack!.originalId}`);
    // Only a person's decision leaves a tombstone that blocks imports: an agent withdrawing or
    // correcting its own unconfirmed record must not keep a genuine expert decision out.
    if (ended && !isUnconfirmedAgentJudgment(j) && (!imported || j.tombstone !== undefined)) {
      index.tombstones.add(j.tombstone ?? tombstoneKey(j));
    }
    const key = itemKey(j);
    if (key !== undefined && j.pack === undefined && isActiveJudgment(m, now)) {
      index.items.set(key, m as Memory & { judgment: Judgment });
    }
  }
  return index;
}

/** An imported judgment that came ended and that no person here has ended since. */
const arrivedEnded = (j: Judgment): boolean => j.pack !== undefined && j.tombstone === undefined;

/** One write a record or an import will make, before embedding. */
interface Planned {
  memory: Memory & { judgment: Judgment };
  prior?: Memory & { judgment: Judgment };
  redacted: string[];
}

type PlanOutcome =
  | { kind: 'write'; planned: Planned }
  | { kind: 'unchanged'; memory: Memory }
  | { kind: 'tombstoned' }
  | { kind: 'duplicate' };

/**
 * Plans one judgment against `index` (and updates the index, so later rows of the same import see
 * it). `tombstones`: skip a decision withdrawn, corrected or purged here (imports and packs).
 */
function plan(
  input: JudgmentInput,
  ctx: {
    deps: RecordJudgmentDeps;
    via: JudgmentVia;
    pack?: JudgmentPackOrigin;
    corrects?: Memory & { judgment: Judgment };
    index: JudgmentIndex;
    now: Date;
    tombstones: boolean;
    importedKey?: string;
  },
): PlanOutcome {
  const { judgment: base, redacted } = redactJudgment(normaliseJudgment(input, ctx.now));
  const { index } = ctx;
  if (ctx.importedKey !== undefined && index.imported.has(ctx.importedKey)) {
    return { kind: 'duplicate' };
  }
  if (ctx.tombstones && index.tombstones.has(tombstoneKey(base))) return { kind: 'tombstoned' };
  if (ctx.via === 'pack' && index.fingerprints.has(fingerprint(base))) return { kind: 'duplicate' };
  const j: Judgment = {
    ...base,
    via: ctx.via,
    ...(ctx.pack !== undefined && { pack: ctx.pack }),
  };
  const key = itemKey(j);
  // A pack never corrects anything: it only adds.
  const found =
    ctx.corrects ?? (ctx.via === 'pack' || key === undefined ? undefined : index.items.get(key));
  // An agent never retracts a person-owned judgment (recorded or confirmed by a person): it is
  // recorded alongside instead. The item key already separates them; this is the second line.
  const prior =
    isAgentVia(ctx.via) && found !== undefined && recordedBy(found.judgment) === 'person'
      ? undefined
      : found;
  if (prior !== undefined && ctx.corrects === undefined && sameDecision(prior.judgment, j)) {
    return { kind: 'unchanged', memory: prior };
  }
  const memory = judgmentMemory(
    j,
    ctx.deps.scope,
    ctx.deps.grant,
    ctx.now,
    ctx.deps.harness ?? ctx.via,
  );
  if (prior !== undefined) {
    memory.supersedes = prior.id;
    if (recordedBy(prior.judgment) === 'person') {
      index.tombstones.add(prior.judgment.tombstone ?? tombstoneKey(prior.judgment));
    }
  }
  if (key !== undefined && ctx.via !== 'pack') index.items.set(key, memory);
  if (!isAgentVia(ctx.via)) index.fingerprints.add(fingerprint(base));
  if (ctx.importedKey !== undefined) index.imported.add(ctx.importedKey);
  return { kind: 'write', planned: { memory, ...(prior !== undefined && { prior }), redacted } };
}

/** How many texts one embedding call carries during an import. */
const EMBED_BATCH = 128;

/**
 * Embeds the planned judgments in batches, then writes them in order: a correction retracts its
 * prior (kept, linked, its validity closed, its tombstone set) in the same atomic write. Returns
 * how many could not be embedded (they are kept, lexical-only).
 */
async function commit(planned: Planned[], deps: RecordJudgmentDeps, now: Date): Promise<number> {
  let embedFailed = 0;
  if (deps.embed !== undefined) {
    for (let i = 0; i < planned.length; i += EMBED_BATCH) {
      const chunk = planned.slice(i, i + EMBED_BATCH);
      try {
        const vs = await deps.embed.embed(
          chunk.map((p) => embedText(p.memory.judgment)),
          'document',
        );
        chunk.forEach((p, k) => {
          const v = vs[k];
          if (v !== undefined) p.memory.embedding = v;
          else embedFailed++;
        });
      } catch {
        embedFailed += chunk.length;
      }
    }
  }
  const iso = now.toISOString();
  for (const p of planned) {
    if (p.prior === undefined) {
      await deps.store.upsert(deps.grant, p.memory);
      continue;
    }
    // The full record (a listing leaves out the embedding), so the retracted one keeps it.
    const old = (await deps.store.get(deps.grant, p.prior.id)) ?? p.prior;
    const oldJ = old.judgment ?? p.prior.judgment;
    await deps.store.upsertMany(deps.grant, [
      {
        ...old,
        judgment: { ...oldJ, tombstone: oldJ.tombstone ?? tombstoneKey(oldJ) },
        expiredAt: iso,
        endReason: 'corrected',
        validTo: closeAt(old, now),
        supersededBy: p.memory.id,
        updatedAt: iso,
      },
      p.memory,
    ]);
  }
  return embedFailed;
}

/** When a judgment's validity ends on withdrawal or correction: now, never before it began. */
function closeAt(m: Pick<Memory, 'validFrom' | 'validTo'>, now: Date): string {
  if (m.validTo !== null && Date.parse(m.validTo) <= now.getTime()) return m.validTo;
  return new Date(Math.max(now.getTime(), Date.parse(m.validFrom))).toISOString();
}

/**
 * Records one judgment. When the same expert already judged the same item (same `ref` and domain)
 * and it was recorded the same way (by a person, or by an agent over MCP), the new judgment
 * corrects the old one (kept, retracted, linked both ways), unless it says the same thing. An
 * agent-recorded judgment never corrects a person's: it is recorded alongside. Throws
 * `JudgmentInputError` for bad input.
 */
export async function recordJudgment(
  input: JudgmentInput,
  deps: RecordJudgmentDeps & { via: JudgmentVia; pack?: JudgmentPackOrigin; corrects?: Memory },
): Promise<RecordJudgmentResult> {
  const now = deps.now ?? new Date();
  const corrects =
    deps.corrects !== undefined && deps.corrects.judgment !== undefined
      ? (deps.corrects as Memory & { judgment: Judgment })
      : undefined;
  if (
    corrects !== undefined &&
    isAgentVia(deps.via) &&
    recordedBy(corrects.judgment) === 'person'
  ) {
    throw new JudgmentInputError(
      'an agent-recorded judgment cannot correct one a person recorded or confirmed',
    );
  }
  const hasRef = typeof input?.ref === 'string' && input.ref.trim() !== '';
  const index =
    hasRef && corrects === undefined
      ? await indexJudgments(deps.store, deps.grant, now)
      : {
          items: new Map(),
          fingerprints: new Set<string>(),
          tombstones: new Set<string>(),
          imported: new Set<string>(),
        };
  const r = plan(input, {
    deps,
    via: deps.via,
    ...(deps.pack !== undefined && { pack: deps.pack }),
    ...(corrects !== undefined && { corrects }),
    index,
    now,
    tombstones: false,
  });
  if (r.kind === 'unchanged') {
    return {
      outcome: 'unchanged',
      memory: r.memory,
      redacted: redactJudgment(normaliseJudgment(input, now)).redacted,
    };
  }
  if (r.kind !== 'write') throw new Error('unreachable: a single record is never skipped');
  const failed = await commit([r.planned], deps, now);
  const { memory, prior, redacted } = r.planned;
  return {
    outcome: prior === undefined ? 'added' : 'corrected',
    memory,
    ...(prior !== undefined && { supersedes: prior.id }),
    redacted,
    ...(failed > 0 && { embedFailed: true as const }),
  };
}

export interface ImportJudgmentsResult {
  added: number;
  corrected: number;
  /** Already recorded with the same decision. */
  unchanged: number;
  /** The same decision was withdrawn, corrected or purged here: not brought back. */
  tombstoned: number;
  /** Rows a secret was redacted from. */
  redacted: number;
  /** Rows the embedder failed on (kept, lexical-only). */
  embedFailed: number;
}

/**
 * Records many judgments (a bulk import of past decisions), reading the store once and embedding
 * in batches. Every row is checked before anything is written, and more than
 * `JUDGMENT_LIMITS.importRows` is refused. A row matching a decision withdrawn, corrected or purged
 * here is skipped and counted (`tombstoned`).
 */
export async function importJudgments(
  rows: readonly JudgmentInput[],
  deps: RecordJudgmentDeps & { via?: 'import' | 'sdk' },
): Promise<ImportJudgmentsResult> {
  if (rows.length > JUDGMENT_LIMITS.importRows) {
    throw new JudgmentInputError(
      `an import holds at most ${JUDGMENT_LIMITS.importRows} rows; this one has ${rows.length}`,
    );
  }
  const now = deps.now ?? new Date();
  for (const [i, row] of rows.entries()) {
    try {
      normaliseJudgment(row, now);
    } catch (e) {
      throw new JudgmentInputError(`row ${i + 1}: ${(e as Error).message}`);
    }
  }
  const index = await indexJudgments(deps.store, deps.grant, now);
  const out: ImportJudgmentsResult = {
    added: 0,
    corrected: 0,
    unchanged: 0,
    tombstoned: 0,
    redacted: 0,
    embedFailed: 0,
  };
  const planned: Planned[] = [];
  for (const row of rows) {
    const r = plan(row, { deps, via: deps.via ?? 'import', index, now, tombstones: true });
    if (r.kind === 'unchanged' || r.kind === 'duplicate') out.unchanged++;
    else if (r.kind === 'tombstoned') out.tombstoned++;
    else {
      planned.push(r.planned);
      if (r.planned.prior === undefined) out.added++;
      else out.corrected++;
      if (r.planned.redacted.length > 0) out.redacted++;
    }
  }
  out.embedFailed = await commit(planned, deps, now);
  return out;
}

/** The text a judgment is embedded and matched by: what was judged and why. */
function embedText(j: Pick<Judgment, 'subject' | 'reason' | 'criteria' | 'domain'>): string {
  return `${j.subject.summary}\n${j.reason}\n${j.criteria.join(' ')} ${j.domain}`;
}

function sameDecision(a: Judgment, b: Judgment): boolean {
  return (
    a.verdict === b.verdict &&
    a.reason === b.reason &&
    a.subject.summary === b.subject.summary &&
    a.criteria.join(',') === b.criteria.join(',')
  );
}

function judgmentMemory(
  j: Judgment,
  scope: Scope,
  grant: Grant,
  now: Date,
  harness: string,
): Memory & { judgment: Judgment } {
  const iso = now.toISOString();
  // Judgments belong to the expert, not to a repository: unbound to any project.
  const { projectId: _p, ...unbound } = scope;
  const at =
    grant.home.level === 'user'
      ? { scope: unbound }
      : addressed(homeAddress(grant), { agentId: scope.agentId });
  return {
    id: randomUUID(),
    ...at,
    type: 'judgment',
    text: judgmentText(j),
    stub: `${j.verdict}: ${j.subject.summary.slice(0, 80)}`,
    entities: [...new Set([j.domain, ...j.criteria])],
    salience: 0.8,
    // Pinned: never sent to cold, so judging keeps its embedding.
    pinned: true,
    tier: 'hot',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: j.decidedAt,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness, decisions: [] },
    judgment: j,
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * Withdraws a judgment: it is marked withdrawn (by which operator, when), retracted and its
 * validity closed, so judging, recall (every time mode), export and packs stop using it at once,
 * and its tombstone keeps imports from bringing it back. The record stays for
 * `oort judge list --all`; `purgeJudgment` removes its text. Returns false when it was already
 * withdrawn or is not a judgment.
 */
export async function withdrawJudgment(
  store: MemoryStore,
  grant: Grant,
  m: Memory,
  by: string,
  now = new Date(),
): Promise<boolean> {
  if (m.type !== 'judgment' || m.judgment === undefined) return false;
  // Withdrawn already, unless it arrived so (imported, no tombstone of a person here): then this
  // withdrawal is a person's, and writes the tombstone that keeps the decision out (CON-137).
  if (m.judgment.withdrawn !== undefined && !arrivedEnded(m.judgment)) return false;
  const iso = now.toISOString();
  const full = (await store.get(grant, m.id)) ?? m;
  const j = full.judgment ?? m.judgment;
  await store.upsert(grant, {
    ...full,
    judgment: {
      ...j,
      withdrawn: { at: iso, by },
      tombstone: j.tombstone ?? tombstoneKey(j),
    },
    expiredAt: full.expiredAt ?? iso,
    endReason: full.endReason ?? 'expired',
    validTo: closeAt(full, now),
    updatedAt: iso,
  });
  return true;
}

/**
 * Confirms an agent-recorded (`mcp`) judgment: a person (`by`, the operator) vouches that the
 * expert really decided it, and judging uses it from then on. Only for a current, unconfirmed
 * agent-recorded judgment; returns false otherwise. Never offered over MCP.
 */
export async function confirmJudgment(
  store: MemoryStore,
  grant: Grant,
  m: Memory,
  by: string,
  now = new Date(),
): Promise<boolean> {
  if (!isActiveJudgment(m, now) || !isUnconfirmedAgentJudgment(m.judgment)) return false;
  const iso = now.toISOString();
  const full = (await store.get(grant, m.id)) ?? m;
  const j = { ...(full.judgment ?? m.judgment), confirmed: { at: iso, by } };
  await store.upsert(grant, { ...full, judgment: j, text: judgmentText(j), updatedAt: iso });
  return true;
}

/** The text a purged judgment keeps. */
const PURGED = '[purged]';

/**
 * Purges a judgment's text: withdraws it if it is not already, keeps its tombstone, and blanks
 * the subject, ref, reason, criteria, memory text and embedding. What is left is an audit stub:
 * the expert, domain, verdict, times, who withdrew and purged it, and the tombstone. Returns false
 * when it was already purged or is not a judgment.
 */
export async function purgeJudgment(
  store: MemoryStore,
  grant: Grant,
  m: Memory,
  by: string,
  now = new Date(),
): Promise<boolean> {
  if (m.type !== 'judgment' || m.judgment === undefined) return false;
  // Purged already, unless it arrived so: as for withdrawing (CON-137).
  if (m.judgment.purged !== undefined && !arrivedEnded(m.judgment)) return false;
  const iso = now.toISOString();
  const full = (await store.get(grant, m.id)) ?? m;
  const j = full.judgment ?? m.judgment;
  const { embedding: _e, ...rest } = full;
  const stub: Judgment = {
    ...j,
    subject: { summary: PURGED },
    reason: PURGED,
    criteria: [],
    withdrawn: j.withdrawn ?? { at: iso, by },
    purged: { at: iso, by },
    tombstone: j.tombstone ?? tombstoneKey(j),
  };
  await store.upsert(grant, {
    ...rest,
    judgment: stub,
    text: `Purged judgment by ${j.by} (${j.domain}).`,
    stub: PURGED,
    entities: [j.domain],
    expiredAt: full.expiredAt ?? iso,
    endReason: full.endReason ?? 'expired',
    validTo: closeAt(full, now),
    updatedAt: iso,
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Applying judgments
// ---------------------------------------------------------------------------------------------

/** The item to judge. */
export interface JudgeItem {
  summary: string;
  details?: string;
  ref?: string;
  /** Only precedents of this domain count. */
  domain?: string;
  /** Only this expert's precedents count. */
  by?: string;
}

export interface JudgeOptions {
  /** How many precedents to use. Default 5. */
  k?: number;
  /** The probability a prediction needs; below it the answer is "needs the expert". Default 0.7. */
  threshold?: number;
  /** The similarity a precedent needs to count as near. Default 0.45 (dense) or 0.25 (lexical). */
  minSimilarity?: number;
  /** The share of the near precedents' weight one verdict needs; below it they disagree. Default 0.6. */
  minAgreement?: number;
  /**
   * Also use judgments imported from packs. Default false: a pack's experts are whoever its
   * exporter says they are, so only judgments made here count unless the caller asks.
   */
  includeImported?: boolean;
  /**
   * Also use agent-recorded judgments nobody confirmed. Default false: an agent could have
   * recorded anything in an expert's name.
   */
  includeAgentRecorded?: boolean;
  /** Leave these out (evaluation: an item never counts as its own precedent). */
  exclude?: (m: Memory & { judgment: Judgment }) => boolean;
}

export const JUDGE_DEFAULTS = Object.freeze({
  k: 5,
  threshold: 0.7,
  minSimilarityDense: 0.45,
  minSimilarityLexical: 0.25,
  minAgreement: 0.6,
  /** A suggestion needs at least this many near precedents agreeing with it. */
  minAgreeing: 2,
});

export interface JudgeDeps {
  store: MemoryStore;
  grant: Grant;
  embed?: Embedder;
  /** Its `judge` makes the prediction; without it judging returns precedents only. */
  decide?: Pick<DecisionController, 'judge'>;
  now?: Date;
}

/** One precedent as a judging result cites it. */
export interface Precedent {
  id: string;
  subject: JudgmentSubject;
  verdict: string;
  reason: string;
  criteria: string[];
  domain: string;
  by: string;
  decidedAt: string;
  similarity: number;
  /** At least `minSimilarity`: it counted. */
  near: boolean;
  /** Its verdict is the predicted one. */
  agrees?: boolean;
  /** How it was recorded (`mcp`: by an agent). */
  via: JudgmentVia;
  /** A person recorded it, or confirmed an agent's record of it. */
  confirmed: boolean;
  /** Imported from this pack: its expert is as the pack's exporter states it. */
  pack?: { id: string; name: string };
  imported?: true;
}

/**
 * Why the answer is not a confident prediction:
 * `no-precedents` (nothing recorded for this domain or expert), `too-far` (nothing close enough),
 * `too-few` (fewer than two near precedents agree with the answer), `precedents-disagree` (the
 * near precedents split), `low-confidence` (the prediction is below the threshold), `no-decider`
 * (no Jev key: precedents only), `decider-failed` (the call failed).
 */
export type JudgeWhy =
  | 'no-precedents'
  | 'too-far'
  | 'too-few'
  | 'precedents-disagree'
  | 'low-confidence'
  | 'no-decider'
  | 'decider-failed';

export interface JudgeResult {
  /**
   * `suggested`: a prediction at or above the threshold that at least two near precedents agree
   * with. `needs-expert`: no prediction can be trusted (see `why`). `precedents-only`: no decider,
   * so here are the precedents, no verdict.
   */
  status: 'suggested' | 'needs-expert' | 'precedents-only';
  why?: JudgeWhy;
  /**
   * A prediction, never the expert's decision: present with `suggested`, and as a lean with
   * `low-confidence` and `too-few`.
   */
  prediction?: { verdict: string; probability: number; probabilities: Record<string, number> };
  /** The precedents used (near ones), or the nearest ones when none is near. Nearest first. */
  precedents: Precedent[];
  /** The verdicts offered to the decider: those the near precedents voted for. */
  verdicts: string[];
  /** The near precedents' verdicts, weighted by similarity, as shares. */
  agreement: Record<string, number>;
  similarity: 'dense' | 'lexical';
  threshold: number;
  minSimilarity: number;
  degraded?: ('embed-failed' | 'decider-failed')[];
  decisions: Decision[];
  /** Imported judgments that matched the filters but were left out (`includeImported` false). */
  importedExcluded?: number;
  /** Unconfirmed agent-recorded judgments left out (`includeAgentRecorded` false). */
  agentRecordedExcluded?: number;
}

function cosine(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Overlap of informative words, as the cosine of the two word sets (0 to 1). */
function lexicalSimilarity(q: Set<string>, d: Set<string>): number {
  if (q.size === 0 || d.size === 0) return 0;
  let shared = 0;
  for (const t of q) if (d.has(t)) shared++;
  return shared / Math.sqrt(q.size * d.size);
}

/**
 * The active judgments of `filter`'s domain and expert (when it names them). Judgments imported
 * from packs only with `includeImported`, unconfirmed agent-recorded ones only with
 * `includeAgentRecorded`.
 */
export async function activeJudgments(
  store: MemoryStore,
  grant: Grant,
  filter: {
    domain?: string;
    by?: string;
    includeImported?: boolean;
    includeAgentRecorded?: boolean;
  },
  now: Date,
  embeddings = true,
): Promise<(Memory & { judgment: Judgment })[]> {
  const domain =
    filter.domain === undefined ? undefined : judgmentLabel('domain', filter.domain, DOMAIN);
  return (await store.list(grant, { embeddings })).filter(
    (m): m is Memory & { judgment: Judgment } =>
      isActiveJudgment(m, now) &&
      (filter.includeImported === true || m.judgment.pack === undefined) &&
      (filter.includeAgentRecorded === true || !isUnconfirmedAgentJudgment(m.judgment)) &&
      (domain === undefined || m.judgment.domain === domain) &&
      (filter.by === undefined || m.judgment.by === filter.by),
  );
}

/** The label offered beside a single voted verdict: "not that one". */
const OTHER = 'other';

/**
 * Applies the expert's judgments to `item`: finds the nearest active precedents (domain- and
 * expert-filtered), then asks the decider for a choice over the verdicts they voted for, with the
 * precedents and their reasons as state. It answers "needs the expert" instead of guessing when
 * there are no precedents, none is near, fewer than two near precedents would back the answer,
 * the near ones disagree, or the prediction is below `threshold`; and returns precedents only
 * when there is no decider. Never writes anything.
 */
export async function judge(
  item: JudgeItem,
  deps: JudgeDeps,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const now = deps.now ?? new Date();
  const k = Math.max(1, Math.min(opts.k ?? JUDGE_DEFAULTS.k, 20));
  const threshold = opts.threshold ?? JUDGE_DEFAULTS.threshold;
  const minAgreement = opts.minAgreement ?? JUDGE_DEFAULTS.minAgreement;
  const summary = scrub(item.summary).text;
  const details = item.details === undefined ? undefined : scrub(item.details).text;
  const every = (
    await activeJudgments(
      deps.store,
      deps.grant,
      { ...item, includeImported: true, includeAgentRecorded: true },
      now,
    )
  ).filter((m) => opts.exclude === undefined || !opts.exclude(m));
  const notImported =
    opts.includeImported === true ? every : every.filter((m) => m.judgment.pack === undefined);
  const all =
    opts.includeAgentRecorded === true
      ? notImported
      : notImported.filter((m) => !isUnconfirmedAgentJudgment(m.judgment));
  const importedExcluded = every.length - notImported.length;
  const agentRecordedExcluded = notImported.length - all.length;
  const degraded: NonNullable<JudgeResult['degraded']> = [];

  // Similarity: dense when an embedder is wired (precedents recorded without a vector are embedded
  // now, not stored), lexical otherwise or when embedding fails.
  let sims: number[] | undefined;
  if (deps.embed !== undefined && all.length > 0) {
    try {
      const [q] = await deps.embed.embed([`${summary}\n${details ?? ''}`.trim()], 'query');
      const missing = all.filter((m) => m.embedding?.length !== q?.length);
      const fresh: Int8Array[] = [];
      for (let i = 0; i < missing.length; i += EMBED_BATCH) {
        fresh.push(
          ...(await deps.embed.embed(
            missing.slice(i, i + EMBED_BATCH).map((m) => embedText(m.judgment)),
            'document',
          )),
        );
      }
      const vec = new Map(missing.map((m, i) => [m.id, fresh[i]]));
      if (q !== undefined) {
        sims = all.map((m) => {
          const v = vec.get(m.id) ?? m.embedding;
          return v === undefined || v.length !== q.length ? 0 : Math.max(0, cosine(q, v));
        });
      }
    } catch {
      degraded.push('embed-failed');
    }
  }
  const mode: JudgeResult['similarity'] = sims === undefined ? 'lexical' : 'dense';
  if (sims === undefined) {
    const q = informativeTokens(`${summary} ${details ?? ''}`);
    sims = all.map((m) => lexicalSimilarity(q, informativeTokens(embedText(m.judgment))));
  }
  const minSimilarity =
    opts.minSimilarity ??
    (mode === 'dense' ? JUDGE_DEFAULTS.minSimilarityDense : JUDGE_DEFAULTS.minSimilarityLexical);

  const ranked = all
    .map((m, i) => ({ m, similarity: sims[i] ?? 0 }))
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        Date.parse(b.m.judgment.decidedAt) - Date.parse(a.m.judgment.decidedAt) ||
        (a.m.id < b.m.id ? -1 : 1),
    );
  const near = ranked.filter((r) => r.similarity >= minSimilarity).slice(0, k);
  const shown = near.length > 0 ? near : ranked.slice(0, k);
  const precedents = shown.map(({ m, similarity }) => precedentOf(m, similarity, minSimilarity));

  // Only verdicts the near precedents voted for are offered; a single one is offered against
  // "other", so the decider can still say the item is not like them.
  const voted = [...new Set(near.map((r) => r.m.judgment.verdict))];
  const verdicts =
    voted.length === 1 ? [voted[0]!, voted[0] === OTHER ? 'something-else' : OTHER] : voted;
  const agreement = shares(near.map((r) => [r.m.judgment.verdict, Math.max(r.similarity, 1e-6)]));
  const base = {
    precedents,
    verdicts,
    agreement,
    similarity: mode,
    threshold,
    minSimilarity,
    decisions: [] as Decision[],
    ...(degraded.length > 0 && { degraded }),
    ...(importedExcluded > 0 && { importedExcluded }),
    ...(agentRecordedExcluded > 0 && { agentRecordedExcluded }),
  };

  if (all.length === 0) return { status: 'needs-expert', why: 'no-precedents', ...base };
  if (near.length === 0) return { status: 'needs-expert', why: 'too-far', ...base };
  if (near.length < JUDGE_DEFAULTS.minAgreeing) {
    return { status: 'needs-expert', why: 'too-few', ...base };
  }
  const top = Math.max(...Object.values(agreement));
  if (top < minAgreement) return { status: 'needs-expert', why: 'precedents-disagree', ...base };
  if (deps.decide?.judge === undefined) {
    return { status: 'precedents-only', why: 'no-decider', ...base };
  }

  let choice: JudgeChoice;
  try {
    choice = await deps.decide.judge({
      item: {
        summary,
        ...(details !== undefined && { details }),
        ...(item.ref !== undefined && { ref: scrub(item.ref).text }),
        ...(item.domain !== undefined && { domain: item.domain }),
      },
      verdicts,
      precedents: near.map(({ m, similarity }) => ({
        subject: m.judgment.subject.summary,
        ...(m.judgment.subject.ref !== undefined && { ref: m.judgment.subject.ref }),
        verdict: m.judgment.verdict,
        reason: m.judgment.reason,
        criteria: m.judgment.criteria,
        decidedAt: m.judgment.decidedAt,
        similarity: round(similarity),
      })),
    });
  } catch {
    return {
      status: 'needs-expert',
      why: 'decider-failed',
      ...base,
      degraded: [...degraded, 'decider-failed'],
    };
  }
  if (!verdicts.includes(choice.verdict)) {
    return {
      status: 'needs-expert',
      why: 'decider-failed',
      ...base,
      degraded: [...degraded, 'decider-failed'],
    };
  }
  // Against "other", the prediction is always the voted verdict, at its own probability.
  const verdict = voted.length === 1 ? voted[0]! : choice.verdict;
  const probability = Object.hasOwn(choice.probabilities, verdict)
    ? (choice.probabilities[verdict] ?? 0)
    : verdict === choice.verdict
      ? choice.probability
      : 0;
  for (const p of precedents) p.agrees = p.verdict === verdict;
  const agreeing = near.filter((r) => r.m.judgment.verdict === verdict).length;
  const prediction = { verdict, probability, probabilities: choice.probabilities };
  const why: JudgeWhy | undefined =
    agreeing < JUDGE_DEFAULTS.minAgreeing
      ? 'too-few'
      : probability < threshold
        ? 'low-confidence'
        : undefined;
  return {
    status: why === undefined ? 'suggested' : 'needs-expert',
    ...(why !== undefined && { why }),
    ...base,
    prediction,
    decisions: choice.decisions,
  };
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

function shares(weights: [string, number][]): Record<string, number> {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const sums = new Map<string, number>();
  for (const [v, w] of weights) sums.set(v, (sums.get(v) ?? 0) + w);
  return Object.fromEntries([...sums].map(([v, w]) => [v, total === 0 ? 0 : round(w / total)]));
}

function precedentOf(
  m: Memory & { judgment: Judgment },
  similarity: number,
  minSimilarity: number,
): Precedent {
  const j = m.judgment;
  return {
    id: m.id,
    subject: { ...j.subject },
    verdict: j.verdict,
    reason: j.reason,
    criteria: [...j.criteria],
    domain: j.domain,
    by: j.by,
    decidedAt: j.decidedAt,
    similarity: round(similarity),
    near: similarity >= minSimilarity,
    via: j.via,
    confirmed: !isUnconfirmedAgentJudgment(j),
    ...(j.pack !== undefined && {
      pack: { id: j.pack.id, name: j.pack.name },
      imported: true as const,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------------------------

export const JUDGMENT_PACK_VERSION = 1;

/** The first line of a pack. */
export interface JudgmentPackManifest {
  oort: 'judgment-pack';
  version: 1;
  name: string;
  exportedAt: string;
  /** The agent that exported it. */
  exportedBy: string;
  count: number;
  /**
   * sha256 over the manifest's metadata (version, name, exportedAt, exportedBy) and the judgment
   * lines, as `packDigest` computes it. Its first 16 hex characters are the pack's id.
   */
  digest: string;
  /** The domains and experts inside. A reader checks them against the lines (they must match). */
  domains: string[];
  experts: string[];
}

/** One judgment in a pack: the decision and its id, without vectors or local state. */
export interface JudgmentPackLine {
  id: string;
  judgment: Omit<Judgment, 'withdrawn' | 'via' | 'pack'> & {
    via: JudgmentVia;
    /**
     * Where the exporter got it, when it was itself imported: the exporter's own record, which a
     * reader keeps only as an untrusted claim (`claimedEarlier`).
     */
    pack?: Omit<JudgmentPackOrigin, 'claimedEarlier'>;
  };
}

/** Raised for a file that is not a readable judgment pack. */
export class JudgmentPackError extends Error {
  override readonly name = 'JudgmentPackError';
}

/** Length caps for pack metadata. */
export const PACK_LIMITS = Object.freeze({ name: 120, exportedBy: 128, id: 128, time: 40 });

const PACK_ORIGIN_KEYS = [
  'id',
  'name',
  'exportedAt',
  'exportedBy',
  'originalId',
  'importedAt',
] as const;

/** Plain one-line text: a string, not empty, at most `max`, no control, bidi or invisible characters. */
function packText(field: string, v: unknown, max: number): string {
  if (
    typeof v !== 'string' ||
    v === '' ||
    v.length > max ||
    CONTROL.test(v) ||
    /[\n\r]/.test(v) ||
    INVISIBLE.test(v)
  ) {
    throw new JudgmentPackError(
      `${field} must be one line of plain text, at most ${max} characters`,
    );
  }
  return v;
}

function packTime(field: string, v: unknown): string {
  const t = packText(field, v, PACK_LIMITS.time);
  if (Number.isNaN(Date.parse(t))) throw new JudgmentPackError(`${field} is not an ISO time`);
  // Stored normalised: Date.parse also accepts words ("Verified by Oort 2026").
  return new Date(t).toISOString();
}

/**
 * The origin of a judgment read from an Oort export file (`oort import <file>`, CON-137), checked
 * as a pack's is: the file's name and its manifest's `exportedAt` are plain text and a time, or
 * fall back to a constant and `now`. `digest` is the file's SHA-256, hex.
 */
export function fileOrigin(o: {
  digest: string;
  name: unknown;
  exportedAt: unknown;
  originalId: string;
  now: Date;
}): JudgmentPackOrigin {
  const or = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  return {
    id: o.digest.slice(0, 16),
    name: or(() => packText('name', o.name, PACK_LIMITS.name), 'export file'),
    exportedAt: or(() => packTime('exportedAt', o.exportedAt), o.now.toISOString()),
    exportedBy: 'oort import',
    originalId: packText('id', o.originalId, PACK_LIMITS.id),
    importedAt: o.now.toISOString(),
  };
}

/** A withdrawal or purge as a file states it: exactly `{ at, by }`, a time and plain text. */
function endMark(field: string, v: unknown): { at: string; by: string } | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new JudgmentPackError(`${field} must be { at, by }`);
  }
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'at,by') {
    throw new JudgmentPackError(`${field} must have exactly at and by`);
  }
  return {
    at: packTime(`${field}.at`, o['at']),
    by: packText(`${field}.by`, o['by'], PACK_LIMITS.exportedBy),
  };
}

/**
 * A judgment read from an Oort export file, as this store keeps it (CON-137): the decision
 * normalised and redacted as a pack's is, imported (`via: 'pack'` from `origin`), never confirmed
 * and with no tombstone of its own. A withdrawal or purge the line states is kept, checked, so an
 * ended decision stays ended. Throws `JudgmentInputError` or `JudgmentPackError` otherwise.
 */
export function importedJudgment(raw: unknown, origin: JudgmentPackOrigin): Judgment {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new JudgmentPackError('judgment must be an object');
  }
  const j = raw as Record<string, unknown>;
  if (typeof j['decidedAt'] !== 'string') throw new JudgmentPackError('decidedAt is missing');
  const { judgment: core } = redactJudgment(
    normaliseJudgment(packInput(j as unknown as JudgmentPackLine['judgment']), new Date(0)),
  );
  const withdrawn = endMark('withdrawn', j['withdrawn']);
  const purged = endMark('purged', j['purged']);
  return {
    ...core,
    via: 'pack',
    pack: origin,
    ...(withdrawn !== undefined && { withdrawn }),
    ...(purged !== undefined && { purged }),
  };
}

/** A line's claimed earlier origin: exactly the six fields, each plain text. */
function claimedOrigin(v: unknown, where: string): ClaimedPackOrigin {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new JudgmentPackError(`${where}: pack must be an object`);
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== [...PACK_ORIGIN_KEYS].sort().join(',')) {
    throw new JudgmentPackError(`${where}: pack must have exactly ${PACK_ORIGIN_KEYS.join(', ')}`);
  }
  packTime(`${where}: pack.importedAt`, o['importedAt']);
  return {
    untrusted: true,
    id: packText(`${where}: pack.id`, o['id'], PACK_LIMITS.id),
    name: packText(`${where}: pack.name`, o['name'], PACK_LIMITS.name),
    exportedAt: packTime(`${where}: pack.exportedAt`, o['exportedAt']),
    exportedBy: packText(`${where}: pack.exportedBy`, o['exportedBy'], PACK_LIMITS.exportedBy),
    originalId: packText(`${where}: pack.originalId`, o['originalId'], PACK_LIMITS.id),
  };
}

const lineOf = (m: Memory & { judgment: Judgment }): JudgmentPackLine => {
  const { withdrawn: _w, confirmed: _c, purged: _p, tombstone: _t, pack, ...j } = m.judgment;
  // The exporter's own import record travels, field by field; a claim it holds itself does not.
  return {
    id: m.id,
    judgment: {
      ...j,
      ...(pack !== undefined && {
        pack: {
          id: pack.id,
          name: pack.name,
          exportedAt: pack.exportedAt,
          exportedBy: pack.exportedBy,
          originalId: pack.originalId,
          importedAt: pack.importedAt,
        },
      }),
    },
  };
};

/** What the digest binds besides the lines. */
export interface PackMeta {
  name: string;
  exportedAt: string;
  exportedBy: string;
}

/**
 * The digest of a pack: hex sha256 over its metadata (version, name, exportedAt, exportedBy, as a
 * JSON array) and then each judgment line as written. Changing the name, the exporter, the time or
 * any line changes it.
 */
export function packDigest(meta: PackMeta, lines: readonly string[]): string {
  const h = createHash('sha256');
  h.update(
    JSON.stringify([
      'judgment-pack',
      JUDGMENT_PACK_VERSION,
      meta.name,
      meta.exportedAt,
      meta.exportedBy,
    ]),
  ).update('\n');
  for (const l of lines) h.update(l).update('\n');
  return h.digest('hex');
}

const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * A pack of `judgments` (active ones only; withdrawn and corrected ones never travel), as JSON
 * Lines: a manifest, then one line per judgment in id order. Attribution (`by`, `decidedAt`)
 * travels with each judgment; embeddings do not (the importer embeds them with its own model).
 */
export function formatJudgmentPack(
  judgments: readonly Memory[],
  meta: { name: string; exportedBy: string; exportedAt: Date },
  now = meta.exportedAt,
): string {
  const active = judgments
    .filter((m): m is Memory & { judgment: Judgment } => isActiveJudgment(m, now))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = active.map((m) => JSON.stringify(lineOf(m)));
  const bound: PackMeta = {
    name: packText('name', meta.name, PACK_LIMITS.name),
    exportedAt: meta.exportedAt.toISOString(),
    exportedBy: packText('exportedBy', meta.exportedBy, PACK_LIMITS.exportedBy),
  };
  const manifest: JudgmentPackManifest = {
    oort: 'judgment-pack',
    version: JUDGMENT_PACK_VERSION,
    ...bound,
    count: lines.length,
    digest: packDigest(bound, lines),
    domains: sortedUnique(active.map((m) => m.judgment.domain)),
    experts: sortedUnique(active.map((m) => m.judgment.by)),
  };
  return [JSON.stringify(manifest), ...lines].join('\n') + '\n';
}

export interface ParsedJudgmentPack {
  manifest: JudgmentPackManifest;
  lines: JudgmentPackLine[];
}

/**
 * Reads a pack and checks everything a person is shown before importing it: the manifest's
 * metadata (plain text, length caps), the count, the digest over the metadata and the lines, every
 * judgment as `recordJudgment` would check it, any claimed earlier origin (exact shape), and that
 * the manifest's domains and experts are exactly those of the lines. The lines come back rebuilt
 * from their checked fields only. The digest proves integrity, not authorship: a pack is as
 * trustworthy as whoever handed it over. Throws `JudgmentPackError`.
 */
export function parseJudgmentPack(textIn: string): ParsedJudgmentPack {
  const raw = textIn.split('\n').filter((l) => l.trim() !== '');
  const parse = (l: string, n: number): unknown => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      throw new JudgmentPackError(`line ${n} is not JSON`);
    }
  };
  const head = parse(raw[0] ?? '', 1) as Partial<JudgmentPackManifest> | null;
  if (head?.oort !== 'judgment-pack') {
    throw new JudgmentPackError('line 1 is not an Oort judgment pack manifest');
  }
  if (head.version !== JUDGMENT_PACK_VERSION) {
    throw new JudgmentPackError(`judgment pack version ${String(head.version)} is not supported`);
  }
  const meta: PackMeta = {
    name: packText('the manifest name', head.name, PACK_LIMITS.name),
    exportedAt: packTime('the manifest exportedAt', head.exportedAt),
    exportedBy: packText('the manifest exportedBy', head.exportedBy, PACK_LIMITS.exportedBy),
  };
  const body = raw.slice(1);
  if (body.length > JUDGMENT_LIMITS.importRows) {
    throw new JudgmentPackError(
      `a pack holds at most ${JUDGMENT_LIMITS.importRows} judgments; this one has ${body.length}`,
    );
  }
  if (head.count !== body.length) {
    throw new JudgmentPackError(
      `the manifest says ${String(head.count)} judgments, the file holds ${body.length}`,
    );
  }
  // The digest binds the manifest as written; what is kept is the normalised time.
  const digest = packDigest({ ...meta, exportedAt: head.exportedAt as string }, body);
  if (head.digest !== digest) {
    throw new JudgmentPackError('the digest does not match: the pack was changed or cut short');
  }
  const lines = body.map((l, i): JudgmentPackLine => {
    const where = `line ${i + 2}`;
    const x = parse(l, i + 2) as { id?: unknown; judgment?: unknown } | null;
    if (
      typeof x !== 'object' ||
      x === null ||
      typeof x.judgment !== 'object' ||
      x.judgment === null
    ) {
      throw new JudgmentPackError(`${where} is not a judgment`);
    }
    const id = packText(`${where}: id`, x.id, PACK_LIMITS.id);
    const j = x.judgment as JudgmentPackLine['judgment'];
    if (typeof j.decidedAt !== 'string')
      throw new JudgmentPackError(`${where}: decidedAt is missing`);
    let n: ReturnType<typeof normaliseJudgment>;
    try {
      n = normaliseJudgment(packInput(j), new Date(0));
    } catch (e) {
      throw new JudgmentPackError(`${where}: ${(e as Error).message}`);
    }
    const claim = j.pack === undefined ? undefined : claimedOrigin(j.pack, where);
    const via: JudgmentVia = (['cli', 'mcp', 'import', 'pack', 'sdk'] as const).includes(j.via)
      ? j.via
      : 'pack';
    return {
      id,
      judgment: {
        ...n,
        via,
        ...(claim !== undefined && {
          pack: {
            id: claim.id,
            name: claim.name,
            exportedAt: claim.exportedAt,
            exportedBy: claim.exportedBy,
            originalId: claim.originalId,
            importedAt: (j.pack as { importedAt: string }).importedAt,
          },
        }),
      },
    };
  });
  const domains = sortedUnique(lines.map((l) => l.judgment.domain));
  const experts = sortedUnique(lines.map((l) => l.judgment.by));
  const same = (a: unknown, b: string[]) =>
    Array.isArray(a) &&
    a.every((x) => typeof x === 'string') &&
    JSON.stringify(sortedUnique(a)) === JSON.stringify(b) &&
    a.length === b.length;
  if (!same(head.domains, domains) || !same(head.experts, experts)) {
    throw new JudgmentPackError("the manifest's domains or experts do not match its judgments");
  }
  return {
    manifest: {
      oort: 'judgment-pack',
      version: JUDGMENT_PACK_VERSION,
      ...meta,
      count: lines.length,
      digest,
      domains,
      experts,
    },
    lines,
  };
}

/** A pack line's judgment as recording input. */
export function packInput(j: JudgmentPackLine['judgment']): JudgmentInput {
  return {
    subject: j.subject?.summary,
    ...(j.subject?.ref !== undefined && { ref: j.subject.ref }),
    verdict: j.verdict,
    verdicts: j.verdicts,
    reason: j.reason,
    criteria: j.criteria ?? [],
    domain: j.domain,
    by: j.by,
    decidedAt: j.decidedAt,
  };
}

export interface ImportPackResult {
  added: string[];
  /**
   * Line ids not added because they are already here: imported from this very pack before (same
   * digest and line id), or the same exact decision is in the store, from any origin.
   */
  skipped: string[];
  /**
   * Line ids whose decision was withdrawn, corrected or purged here (matched by its tombstone,
   * whatever `decidedAt` the pack gives it): never brought back.
   */
  tombstoned: string[];
}

/**
 * Imports a parsed pack into the grant's home node, reading the store once and embedding in
 * batches. Each judgment keeps its expert and decision time, and records where it came from:
 * `judgment.pack`, built only from this pack (its digest id, the digest-bound name, exporter and
 * time, and the line's id). An earlier origin the line claims is kept apart as `claimedEarlier`,
 * marked untrusted, and used for nothing.
 *
 * A line is skipped when this pack was imported before (same digest and line id) or the same
 * exact decision is already here, and reported as tombstoned when its decision was withdrawn,
 * corrected or purged here: a pack never brings back what an expert took back.
 */
export async function importJudgmentPack(
  pack: ParsedJudgmentPack,
  deps: RecordJudgmentDeps,
): Promise<ImportPackResult> {
  if (pack.lines.length > JUDGMENT_LIMITS.importRows) {
    throw new JudgmentPackError(
      `a pack holds at most ${JUDGMENT_LIMITS.importRows} judgments; this one has ${pack.lines.length}`,
    );
  }
  const now = deps.now ?? new Date();
  const index = await indexJudgments(deps.store, deps.grant, now);
  const id = pack.manifest.digest.slice(0, 16);
  const out: ImportPackResult = { added: [], skipped: [], tombstoned: [] };
  const planned: Planned[] = [];
  for (const line of pack.lines) {
    const claim = line.judgment.pack;
    const origin: JudgmentPackOrigin = {
      id,
      name: pack.manifest.name,
      exportedAt: pack.manifest.exportedAt,
      exportedBy: pack.manifest.exportedBy,
      originalId: line.id,
      importedAt: now.toISOString(),
      ...(claim !== undefined && {
        claimedEarlier: {
          untrusted: true,
          id: claim.id,
          name: claim.name,
          exportedAt: claim.exportedAt,
          exportedBy: claim.exportedBy,
          originalId: claim.originalId,
        },
      }),
    };
    const r = plan(packInput(line.judgment), {
      deps,
      via: 'pack',
      pack: origin,
      index,
      now,
      tombstones: true,
      importedKey: `${id}:${line.id}`,
    });
    if (r.kind === 'write') {
      planned.push(r.planned);
      out.added.push(r.planned.memory.id);
    } else if (r.kind === 'tombstoned') out.tombstoned.push(line.id);
    else out.skipped.push(line.id);
  }
  await commit(planned, deps, now);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bulk import: past decisions from CSV or JSON Lines
// ---------------------------------------------------------------------------------------------

/** Rows of a CSV file (RFC 4180: quoted fields, `""` for a quote, newlines inside quotes). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
    i++;
  }
  if (quoted) throw new JudgmentInputError('the CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Nothing here writes CSV. A future CSV writer (an export of judgments for a spreadsheet) must
// guard every cell against formula injection: prefix a cell that starts with =, +, -, @, a tab or
// a carriage return with a single quote, since reasons and subjects are free text.

const COLUMN: Readonly<Record<string, keyof JudgmentInput>> = Object.freeze({
  subject: 'subject',
  ref: 'ref',
  link: 'ref',
  verdict: 'verdict',
  decision: 'verdict',
  verdicts: 'verdicts',
  reason: 'reason',
  criteria: 'criteria',
  domain: 'domain',
  by: 'by',
  expert: 'by',
  decided_at: 'decidedAt',
  decidedat: 'decidedAt',
});

/** The field a column or JSON key names, by own property only (never `constructor` and the like). */
const columnOf = (name: string): keyof JudgmentInput | undefined => {
  const k = name.trim().toLowerCase();
  return Object.hasOwn(COLUMN, k) ? COLUMN[k] : undefined;
};

function list(field: string, v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) {
    if (v.length > JUDGMENT_LIMITS.verdicts) {
      throw new JudgmentInputError(`${field} has more than ${JUDGMENT_LIMITS.verdicts} entries`);
    }
    if (!v.every((x) => typeof x === 'string')) {
      throw new JudgmentInputError(`${field} must be a list of text labels`);
    }
    return v as string[];
  }
  if (typeof v !== 'string') throw new JudgmentInputError(`${field} must be a list or text`);
  return v
    .split(/[;|]/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

function rowInput(
  raw: Partial<Record<keyof JudgmentInput, unknown>>,
  defaults: { domain?: string; by?: string },
): JudgmentInput {
  const str = (k: keyof JudgmentInput): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v !== 'string') throw new JudgmentInputError(`${k} must be text`);
    return v;
  };
  const verdicts = list('verdicts', raw.verdicts);
  const criteria = list('criteria', raw.criteria);
  const ref = str('ref');
  const decidedAt = str('decidedAt');
  return {
    subject: str('subject') ?? '',
    verdict: str('verdict') ?? '',
    reason: str('reason') ?? '',
    domain: str('domain') ?? defaults.domain ?? '',
    by: str('by') ?? defaults.by ?? '',
    ...(ref !== undefined && { ref }),
    ...(verdicts !== undefined && { verdicts }),
    ...(criteria !== undefined && { criteria }),
    ...(decidedAt !== undefined && { decidedAt }),
  };
}

/**
 * Past decisions from a CSV file (a header row naming the columns: subject, verdict, reason,
 * domain, by, and optionally ref, criteria and verdicts as `;`-separated lists, decided_at) or JSON
 * Lines (one object per line with the same keys; lists may be arrays). `defaults` fills a missing
 * domain or expert. More than `JUDGMENT_LIMITS.importRows` rows is refused. Each row is checked as
 * `recordJudgment` checks it; the first bad row throws `JudgmentInputError` naming its line.
 */
export function parseJudgmentRows(
  text: string,
  format: 'csv' | 'jsonl',
  defaults: { domain?: string; by?: string } = {},
): JudgmentInput[] {
  const at = new Date(0);
  const max = JUDGMENT_LIMITS.importRows;
  const tooMany = (n: number) =>
    new JudgmentInputError(`an import holds at most ${max} rows; this one has ${n}`);
  const check = (raw: Partial<Record<keyof JudgmentInput, unknown>>, line: number) => {
    try {
      const input = rowInput(raw, defaults);
      normaliseJudgment(input, at);
      return input;
    } catch (e) {
      throw new JudgmentInputError(`line ${line}: ${(e as Error).message}`);
    }
  };
  if (format === 'jsonl') {
    const lines = text.split('\n').flatMap((l, i) => (l.trim() === '' ? [] : [[l, i] as const]));
    if (lines.length > max) throw tooMany(lines.length);
    return lines.map(([l, i]) => {
      let x: unknown;
      try {
        x = JSON.parse(l);
      } catch {
        throw new JudgmentInputError(`line ${i + 1} is not JSON`);
      }
      if (typeof x !== 'object' || x === null || Array.isArray(x)) {
        throw new JudgmentInputError(`line ${i + 1} is not an object`);
      }
      const raw: Partial<Record<keyof JudgmentInput, unknown>> = {};
      for (const [k, v] of Object.entries(x)) {
        const key = columnOf(k);
        if (key !== undefined) raw[key] = v;
      }
      return check(raw, i + 1);
    });
  }
  const rows = parseCsv(text);
  if (rows.length - 1 > max) throw tooMany(rows.length - 1);
  const header = (rows[0] ?? []).map((h) => columnOf(h));
  for (const need of ['subject', 'verdict', 'reason'] as const) {
    if (!header.includes(need))
      throw new JudgmentInputError(`the CSV header has no ${need} column`);
  }
  return rows.slice(1).map((r, i) => {
    const raw: Partial<Record<keyof JudgmentInput, unknown>> = {};
    header.forEach((k, j) => {
      if (k !== undefined) raw[k] = r[j];
    });
    return check(raw, i + 2);
  });
}

// ---------------------------------------------------------------------------------------------
// Evaluation: agreement with the expert on held-out decisions
// ---------------------------------------------------------------------------------------------

export const EVAL_THRESHOLDS: readonly number[] = Object.freeze([0.5, 0.6, 0.7, 0.8, 0.9]);

/** One threshold's numbers: how much is predicted, and how often the prediction is the expert's. */
export interface EvalPoint {
  threshold: number;
  /** Items predicted at or above the threshold, as a share of all items. */
  coverage: number;
  /** Of those, the share whose prediction matched the expert's verdict; null when none. */
  agreement: number | null;
  predicted: number;
  agreed: number;
}

export interface EvalReport {
  /** Per domain, then `(all)` (not a valid domain label, so it never collides). */
  domains: Record<
    string,
    { items: number; points: EvalPoint[]; why: Partial<Record<JudgeWhy, number>> }
  >;
  thresholds: number[];
  similarity: 'dense' | 'lexical' | 'mixed';
}

/**
 * Judges each held-out decision against the store (never recording it, and never using the item
 * itself as a precedent: leave-one-out by item ref and by exact decision) and compares the
 * prediction with the expert's verdict: agreement and coverage per domain at each threshold.
 * An item counts as predicted at threshold t when judging would say `suggested` with t as the
 * threshold. Needs a decider; without one nothing is ever predicted.
 */
export async function evaluateJudgments(
  heldOut: readonly JudgmentInput[],
  deps: JudgeDeps,
  opts: Omit<JudgeOptions, 'threshold'> & { thresholds?: readonly number[] } = {},
): Promise<EvalReport> {
  const thresholds = [...(opts.thresholds ?? EVAL_THRESHOLDS)].sort((a, b) => a - b);
  const now = deps.now ?? new Date();
  const rows: { domain: string; actual: string; r: JudgeResult }[] = [];
  const modes = new Set<string>();
  for (const input of heldOut) {
    const n = normaliseJudgment(input, now);
    const r = await judge(
      {
        summary: n.subject.summary,
        domain: n.domain,
        by: n.by,
        ...(n.subject.ref !== undefined && { ref: n.subject.ref }),
      },
      deps,
      {
        ...opts,
        threshold: 0,
        // Leave-one-out: the item itself, if the store holds it (same item ref in the domain, or
        // the very same decision), never counts as its own precedent.
        exclude: (m) =>
          (opts.exclude?.(m) ?? false) ||
          fingerprint(m.judgment) === fingerprint(n) ||
          (n.subject.ref !== undefined &&
            m.judgment.subject.ref === n.subject.ref &&
            m.judgment.domain === n.domain),
      },
    );
    modes.add(r.similarity);
    rows.push({ domain: n.domain, actual: n.verdict, r });
  }
  const summarise = (rs: typeof rows) => {
    const why: Partial<Record<JudgeWhy, number>> = {};
    for (const x of rs) if (x.r.why !== undefined) why[x.r.why] = (why[x.r.why] ?? 0) + 1;
    return {
      items: rs.length,
      why,
      points: thresholds.map((t) => {
        const hit = rs.filter(
          (x) =>
            x.r.prediction !== undefined &&
            x.r.status === 'suggested' &&
            x.r.prediction.probability >= t,
        );
        const agreed = hit.filter((x) => x.r.prediction!.verdict === x.actual).length;
        return {
          threshold: t,
          coverage: rs.length === 0 ? 0 : round(hit.length / rs.length),
          agreement: hit.length === 0 ? null : round(agreed / hit.length),
          predicted: hit.length,
          agreed,
        };
      }),
    };
  };
  const domains: EvalReport['domains'] = {};
  for (const d of [...new Set(rows.map((x) => x.domain))].sort()) {
    domains[d] = summarise(rows.filter((x) => x.domain === d));
  }
  domains['(all)'] = summarise(rows);
  return {
    domains,
    thresholds,
    similarity:
      modes.size === 1
        ? ([...modes][0] as 'dense' | 'lexical')
        : modes.size === 0
          ? 'lexical'
          : 'mixed',
  };
}
