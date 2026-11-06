import {
  formatForInjection,
  isAgentVia,
  isCurrent,
  scrub,
  type Judgment,
  type JudgeResult as CoreJudgeResult,
  type Memory,
  type RecallResult as CoreRecallResult,
  type RecalledMemory as CoreRecalled,
} from '@oortmem/core';
import type {
  IncludeLevel,
  JudgeResult,
  JudgmentView,
  MemoryStatus,
  MemoryView,
  RecallResult,
  RecalledMemory,
  Warning,
} from './types.js';

/**
 * Result shaping (CON-108 §4.2): core's records become the SDK's documented views. Every text
 * field is scrubbed again on the way out, as the MCP server's `clean` does, so a memory stored
 * before a rule existed never comes back with its secret.
 */

export const clean = (text: string): string => scrub(text).text;

/** The status of a memory at `now`; the first matching rule wins (§4.2). */
export function memoryStatus(
  m: Pick<Memory, 'judgment' | 'expiredAt' | 'validFrom' | 'validTo' | 'endReason'>,
  now: Date,
): MemoryStatus {
  if (m.judgment?.withdrawn !== undefined) return 'withdrawn';
  if (isCurrent(m as Memory, now)) return 'current';
  if (m.endReason === 'corrected') return 'corrected';
  if (m.endReason === 'superseded') return 'superseded';
  if (m.expiredAt !== null || (m.validTo !== null && Date.parse(m.validTo) <= now.getTime()))
    return 'expired';
  return 'not-yet-valid';
}

/** A core origin (level, node label, author) as the SDK's include level and space label. */
function originView(o: CoreRecalled['origin']): MemoryView['origin'] | undefined {
  if (o === undefined) return undefined;
  const level: IncludeLevel =
    o.level === 'user'
      ? 'planet'
      : o.level === 'hive'
        ? o.space === 'Galaxy'
          ? 'galaxy'
          : 'constellation'
        : 'star';
  return {
    level,
    space: o.node,
    ...(o.author !== undefined && { author: o.author }),
    ...(o.overriddenBy !== undefined && { overriddenBy: o.overriddenBy.id }),
  };
}

export function judgmentView(j: Judgment, m: Memory, now: Date): JudgmentView & { id: string } {
  const confirmed = !isAgentVia(j.via) || j.confirmed !== undefined;
  return {
    id: m.id,
    subject: {
      summary: clean(j.subject.summary),
      ...(j.subject.ref !== undefined && { ref: clean(j.subject.ref) }),
    },
    verdict: clean(j.verdict),
    verdicts: j.verdicts.map(clean),
    reason: clean(j.reason),
    criteria: j.criteria.map(clean),
    domain: clean(j.domain),
    by: clean(j.by),
    decidedAt: j.decidedAt,
    via: j.via,
    status: memoryStatus(m, now),
    confirmed,
    agentRecorded: isAgentVia(j.via) && !confirmed,
    ...(j.withdrawn !== undefined && { withdrawn: { ...j.withdrawn } }),
    ...(j.pack !== undefined && { pack: { id: j.pack.id, name: j.pack.name } }),
  };
}

/** A stored memory (or an Oort Cloud one: no embedding) as a `MemoryView`. */
export function memoryView(
  m: Omit<Memory, 'embedding'> & { origin?: CoreRecalled['origin'] },
  now: Date,
): MemoryView {
  const origin = originView(m.origin);
  return {
    id: m.id,
    text: clean(m.text),
    type: m.type,
    tier: m.tier,
    pinned: m.pinned,
    status: memoryStatus(m as Memory, now),
    validFrom: m.validFrom,
    validTo: m.validTo,
    recordedAt: m.createdAt,
    updatedAt: m.updatedAt,
    entities: (m.entities ?? []).map(clean),
    ...(origin !== undefined && { origin }),
    ...(m.judgment !== undefined && { judgment: judgmentView(m.judgment, m as Memory, now) }),
  };
}

function recalledView(m: CoreRecalled, now: Date): RecalledMemory {
  const e = m.explanation;
  return {
    ...memoryView(m, now),
    score: e.fused,
    ...(e.stale === true && { stale: true as const }),
    why: {
      ...(e.lexicalRank !== undefined && { lexicalRank: e.lexicalRank }),
      ...(e.denseRank !== undefined && { denseRank: e.denseRank }),
      ...(e.reranked !== undefined && { reranked: e.reranked }),
      coverage: e.coverage,
      ...(e.dense !== undefined && { dense: e.dense }),
      activation: e.activation,
      ...(e.chain === true && { chain: true as const }),
    },
  };
}

/** The core result and clock behind each SDK result, so `formatForPrompt` renders as the hooks do. */
const sources = new WeakMap<
  RecallResult,
  { core: CoreRecallResult; now: Date; budgetChars: number }
>();

export function recallView(
  r: CoreRecallResult,
  now: Date,
  extra: {
    degraded?: string[];
    warnings: Warning[];
    mode?: RecallResult['temporal']['mode'];
    /** The block budget `formatForPrompt` uses for this result by default. */
    budgetChars?: number;
  },
): RecallResult {
  const out: RecallResult = {
    memories: r.memories.map((m) => recalledView(m, now)),
    abstained: r.abstained === true,
    temporal: r.temporal ?? { mode: extra.mode ?? 'current', inferred: false },
    read: r.read ?? [],
    degraded: extra.degraded ?? [...(r.degraded ?? [])],
    warnings: extra.warnings,
  };
  sources.set(out, { core: r, now, budgetChars: extra.budgetChars ?? DEFAULT_BUDGET_CHARS });
  return out;
}

