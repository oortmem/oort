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
import { addressed, addressOf, nodeKey, nodeOf } from './address.js';
import { homeAddress, localGrant, type Grant, type Home } from './grant.js';
import { CONTRADICTS } from './levels.js';
import { capObservation } from './cap.js';
import type { Decision, Memory, Scope } from './model.js';
import { scrubObservation } from './scrub.js';
import { checkWriterDate, factInterval, utcOffset } from './temporal.js';
import { tokenizeLexical } from './tokenize.js';

export type MemoryOutcomeKind =
  'skipped' | 'reinforced' | 'added' | 'updated' | 'superseded' | 'corrected';

/** The actions that write: UPDATE is read as REFINE. */
type WriteAction = 'ADD' | 'REFINE' | 'SUPERSEDE' | 'CORRECT';

/** How the writer is asked to author each action; its interface predates REFINE and CORRECT. */
const WRITER_ACTION = {
  ADD: 'ADD',
  REFINE: 'UPDATE',
  SUPERSEDE: 'SUPERSEDE',
  CORRECT: 'SUPERSEDE',
} as const;

const OUTCOME = {
  ADD: 'added',
  REFINE: 'updated',
  SUPERSEDE: 'superseded',
  CORRECT: 'corrected',
} as const;

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
  /**
   * Where new memories land (spec 5.1): the person's Planet (default) or, for an agent configured
   * as a Star, `scope.agentId`'s own Star. Recall candidates come from both; an existing memory
   * is only ever edited in its own node.
   */
  home?: Home;
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

async function confirm(
  store: MemoryStore,
  grant: Grant,
  id: string,
  nowIso: string,
): Promise<void> {
  const m = await store.get(grant, id);
  if (m !== null) await store.upsert(grant, { ...m, lastConfirmedAt: nowIso });
}

