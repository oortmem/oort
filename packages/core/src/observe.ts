import { randomUUID } from 'node:crypto';
import type {
  DecisionController,
  Embedder,
  MemoryStore,
  MemoryWriter,
  Observation,
  ReconcileAction,
  ReconcileDecision,
  ScopeFilter,
} from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { capObservation } from './cap.js';
import type { Decision, Memory, Scope } from './model.js';
import { scrubObservation } from './scrub.js';
import { tokenizeLexical } from './tokenize.js';

export interface ObserveResult {
  outcome: 'skipped' | 'reinforced' | 'added' | 'updated' | 'superseded';
  memoryId?: string;
  decisions: Decision[];
  /** Why the observation was skipped, when a stage other than the gate decided so. */
  reason?: string;
}

export interface ObserveDeps {
  store: MemoryStore;
  embed: Embedder;
  decide: DecisionController;
  write: MemoryWriter;
  config: ResolvedConfig;
  now?: Date;
  /** Recorded on `source.harness`; defaults to "unknown". */
  harness?: string;
}

/**
 * Still believed and not yet ended at `now`. Unlike `isCurrent` it ignores
 * `validFrom`: a fact observed with a start in the future is still a live
 * candidate for reinforcement or supersession.
 */
function isLive(m: Memory, now: Date): boolean {
  return m.expiredAt === null && (m.validTo === null || Date.parse(m.validTo) > now.getTime());
}

/**
 * Gate-stage reinforcement match floor. When the gate says "do not store", a
 * lexical hit is reinforced only if the turn shares at least
 * `REINFORCE_MIN_SHARED` distinct lexical tokens with the memory's text, and
 * those make up at least `REINFORCE_MIN_CONTAINMENT` of the memory's distinct
 * tokens. An any-token match is a coincidence, not a re-observation.
 */
export const REINFORCE_MIN_SHARED = 3;
export const REINFORCE_MIN_CONTAINMENT = 0.5;

/** True when `turn` (distinct lexical tokens) clears the gate-stage floor for `m`. */
function strongMatch(turn: ReadonlySet<string>, m: Memory): boolean {
  const own = new Set(tokenizeLexical(m.text));
  let shared = 0;
  for (const t of own) if (turn.has(t)) shared++;
  return shared >= REINFORCE_MIN_SHARED && shared >= REINFORCE_MIN_CONTAINMENT * own.size;
}

async function confirm(store: MemoryStore, id: string, nowIso: string): Promise<void> {
  const m = await store.get(id);
  if (m !== null) await store.upsert({ ...m, lastConfirmedAt: nowIso });
}

const GATE_THRESHOLD = 0.5;
const HOT_SALIENCE = 0.8;
const CANDIDATES = 5;

function filterFor(scope: Scope): ScopeFilter {
  const projectIds = [...new Set<string | null>([scope.projectId ?? null, null])];
  return { orgId: scope.orgId, customerId: scope.customerId, agentId: scope.agentId, projectIds };
}

/**
 * The asynchronous write path: scrub secrets, gate, look up related memories, reconcile, and
 * only then author the memory. Every decision is recorded on the stored memory.
 */