/** Default block budget, as the config's `recall.budgetChars`. */
export const DEFAULT_BUDGET_CHARS = 6000;

/**
 * A recall's memories as the `<oort-memory>` block the hooks inject, within `budgetChars`
 * (default: the recall's `budgetChars`, else the config's, else 6000): block tags and label brackets in memory text are escaped, so a stored memory
 * cannot close the block or forge a label, and each text is scrubbed again. Inject memory into a
 * prompt only through this.
 */
export function formatForPrompt(r: RecallResult, opts: { budgetChars?: number } = {}): string {
  const known = sources.get(r);
  const budget = opts.budgetChars ?? known?.budgetChars ?? DEFAULT_BUDGET_CHARS;
  if (known !== undefined) {
    // Only the memories still in the SDK result, in its order (a caller may have filtered it).
    const ids = new Map(r.memories.map((m, i) => [m.id, i]));
    const memories = known.core.memories
      .filter((m) => ids.has(m.id))
      .sort((a, b) => ids.get(a.id)! - ids.get(b.id)!)
      // Scrubbed before the block escapes it: an escape inside a secret would hide it from the
      // block's own scrub (an Oort Cloud memory arrives as the cloud stored it).
      .map((m) => ({ ...m, text: clean(m.text) }));
    return formatForInjection({ ...known.core, memories }, budget, known.now);
  }
  // A result rebuilt elsewhere (deserialised, copied): rendered from its documented fields.
  const now = new Date();
  const memories = r.memories.map((m) => fromView(m));
  return formatForInjection({ memories, timings: {} }, budget, now);
}

/** A view as the minimal core record `formatForInjection` reads. */
function fromView(m: RecalledMemory): CoreRecalled {
  const ended = m.status !== 'current' && m.status !== 'not-yet-valid';
  const hive = m.origin?.level === 'constellation' || m.origin?.level === 'galaxy';
  return {
    id: m.id,
    scope: { orgId: 'local', customerId: 'self', agentId: 'anonymous' },
    type: m.type,
    text: m.text,
    stub: '',
    entities: [],
    salience: 0,
    pinned: m.pinned,
    tier: m.tier,
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: m.validFrom,
    validTo: m.validTo,
    expiredAt: ended && m.validTo === null ? m.updatedAt : null,
    endReason:
      m.status === 'corrected' || m.status === 'superseded' || m.status === 'expired'
        ? m.status
        : null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'sdk', decisions: [] },
    createdAt: m.recordedAt,
    updatedAt: m.updatedAt,
    explanation: {
      fused: m.score,
      rrf: m.score,
      coverage: m.why.coverage,
      activation: m.why.activation,
      hydrated: false,
      ...(m.stale === true && { stale: true as const }),
    },
    ...(m.origin !== undefined && {
      origin: {
        level: hive ? 'hive' : m.origin.level === 'planet' ? 'user' : 'agent',
        space: hive ? (m.origin.level === 'galaxy' ? 'Galaxy' : 'Constellation') : 'Planet',
        node: m.origin.space,
        from: `from ${m.origin.space}`,
        home: !hive,
        author: m.origin.author ?? '',
        ...(m.origin.overriddenBy !== undefined && {
          overriddenBy: { id: m.origin.overriddenBy, node: 'a narrower memory' },
        }),
      },
    }),
  };
}

/** Core's judging result, cut to its documented fields; precedent text is scrubbed again. */
export function judgeView(r: CoreJudgeResult): JudgeResult {
  return {
    status: r.status,
    ...(r.why !== undefined && { why: r.why }),
    ...(r.prediction !== undefined && {
      prediction: {
        verdict: clean(r.prediction.verdict),
        probability: r.prediction.probability,
        probabilities: { ...r.prediction.probabilities },
      },
    }),
    precedents: r.precedents.map((p) => ({
      id: p.id,
      subject: {
        summary: clean(p.subject.summary),
        ...(p.subject.ref !== undefined && { ref: clean(p.subject.ref) }),
      },
      verdict: clean(p.verdict),
      reason: clean(p.reason),
      criteria: p.criteria.map(clean),
      domain: clean(p.domain),
      by: clean(p.by),
      decidedAt: p.decidedAt,
      similarity: p.similarity,
      near: p.near,
      ...(p.agrees !== undefined && { agrees: p.agrees }),
      via: p.via,
      confirmed: p.confirmed,
      agentRecorded: isAgentVia(p.via) && !p.confirmed,
      ...(p.pack !== undefined && { pack: { id: p.pack.id, name: p.pack.name } }),
    })),
    verdicts: r.verdicts.map(clean),
    agreement: { ...r.agreement },
    similarity: r.similarity,
    threshold: r.threshold,
    minSimilarity: r.minSimilarity,
    ...(r.degraded !== undefined && { degraded: [...r.degraded] }),
    decisions: r.decisions.map((d) => ({
      stage: d.stage,
      question: d.question,
      answer: d.answer,
      probability: d.probability,
    })),
    ...(r.importedExcluded !== undefined && { importedExcluded: r.importedExcluded }),
    ...(r.agentRecordedExcluded !== undefined && {
      agentRecordedExcluded: r.agentRecordedExcluded,
    }),
  };
}
