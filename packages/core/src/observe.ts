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
import type { Decision, Memory, Scope } from './model.js';

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

const GATE_THRESHOLD = 0.5;
const HOT_SALIENCE = 0.8;
const CANDIDATES = 5;

function filterFor(scope: Scope): ScopeFilter {
  const projectIds = [...new Set<string | null>([scope.projectId ?? null, null])];
  return { orgId: scope.orgId, customerId: scope.customerId, agentId: scope.agentId, projectIds };
}

/**
 * The asynchronous write path: gate, look up related memories, reconcile, and
 * only then author the memory. Every decision is recorded on the stored memory.
 */
export async function observe(
  obs: Observation,
  scope: Scope,
  deps: ObserveDeps,
): Promise<ObserveResult> {
  const { store, embed, decide, write } = deps;
  const now = deps.now ?? new Date();
  const filter = filterFor(scope);
  const g = await decide.gate(obs);
  const text = `${obs.userText}\n${obs.assistantText}`;

  if (g.shouldStore < GATE_THRESHOLD) {
    // Lexical search ignores validity, so look past superseded rows for a live one.
    const hits = await store.lexical(`${obs.userText} ${obs.assistantText}`, filter, 3);
    for (const hit of hits) {
      const m = await store.get(hit.id);
      if (m === null || m.validTo !== null) continue;
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
    if (m !== null && m.validTo === null) candidates.push(m);
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
    return { outcome: 'reinforced', memoryId: target.id, decisions };
  }

  let action: 'ADD' | 'UPDATE' | 'SUPERSEDE' = best.action;
  const prior = action === 'ADD' ? undefined : candidates.find((c) => c.id === best.candidateId);
  if (action !== 'ADD' && prior === undefined) action = 'ADD';

  const w = await write.write(obs, action, prior);
  const id = randomUUID();
  const iso = now.toISOString();
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
    validFrom: obs.at,
    validTo: null,
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
  await store.upsert(memory);
  if (prior !== undefined) {
    await store.upsert({ ...prior, validTo: obs.at, supersededBy: id, updatedAt: iso });
  }

  const outcome = action === 'ADD' ? 'added' : action === 'UPDATE' ? 'updated' : 'superseded';
  return { outcome, memoryId: id, decisions };
}