const DAY_MS = 86_400_000;
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
  grant: Grant,
  now: Date,
): Promise<Memory[]> {
  // Stores ignore temporal validity, so over-fetch to keep superseded rows from crowding out the head.
  const [dense, lexical] = await Promise.all([
    store.dense(grant, v, CANDIDATES * 2),
    store.lexical(grant, text, CANDIDATES * 2),
  ]);
  const ids = [...new Set([...dense, ...lexical].map((h) => h.id))];
  const out: Memory[] = [];
  for (const id of ids) {
    const m = await store.get(grant, id);
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
  /** What the store lets this observation read and write (its project plus global). */
  grant: Grant;
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
  const { obs, scope, grant, deps, now, candidates, decisions } = a;
  const { store } = deps;
  // Decisions from here on are this memory's own (the turn's gate and reconcile come before).
  const firstOwn = decisions.length;
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
    await store.recordAccess(grant, [target.id], now);
    await confirm(store, grant, target.id, now.toISOString());
    return { outcome: 'reinforced', memoryId: target.id };
  }

  let action: WriteAction = best.action === 'UPDATE' ? 'REFINE' : best.action;
  let prior = action === 'ADD' ? undefined : candidates.find((c) => c.id === best.candidateId);
  if (prior !== undefined && nodeKey(nodeOf(addressOf(prior))) !== nodeKey(grant.home)) {
    // The prior lives in another node (the Planet, for an agent writing to its Star, or the
    // reverse). A write never edits a memory outside its home node: the observation becomes a
    // memory of its own there. A contradiction is recorded, so recall can rank the narrower of the
    // two first and label the other (spec 7.2). Reinforcing it (above) stays allowed.
    decisions.push({
      stage: 'level',
      question: 'other-node',
      answer: 'add-instead',
      probability: 1,
    });
    if (action === 'SUPERSEDE' || action === 'CORRECT') {
      decisions.push({ ...CONTRADICTS, answer: prior.id, probability: best.probability });
    }
    prior = undefined;
  }
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
    // An earlier memory of this turn already ended or rewrote this prior: this one stands on its own.
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
    const fresh = await store.get(grant, prior.id);
    prior = fresh !== null && isLive(fresh, now) ? fresh : undefined;
  }
  if (action !== 'ADD' && prior === undefined) action = 'ADD';
  if (prior !== undefined) a.claimed?.add(prior.id);

  // The turn's time and UTC offset: relative dates are read in the offset the turn was written
  // in. A turn with no usable timestamp starts now: an empty or unparseable validFrom would make
  // the memory never current (and consolidation would evict it).
  const usable = !Number.isNaN(Date.parse(obs.at));
  const turnAt = usable ? new Date(obs.at) : now;
  const offset = usable ? (utcOffset(obs.at) ?? 0) : 0;

  const w = dated(obs, await a.author(WRITER_ACTION[action], prior), turnAt, offset, decisions);
  const id = randomUUID();
  const iso = now.toISOString();
  const writeDecision: Decision = {
    stage: 'write',
    question: 'action',
    answer: action,
    probability: best.probability,
  };

  // The fact's own bounds ("until Friday", "starting next week"), resolved in code.
  const bounds = factInterval(w.text, turnAt, offset);
  if (bounds.validFrom !== undefined || bounds.validTo !== undefined) {
    decisions.push({
      stage: 'temporal',
      question: 'interval',
      answer: `${bounds.validFrom ?? 'turn'} .. ${bounds.validTo ?? 'open'}`,
      probability: 1,
    });
  }
  // A start, moved back a day before an end it would pass: an end already in the past ("the
  // freeze ran until yesterday") is kept, and the fact is stored already ended.
  const startBefore = (from: string, to: string | null): string =>
    to !== null && Date.parse(to) <= Date.parse(from)
      ? new Date(Date.parse(to) - DAY_MS).toISOString()
      : from;
  const validTo = bounds.validTo ?? null;
  const validFrom = startBefore(bounds.validFrom ?? turnAt.toISOString(), validTo);

  if (action === 'REFINE' && prior !== undefined) {
    // Same fact, more detail: rewrite in place. The earlier wording stays in the decisions, and
    // only this turn's own decisions are appended, so the list grows by a few per refine.
    // A cold memory is promoted: the store drops its cold copy, so hydration can't undo this.
    const to = bounds.validTo ?? prior.validTo;
    await store.upsert(grant, {
      ...prior,
      type: w.type,
      text: w.text,
      stub: w.stub,
      entities: w.entities,
      embedding: a.embedding,
      tier: prior.tier === 'cold' ? 'warm' : prior.tier,
      salience: Math.max(prior.salience, a.salience),
      validFrom: startBefore(bounds.validFrom ?? prior.validFrom, to),
      validTo: to,
      lastConfirmedAt: iso,
      updatedAt: iso,
      source: {
        ...prior.source,
        ...(obs.sessionId !== undefined && { sessionId: obs.sessionId }),
        ...(obs.turnRef !== undefined && { turnRef: obs.turnRef }),
        decisions: [
          ...prior.source.decisions,
          ...decisions.slice(0, firstOwn).filter(isVolatileDecision),
          ...best.decisions,
          ...decisions.slice(firstOwn),
          {
            stage: 'refine',
            question: 'previous-text',
            answer: prior.text,
            probability: best.probability,
          },
          writeDecision,
        ],
      },
    });
    return { outcome: 'updated', memoryId: prior.id };
  }

  const base: Memory = {
    id,
    scope,
    // A memory at another level than the Planet carries its address and author.
    ...(grant.home.level !== 'user' &&
      addressed(homeAddress(grant, scope.projectId), { agentId: scope.agentId })),
    type: w.type,
    text: w.text,
    stub: w.stub,
    entities: w.entities,
    salience: a.salience,
    pinned: false,
    tier: a.salience >= HOT_SALIENCE ? 'hot' : 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom,
    validTo,
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
      decisions: [],
    },
    createdAt: iso,
    updatedAt: iso,
  };
  const withDecisions = (m: Memory): Memory => ({
    ...m,
    source: { ...m.source, decisions: [...decisions, writeDecision] },
  });

  if (action === 'CORRECT' && prior !== undefined) {
    // The prior was never true: retract it in transaction time and put the correction in its
    // place in valid time. Its valid interval is left alone, so as-of reads skip it by reason.
    // The correction keeps bounds its own text states, else takes the prior's.
    const to = bounds.validTo ?? prior.validTo;
    const from = startBefore(bounds.validFrom ?? prior.validFrom, to);
    await store.upsertMany(grant, [
      withDecisions({ ...base, validFrom: from, validTo: to }),
      {
        ...prior,
        expiredAt: iso,
        endReason: 'corrected',
        supersededBy: id,
        updatedAt: iso,
      },
    ]);
    return { outcome: 'corrected', memoryId: id };
  }

  // Temporal order of the new fact against the one it replaces. `deep` means it is
  // also older than the prior's own predecessor; chains are re-slotted at most one
  // step back (deeper out-of-order chains are a Phase 2 concern).
  // Order is the turn's: a turn after the prior that says "since <earlier day>" is an update and
  // becomes current; only a turn that itself arrives late slots in behind the prior.
  const inOrder = prior === undefined || Date.parse(prior.validFrom) <= turnAt.getTime();
  let pred: Memory | null = null;
  if (prior !== undefined && !inOrder && prior.supersedes !== null) {
    pred = await store.get(grant, prior.supersedes);
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
  const memory = withDecisions(base);

  // A supersede or out-of-order insert changes several records; they land
  // together in one atomic write so a crash cannot leave a half-linked chain.
  if (prior === undefined) {
    await store.upsert(grant, memory);
  } else if (inOrder) {
    // Close the prior where the new fact starts, not where we observed it (but never before
    // the prior's own start). A fact starting in the future leaves the prior current until
    // then (`expiredAt` stays null; consolidation expires it once `validTo` has passed).
    const closeAt =
      Date.parse(validFrom) > Date.parse(prior.validFrom) ? validFrom : prior.validFrom;
    await store.upsertMany(grant, [
      memory,
      {
        ...prior,
        validTo: closeAt,
        expiredAt: Date.parse(closeAt) <= now.getTime() ? iso : null,
        endReason: 'superseded',
        supersededBy: id,
        updatedAt: iso,
      },
    ]);
  } else if (pred !== null && deep) {
    // Older than the prior's predecessor too: close at the predecessor's start and slot in before it.
    const before = pred.supersedes === null ? null : await store.get(grant, pred.supersedes);
    await store.upsertMany(grant, [
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
    await store.upsertMany(grant, [
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

  return { outcome: OUTCOME[action], memoryId: id };
}

/** The gate's volatile answer: recorded on the memory, it is what marks a fact as volatile. */
const isVolatileDecision = (d: Decision): boolean =>
  d.stage === 'gate' && d.question === 'volatile';

/**
 * The writer's absolute date checked against the turn (CON-34): when the turn says "yesterday"
 * and the fact carries one ISO day a day or two off, that day is chrono's reading, not the
 * model's arithmetic. A stated or distant date is kept and the difference logged.
 */
function dated(
  obs: Observation,
  w: WrittenMemory,
  at: Date,
  offset: number,
  decisions: Decision[],
): WrittenMemory {
  const r = checkWriterDate(`${obs.userText}\n${obs.assistantText}`, w.text, at, offset);
  if (r.mismatch !== undefined) {
    decisions.push({
      stage: 'temporal',
      question: 'writer-date',
      answer: `kept ${r.mismatch.written} (turn reads ${r.mismatch.resolved})`,
      probability: 1,
    });
  }
  if (r.fixed === undefined) return w;
  decisions.push({
    stage: 'temporal',
    question: 'writer-date',
    answer: `${r.fixed.from} -> ${r.fixed.to}`,
    probability: 1,
  });
  return { ...w, text: r.text, stub: w.stub.split(r.fixed.from).join(r.fixed.to) };
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
  const grant = localGrant(filterFor(scope), deps.home === undefined ? {} : { home: deps.home });
  const g = await decide.gate(obs);
  const text = `${obs.userText}\n${obs.assistantText}`;

  if (g.shouldStore < GATE_THRESHOLD) {
    // Lexical search ignores validity, so look past superseded rows for a live one.
    const turnText = `${obs.userText} ${obs.assistantText}`;
    const turn = new Set(tokenizeLexical(turnText));
    const hits = await store.lexical(grant, turnText, 3);
    for (const hit of hits) {
      const m = await store.get(grant, hit.id);
      if (m === null || !isLive(m, now) || !strongMatch(turn, m)) continue;
      // Activation only: `lastConfirmedAt` is reserved for a decided REINFORCE.
      await store.recordAccess(grant, [m.id], now);
      return single({ outcome: 'reinforced', memoryId: m.id }, g.decisions);
    }
    return single({ outcome: 'skipped' }, g.decisions);
  }

  if (write.writeMany !== undefined) return observeMany(obs, scope, grant, deps, g, now);

  const [vec] = await embed.embed([text], 'document');
  if (vec === undefined) throw new Error('embedder returned no vector for the observation');
  const candidates = await candidatesFor(store, text, vec, grant, now);
  const rs = await decide.reconcile(obs, candidates);
  const decisions = [...g.decisions, ...rs.flatMap((r) => r.decisions)];
  const r = await apply({
    obs,
    scope,
    grant,
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
  grant: Grant,
  deps: ObserveDeps,
  g: GateDecision,
  now: Date,
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
      candidates: await candidatesFor(store, m.text, vecs[i]!, grant, now),
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
  // The gate's volatile answer is about the whole turn, not each fact of it: until there is a
  // per-fact question, facts split from a turn carry none (so none is ever marked stale).
  const turnDecisions = g.decisions.filter((d) => !isVolatileDecision(d));
  const all: Decision[] = [...turnDecisions];
  for (const [i, f] of facts.entries()) {
    const rs = rss[i]!;
    const decisions: Decision[] = [
      ...turnDecisions,
      { stage: 'write', question: 'fact', answer: `${i + 1}/${facts.length}`, probability: 1 },
      ...rs.flatMap((r) => r.decisions),
    ];
    memories.push(
      await apply({
        obs,
        scope,
        grant,
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
    all.push(...decisions.slice(turnDecisions.length));
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
