import { randomUUID } from 'node:crypto';
import type {
  DecisionController,
  Embedder,
  GateDecision,
  MemoryStore,
  MemoryWriter,
  Observation,
  ReconcileAction,
  ReconcileDecision,
  ScopeFilter,
  WrittenMemory,
} from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { capObservation } from './cap.js';
import type { Decision, Memory, Scope } from './model.js';
import { scrubObservation } from './scrub.js';
import { tokenizeLexical } from './tokenize.js';

export type MemoryOutcomeKind = 'skipped' | 'reinforced' | 'added' | 'updated' | 'superseded';

/** What happened to one memory the turn produced. */
export interface MemoryOutcome {
  outcome: MemoryOutcomeKind;
  memoryId?: string;
  reason?: string;
}

export interface ObserveResult {
  /** The turn's headline: the first memory that was not skipped, else `skipped`. */
  outcome: MemoryOutcomeKind;
  memoryId?: string;
  decisions: Decision[];
  /** Why the observation was skipped, when a stage other than the gate decided so. */
  reason?: string;
  /** One entry per memory the turn produced, in the writer's order (one for a single-memory writer). */
  memories: MemoryOutcome[];
  /** `memories` counted by outcome. */
  counts: Partial<Record<MemoryOutcomeKind, number>>;
}

function countOf(ms: MemoryOutcome[]): ObserveResult['counts'] {
  const counts: ObserveResult['counts'] = {};
  for (const m of ms) counts[m.outcome] = (counts[m.outcome] ?? 0) + 1;
  return counts;
}