export async function observe(
  raw: Observation,
  scope: Scope,
  deps: ObserveDeps,
): Promise<ObserveResult> {
  // Secrets are scrubbed before any adapter, or the store, sees the text.
  const scrubbed = scrubObservation(raw);
  if (scrubbed.dropped) return { outcome: 'skipped', reason: 'secret', decisions: [] };
  // Capped after scrubbing (a secret is never cut in half) and before the gate or writer see it.
  const obs = capObservation(scrubbed.obs);
  const { store, embed, decide, write } = deps;
  const now = deps.now ?? new Date();
  const filter = filterFor(scope);
  const g = await decide.gate(obs);
  const text = `${obs.userText}\n${obs.assistantText}`;

  if (g.shouldStore < GATE_THRESHOLD) {
    // Lexical search ignores validity, so look past superseded rows for a live one.
    const turnText = `${obs.userText} ${obs.assistantText}`;
    const turn = new Set(tokenizeLexical(turnText));
    const hits = await store.lexical(turnText, filter, 3);
    for (const hit of hits) {
      const m = await store.get(hit.id);
      if (m === null || !isLive(m, now) || !strongMatch(turn, m)) continue;
      // Activation only: `lastConfirmedAt` is reserved for a decided REINFORCE.
      await store.recordAccess([m.id], now);
      return { outcome: 'reinforced', memoryId: m.id, decisions: g.decisions };
    }
    return { outcome: 'skipped', decisions: g.decisions };
  }

  const [vec] = await embed.embed([text], 'document');
  if (vec === undefined) throw new Error('embedder returned no vector for the observation');

  // Stores ignore temporal validity, so over-fetch to keep superseded rows from crowding out the head.
  const [dense, lexical] = await Promise.all([
    store.dense(vec, filter, CANDIDATES * 2),
    store.lexical(text, filter, CANDIDATES * 2),
  ]);
  const ids = [...new Set([...dense, ...lexical].map((h) => h.id))];
  const candidates: Memory[] = [];
  for (const id of ids) {
    const m = await store.get(id);
    if (m !== null && isLive(m, now)) candidates.push(m);
    if (candidates.length === CANDIDATES) break;
  }

  const rs = await decide.reconcile(obs, candidates);
  const decisions = [...g.decisions, ...rs.flatMap((r) => r.decisions)];

  let best: (ReconcileDecision & { action: Exclude<ReconcileAction, 'NOOP'> }) | undefined;
  for (const r of rs) {
    if (r.action === 'NOOP') continue;
    if (best === undefined || r.probability > best.probability) best = { ...r, action: r.action };
  }
  if (best === undefined) return { outcome: 'skipped', decisions };

  if (best.action === 'REINFORCE') {
    const target = candidates.find((c) => c.id === best.candidateId);
    if (target === undefined) return { outcome: 'skipped', decisions };
    await store.recordAccess([target.id], now);
    await confirm(store, target.id, now.toISOString());
    return { outcome: 'reinforced', memoryId: target.id, decisions };
  }

  let action: 'ADD' | 'UPDATE' | 'SUPERSEDE' = best.action;
  let prior = action === 'ADD' ? undefined : candidates.find((c) => c.id === best.candidateId);
  if (prior !== undefined && (prior.scope.projectId ?? null) !== (scope.projectId ?? null)) {
    // Candidates include global memories. A project's observation must not end or
    // rewrite a fact another scope (every project, for a global one) relies on, so it
    // becomes the project's own memory instead. Reinforcing it (above) stays allowed.
    decisions.push({
      stage: 'scope',
      question: 'cross-scope-target',
      answer: 'add-instead',
      probability: 1,
    });
    prior = undefined;
  }
  if (action !== 'ADD' && prior === undefined) action = 'ADD';

  const w = await write.write(obs, action, prior);
  const id = randomUUID();
  const iso = now.toISOString();
  // Temporal order of the new fact against the one it replaces. `deep` means it is
  // also older than the prior's own predecessor; chains are re-slotted at most one
  // step back (deeper out-of-order chains are a Phase 2 concern).
  // A turn with no usable timestamp starts now: an empty or unparseable validFrom
  // would make the memory never current (and consolidation would evict it).
  const validFrom = Number.isNaN(Date.parse(obs.at)) ? iso : obs.at;
  const inOrder = prior === undefined || Date.parse(prior.validFrom) <= Date.parse(validFrom);
  let pred: Memory | null = null;
  if (prior !== undefined && !inOrder && prior.supersedes !== null) {
    pred = await store.get(prior.supersedes);
  }
  const deep = pred !== null && Date.parse(validFrom) < Date.parse(pred.validFrom);
  const temporal: Decision | undefined =
    prior === undefined
      ? undefined
      : {
          stage: 'temporal',
          question: 'order',
          answer: inOrder ? 'in-order' : deep ? 'out-of-order-deep' : 'out-of-order',
          probability: 1,
        };
  if (temporal !== undefined) decisions.push(temporal);

  const memory: Memory = {
    id,
    scope,
    type: w.type,
    text: w.text,
    stub: w.stub,
    entities: w.entities,
    salience: g.salience,
    pinned: false,
    tier: g.salience >= HOT_SALIENCE ? 'hot' : 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: prior?.id ?? null,
    supersededBy: null,
    embedding: vec,
    source: {
      harness: deps.harness ?? 'unknown',
      ...(obs.sessionId !== undefined && { sessionId: obs.sessionId }),
      ...(obs.turnRef !== undefined && { turnRef: obs.turnRef }),
      decisions: [
        ...decisions,
        { stage: 'write', question: 'action', answer: action, probability: best.probability },
      ],
    },
    createdAt: iso,
    updatedAt: iso,
  };
  // A supersede, update or out-of-order insert changes several records; they land
  // together in one atomic write so a crash cannot leave a half-linked chain.
  if (prior === undefined) {
    await store.upsert(memory);
  } else if (inOrder) {
    // Close the prior where the new fact starts, not where we observed it. A fact
    // starting in the future leaves the prior current until then (`expiredAt` stays
    // null; consolidation expires it once `validTo` has passed).
    await store.upsertMany([
      memory,
      {
        ...prior,
        validTo: validFrom,
        expiredAt: Date.parse(validFrom) <= now.getTime() ? iso : null,
        endReason: 'superseded',
        supersededBy: id,
        updatedAt: iso,
      },
    ]);
  } else if (pred !== null && deep) {
    // Older than the prior's predecessor too: close at the predecessor's start and slot in before it.
    const before = pred.supersedes === null ? null : await store.get(pred.supersedes);
    await store.upsertMany([
      {
        ...memory,
        validTo: pred.validFrom,
        expiredAt: iso,
        endReason: 'superseded',
        supersededBy: pred.id,
        supersedes: pred.supersedes,
      },
      { ...pred, supersedes: id, updatedAt: iso },
      ...(before === null ? [] : [{ ...before, supersededBy: id, updatedAt: iso }]),
    ]);
  } else {
    // The "new" fact is older than the prior: it slots in before it, already closed.
    await store.upsertMany([
      {
        ...memory,
        validTo: prior.validFrom,
        expiredAt: iso,
        endReason: 'superseded',
        supersededBy: prior.id,
        supersedes: prior.supersedes,
      },
      { ...prior, supersedes: id, updatedAt: iso },
      ...(pred === null ? [] : [{ ...pred, validTo: validFrom, supersededBy: id, updatedAt: iso }]),
    ]);
  }

  const outcome = action === 'ADD' ? 'added' : action === 'UPDATE' ? 'updated' : 'superseded';
  return { outcome, memoryId: id, decisions };
}