/** A one-memory result (the gate, a secret, or the single-memory path). */
function single(m: MemoryOutcome, decisions: Decision[]): ObserveResult {
  return {
    ...m,
    decisions,
    memories: [m],
    counts: countOf([m]),
  };
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

/** Live candidates for `text`: dense and lexical neighbours, over-fetched past superseded rows. */
async function candidatesFor(
  store: MemoryStore,
  text: string,
  v: Int8Array,
  filter: ScopeFilter,
  now: Date,
): Promise<Memory[]> {
  // Stores ignore temporal validity, so over-fetch to keep superseded rows from crowding out the head.
  const [dense, lexical] = await Promise.all([
    store.dense(v, filter, CANDIDATES * 2),
    store.lexical(text, filter, CANDIDATES * 2),
  ]);
  const ids = [...new Set([...dense, ...lexical].map((h) => h.id))];
  const out: Memory[] = [];
  for (const id of ids) {
    const m = await store.get(id);
    if (m !== null && isLive(m, now)) out.push(m);
    if (out.length === CANDIDATES) break;
  }
  return out;
}

/** The highest-probability decision that is not NOOP, or undefined. */
function bestOf(
  rs: ReconcileDecision[],
): (ReconcileDecision & { action: Exclude<ReconcileAction, 'NOOP'> }) | undefined {
  let best: (ReconcileDecision & { action: Exclude<ReconcileAction, 'NOOP'> }) | undefined;
  for (const r of rs) {
    if (r.action === 'NOOP') continue;
    if (best === undefined || r.probability > best.probability) best = { ...r, action: r.action };
  }
  return best;
}

interface ApplyArgs {
  obs: Observation;
  scope: Scope;
  deps: ObserveDeps;
  now: Date;
  salience: number;
  candidates: Memory[];
  rs: ReconcileDecision[];
  /** Decisions recorded so far (gate, reconcile); extended with this memory's own. */
  decisions: Decision[];
  embedding: Int8Array;
  /** Authors the memory once the action and prior are known. */
  author: (action: 'ADD' | 'UPDATE' | 'SUPERSEDE', prior?: Memory) => Promise<WrittenMemory>;
  /** Priors already ended by an earlier memory of this turn (the multi path). */
  claimed?: Set<string>;
  /** All candidates NOOP means a new fact, not a skip (the multi path: the writer kept it). */
  noopMeansNew?: boolean;
}

/** Applies one reconcile decision: reinforce, or write and link a new memory. */
async function apply(a: ApplyArgs): Promise<MemoryOutcome> {
  const { obs, scope, deps, now, candidates, decisions } = a;
  const { store } = deps;
  let best = bestOf(a.rs);
  if (best === undefined && a.noopMeansNew === true && a.rs.length > 0) {
    // Every candidate is unrelated. The writer already said this is a fact worth keeping,
    // so it is new, not noise: a store almost always has *some* nearest neighbour.
    decisions.push({
      stage: 'reconcile',
      question: 'all-unrelated',
      answer: 'ADD',
      probability: 1,
    });
    best = { candidateId: null, action: 'ADD', probability: 1, decisions: [] };
  }
  if (best === undefined) return { outcome: 'skipped' };

  if (best.action === 'REINFORCE') {
    const target = candidates.find((c) => c.id === best.candidateId);
    if (target === undefined) return { outcome: 'skipped' };
    await store.recordAccess([target.id], now);
    await confirm(store, target.id, now.toISOString());
    return { outcome: 'reinforced', memoryId: target.id };
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
  if (prior !== undefined && a.claimed?.has(prior.id) === true) {
    // An earlier memory of this turn already ended this prior: this one stands on its own.
    decisions.push({
      stage: 'write',
      question: 'prior-claimed',
      answer: 'add-instead',
      probability: 1,
    });
    prior = undefined;
  }
  if (prior !== undefined && a.claimed !== undefined) {
    // Re-read: the snapshot was taken before this turn wrote anything.
    const fresh = await store.get(prior.id);
    prior = fresh !== null && isLive(fresh, now) ? fresh : undefined;
  }
  if (action !== 'ADD' && prior === undefined) action = 'ADD';
  if (prior !== undefined) a.claimed?.add(prior.id);

  const w = await a.author(action, prior);
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
  if (prior !== undefined) {
    decisions.push({
      stage: 'temporal',
      question: 'order',
      answer: inOrder ? 'in-order' : deep ? 'out-of-order-deep' : 'out-of-order',
      probability: 1,
    });
  }

  const memory: Memory = {
    id,
    scope,
    type: w.type,
    text: w.text,
    stub: w.stub,
    entities: w.entities,
    salience: a.salience,
    pinned: false,
    tier: a.salience >= HOT_SALIENCE ? 'hot' : 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: prior?.id ?? null,
    supersededBy: null,
    embedding: a.embedding,
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
  return { outcome, memoryId: id };
}

/** The same fact twice (whitespace and case aside) is written once. */
function dedupe(ms: WrittenMemory[]): WrittenMemory[] {
  const seen = new Set<string>();
  return ms.filter((m) => {
    const k = m.text.trim().replace(/\s+/g, ' ').toLowerCase();
    if (k === '' || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A fact as the decision controller sees it: the claim stands in for the turn. */
function factObservation(obs: Observation, m: WrittenMemory): Observation {
  return { ...obs, userText: m.text, assistantText: '', toolSummaries: [] };
}

/**
 * The asynchronous write path: scrub secrets, gate, look up related memories, reconcile, and
 * only then author the memory. Every decision is recorded on the stored memory.
 *
 * With a writer that has `writeMany` (CON-56), the order is: gate, then one writer call that
 * splits the turn into 1 to `writer.maxMemoriesPerObservation` facts, one embed call for all of
 * them, candidates per fact (all gathered before anything is stored, so facts of one turn never
 * reconcile against each other), one reconcile per fact (or one `reconcileMany` call), and each
 * fact applied on its own. A prior is ended by at most one fact of the turn.
 */
export async function observe(
  raw: Observation,
  scope: Scope,
  deps: ObserveDeps,
): Promise<ObserveResult> {
  // Secrets are scrubbed before any adapter, or the store, sees the text.
  const scrubbed = scrubObservation(raw);
  if (scrubbed.dropped) return single({ outcome: 'skipped', reason: 'secret' }, []);
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
      return single({ outcome: 'reinforced', memoryId: m.id }, g.decisions);
    }
    return single({ outcome: 'skipped' }, g.decisions);
  }

  if (write.writeMany !== undefined) return observeMany(obs, scope, deps, g, now, filter);

  const [vec] = await embed.embed([text], 'document');
  if (vec === undefined) throw new Error('embedder returned no vector for the observation');
  const candidates = await candidatesFor(store, text, vec, filter, now);
  const rs = await decide.reconcile(obs, candidates);
  const decisions = [...g.decisions, ...rs.flatMap((r) => r.decisions)];
  const r = await apply({
    obs,
    scope,
    deps,
    now,
    salience: g.salience,
    candidates,
    rs,
    decisions,
    embedding: vec,
    author: (action, prior) => write.write(obs, action, prior),
  });
  return single(r, decisions);
}

async function observeMany(
  obs: Observation,
  scope: Scope,
  deps: ObserveDeps,
  g: GateDecision,
  now: Date,
  filter: ScopeFilter,
): Promise<ObserveResult> {
  const { store, embed, decide } = deps;
  const max = deps.config.writer.maxMemoriesPerObservation;
  const written = dedupe(await deps.write.writeMany!(obs, max)).slice(0, max);
  if (written.length === 0) return single({ outcome: 'skipped', reason: 'no-facts' }, g.decisions);

  const vecs = await embed.embed(
    written.map((m) => m.text),
    'document',
  );
  if (vecs.length !== written.length)
    throw new Error('embedder returned the wrong number of vectors');
  // Every fact's candidates come from the store as it was before this turn wrote anything.
  const facts = await Promise.all(
    written.map(async (m, i) => ({
      m,
      v: vecs[i]!,
      obs: factObservation(obs, m),
      candidates: await candidatesFor(store, m.text, vecs[i]!, filter, now),
    })),
  );
  const rss =
    decide.reconcileMany !== undefined
      ? await decide.reconcileMany(facts.map((f) => ({ obs: f.obs, candidates: f.candidates })))
      : await facts.reduce<Promise<ReconcileDecision[][]>>(
          async (acc, f) => [...(await acc), await decide.reconcile(f.obs, f.candidates)],
          Promise.resolve([]),
        );
  if (rss.length !== facts.length)
    throw new Error('reconcileMany returned the wrong number of answers');

  const claimed = new Set<string>();
  const memories: MemoryOutcome[] = [];
  const all: Decision[] = [...g.decisions];
  for (const [i, f] of facts.entries()) {
    const rs = rss[i]!;
    const decisions: Decision[] = [
      ...g.decisions,
      { stage: 'write', question: 'fact', answer: `${i + 1}/${facts.length}`, probability: 1 },
      ...rs.flatMap((r) => r.decisions),
    ];
    memories.push(
      await apply({
        obs,
        scope,
        deps,
        now,
        salience: g.salience,
        candidates: f.candidates,
        rs,
        decisions,
        embedding: f.v,
        author: async () => f.m,
        claimed,
        noopMeansNew: true,
      }),
    );
    all.push(...decisions.slice(g.decisions.length));
  }
  const head = memories.find((m) => m.outcome !== 'skipped') ?? memories[0]!;
  return {
    outcome: head.outcome,
    ...(head.memoryId !== undefined && { memoryId: head.memoryId }),
    decisions: all,
    memories,
    counts: countOf(memories),
  };
}
