import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  choice,
  noul,
  score,
} from '@typesafe-ai/sdk';
import {
  MissingCredentialError,
  TOOL_SUMMARIES_MAX,
  TOOL_SUMMARY_MAX_BYTES,
  capUtf8,
  truncateUtf8,
  type Decision,
  type DecisionController,
  type GateDecision,
  type JudgeChoice,
  type JudgeRequest,
  type Memory,
  type MemoryType,
  type ObservedMemoryType,
  type Observation,
  type ReconcileAction,
  type ReconcileDecision,
} from '@oortmem/core';
import {
  JUDGE_INSTRUCTIONS,
  NOVEL_CRITERIA,
  NOVEL_INSTRUCTIONS,
  RECONCILE_CRITERIA,
  SALIENCE_INSTRUCTIONS,
  SALIENCE_LEVELS,
  SALIENCE_NAMES,
  SHOULD_STORE_INSTRUCTIONS,
  TYPE_INSTRUCTIONS,
  VOLATILE_INSTRUCTIONS,
  novelManyInstructions,
  reconcileInstructions,
  reconcileManyInstructions,
  verdictCriterion,
} from './questions.js';

/** The slice of the TypeSafe client this adapter uses; inject a stub in tests. */
export interface SystemOneClient {
  systemOne(req: {
    state: unknown;
    questions: Record<string, unknown>;
    model?: string;
  }): Promise<{ answers: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type DecideErrorKind =
  'auth' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'bad-response';

/** A failed Jev call. The message never includes state, observation text, candidate text or the key. */
export class DecideError extends Error {
  readonly kind: DecideErrorKind;
  readonly status: number | undefined;
  /** The Oort Pro relay's own message for a refusal (relay mode only); never a vendor body. */
  readonly relayMessage: string | undefined;

  constructor(kind: DecideErrorKind, status?: number, relayMessage?: string) {
    super(
      relayMessage ??
        `Jev decision call failed (${kind}${status === undefined ? '' : `, HTTP ${status}`})`,
    );
    this.name = 'DecideError';
    this.kind = kind;
    this.status = status;
    this.relayMessage = relayMessage;
  }
}

/** The `error` string of a relay refusal body, cleaned and cut short; undefined for anything else. */
function relayMessageOf(body: unknown): string | undefined {
  const msg = (body as { error?: unknown } | null)?.error;
  if (typeof msg !== 'string') return undefined;
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, 400);
}

/**
 * The Jev model the Oort Pro relay serves (`MODELS.decide` in apps/relay/src/relay.ts): the SDK's
 * own default. Relay mode pins it, so `TYPESAFE_DEFAULT_MODEL` cannot pick a model the relay refuses.
 */
export const RELAY_MODEL = 'jev-latest';

/** HTTP statuses the SDK retries on its own in relay mode: its default set, minus 429. */
const RELAY_RETRY_STATUSES = new Set([408, ...Array.from({ length: 100 }, (_, i) => 500 + i)]);
const MAX_RETRY_AFTER_MS = 5_000;

function fromStatus(status: number): DecideError {
  if (status === 401 || status === 403) return new DecideError('auth', status);
  if (status === 429) return new DecideError('rate-limit', status);
  if (status >= 500) return new DecideError('server', status);
  return new DecideError('bad-response', status);
}

/** Maps anything the SDK or client throws to a DecideError, dropping its message and cause. */
function wrap(e: unknown, relay = false): DecideError {
  if (e instanceof DecideError) return e;
  if (e instanceof RateLimitError && relay) {
    return new DecideError('rate-limit', e.status, relayMessageOf(e.body));
  }
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
    return new DecideError('auth', e.status);
  }
  if (e instanceof RateLimitError) return new DecideError('rate-limit', e.status);
  if (e instanceof InternalServerError) return new DecideError('server', e.status);
  if (e instanceof APITimeoutError) return new DecideError('timeout');
  if (e instanceof APIConnectionError) return new DecideError('network');
  if (typeof e === 'object' && e !== null) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return fromStatus(status);
    const name = (e as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return new DecideError('timeout');
  }
  return new DecideError('network');
}

const bad = (): DecideError => new DecideError('bad-response');

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}
const isProb = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function noulOf(answers: Record<string, unknown>, id: string): number {
  const a = answers[id];
  if (!isObj(a) || a['type'] !== 'noul' || !isProb(a['noul'])) throw bad();
  return a['noul'];
}

function scoreOf(
  answers: Record<string, unknown>,
  id: string,
): { score: number; probabilities: Record<string, unknown> } {
  const a = answers[id];
  if (!isObj(a) || a['type'] !== 'score' || !isProb(a['score']) || !isObj(a['probabilities'])) {
    throw bad();
  }
  return { score: a['score'], probabilities: a['probabilities'] };
}

/** UPDATE is the earlier name for REFINE and stays accepted from older answers. */
const ACTIONS = new Set<string>([
  'NOOP',
  'REINFORCE',
  'ADD',
  'REFINE',
  'SUPERSEDE',
  'CORRECT',
  'UPDATE',
]);

function choiceOf(
  answers: Record<string, unknown>,
  id: string,
): { action: ReconcileAction; probability: number } {
  const a = answers[id];
  if (!isObj(a) || a['type'] !== 'choice' || !isObj(a['probabilities'])) throw bad();
  const c = a['choice'];
  if (typeof c !== 'string' || !ACTIONS.has(c)) throw bad();
  const p = a['probabilities'][c];
  if (!isProb(p)) throw bad();
  return { action: c as ReconcileAction, probability: p };
}

/** A choice answer over `labels`: the chosen label and every label's probability. */
function labelChoiceOf(
  answers: Record<string, unknown>,
  id: string,
  labels: readonly string[],
): { label: string; probability: number; probabilities: Record<string, number> } {
  const a = answers[id];
  if (!isObj(a) || a['type'] !== 'choice' || !isObj(a['probabilities'])) throw bad();
  const c = a['choice'];
  if (typeof c !== 'string' || !labels.includes(c)) throw bad();
  const probabilities: Record<string, number> = {};
  const probs = a['probabilities'];
  for (const l of labels) {
    // Own properties only: a label such as `constructor` must not read Object's.
    const p = Object.hasOwn(probs, l) ? probs[l] : undefined;
    if (!isProb(p)) throw bad();
    probabilities[l] = p;
  }
  return { label: c, probability: probabilities[c]!, probabilities };
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Keeps a judge request well under the relay's 56 KB, with up to 20 precedents. */
const JUDGE_ITEM_MAX_BYTES = 2 * 1024;
const JUDGE_DETAILS_MAX_BYTES = 4 * 1024;
const JUDGE_SUBJECT_MAX_BYTES = 512;
const JUDGE_REASON_MAX_BYTES = 1024;

function judgeState(req: JudgeRequest) {
  return {
    item: {
      summary: truncateUtf8(req.item.summary, JUDGE_ITEM_MAX_BYTES),
      ...(req.item.details !== undefined && {
        details: capUtf8(req.item.details, JUDGE_DETAILS_MAX_BYTES),
      }),
      ...(req.item.domain !== undefined && { domain: req.item.domain }),
    },
    precedents: req.precedents.slice(0, 20).map((p) => ({
      subject: truncateUtf8(p.subject, JUDGE_SUBJECT_MAX_BYTES),
      verdict: p.verdict,
      reason: truncateUtf8(p.reason, JUDGE_REASON_MAX_BYTES),
      criteria: p.criteria,
      decidedAt: p.decidedAt,
      similarity: p.similarity,
    })),
  };
}

// The gate never proposes `judgment`: judgments are recorded explicitly (CON-71).
const MEMORY_TYPES: ObservedMemoryType[] = ['semantic', 'episodic', 'procedural', 'preference'];

/**
 * Keeps one Jev request body well under the relay's 64 KB limit (56 KB with the questions):
 * user and assistant text 16 KB each (head and tail), a candidate memory's text 1 KB.
 */
const STATE_TEXT_MAX_BYTES = 16 * 1024;
const CANDIDATE_TEXT_MAX_BYTES = 1024;

function obsState(obs: Observation) {
  return {
    user: capUtf8(obs.userText, STATE_TEXT_MAX_BYTES),
    assistant: capUtf8(obs.assistantText, STATE_TEXT_MAX_BYTES),
    tools: obs.toolSummaries
      .slice(0, TOOL_SUMMARIES_MAX)
      .map((t) => truncateUtf8(t, TOOL_SUMMARY_MAX_BYTES)),
    at: obs.at,
  };
}

export interface JevDeciderOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. Ignored when `client` is given. */
  apiKey?: string;
  client?: SystemOneClient;
  model?: string;
  /**
   * The TypeSafe SDK's `baseURL` (its default is `https://api.typesafe.ai`, or
   * `TYPESAFE_BASE_URL`). The Oort Pro relay is `https://relay.oortcloud.dev/v1/typesafe`,
   * with an Oort key as `apiKey` (the SDK sends `Authorization: Bearer`). Ignored with `client`.
   */
  baseURL?: string;
  /** The SDK's fetch, for tests. Ignored with `client`. */
  fetch?: typeof fetch;
  /**
   * The calls go through the Oort Pro relay. A 429 with `Retry-After` is retried once, as
   * before; a 429 without it (the monthly cap) is not retried, and the relay's message is kept on
   * the error as `relayMessage`.
   */
  relay?: boolean;
}

/** System One controller backed by TypeSafe's Jev model. One `systemOne` call per stage. */
export function jevDecider(opts: JevDeciderOptions = {}): DecisionController {
  let client = opts.client;
  if (client === undefined) {
    const apiKey = opts.apiKey ?? process.env['TYPESAFE_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      throw new MissingCredentialError('TYPESAFE_API_KEY', 'decide.apiKey');
    }
    client = new TypeSafeClient({
      apiKey,
      ...(opts.baseURL !== undefined && { baseURL: opts.baseURL }),
      ...(opts.fetch !== undefined && { fetch: opts.fetch }),
      // The SDK would retry every 429 (twice); here a cap 429 must not be retried. It keeps its
      // retries for 408 and 5xx, and `ask` makes the one retry for a 429 with Retry-After.
      // The relay checks the body, so it takes only plain JSON (no zstd) and its pinned model.
      ...(opts.relay === true && {
        retry: { httpStatuses: RELAY_RETRY_STATUSES },
        compression: false,
        defaultModel: RELAY_MODEL,
      }),
    }) as unknown as SystemOneClient;
  }
  const c = client;

  async function ask(state: unknown, questions: Record<string, unknown>) {
    try {
      const req = { state, questions, ...(opts.model === undefined ? {} : { model: opts.model }) };
      let res: Awaited<ReturnType<SystemOneClient['systemOne']>>;
      try {
        res = await c.systemOne(req);
      } catch (e) {
        const wait =
          e instanceof RateLimitError && opts.relay === true ? e.retryAfterMs : undefined;
        if (wait === undefined) throw e;
        await new Promise((r) => setTimeout(r, Math.min(wait, MAX_RETRY_AFTER_MS)));
        res = await c.systemOne(req);
      }
      if (!isObj(res) || !isObj(res.answers)) throw bad();
      return res.answers as Record<string, unknown>;
    } catch (e) {
      throw wrap(e, opts.relay === true);
    }
  }

  return {
    async gate(obs: Observation): Promise<GateDecision> {
      const questions: Record<string, unknown> = {
        should_store: noul(SHOULD_STORE_INSTRUCTIONS),
        salience: score(SALIENCE_INSTRUCTIONS, [...SALIENCE_LEVELS]),
      };
      for (const t of MEMORY_TYPES) questions[`type_${t}`] = noul(TYPE_INSTRUCTIONS[t]);
      questions['volatile'] = noul(VOLATILE_INSTRUCTIONS);

      const answers = await ask(obsState(obs), questions);
      const decisions: Decision[] = [];
      const yesNo = (question: string, p: number) =>
        decisions.push({
          stage: 'gate',
          question,
          answer: p >= 0.5 ? 'yes' : 'no',
          probability: p,
        });

      const shouldStore = noulOf(answers, 'should_store');
      yesNo('should_store', shouldStore);

      const sal = scoreOf(answers, 'salience');
      const s = clamp(sal.score, 0, 3);
      const level = Math.round(s);
      const lp = sal.probabilities[String(level)];
      if (!isProb(lp)) throw bad();
      decisions.push({
        stage: 'gate',
        question: 'salience',
        answer: SALIENCE_NAMES[level]!,
        probability: lp,
      });

      const types: Partial<Record<MemoryType, number>> = {};
      for (const t of MEMORY_TYPES) {
        const p = noulOf(answers, `type_${t}`);
        types[t] = p;
        yesNo(`type_${t}`, p);
      }
      // Recorded on the memory: recall marks a volatile fact that has not been confirmed lately.
      // A hint, not a requirement: an answer without it (an older relay) still gates.
      if (answers['volatile'] === undefined) {
        return { shouldStore, salience: 0.1 + 0.3 * s, types, decisions };
      }
      const volatile = noulOf(answers, 'volatile');
      yesNo('volatile', volatile);
      return { shouldStore, salience: 0.1 + 0.3 * s, types, volatile, decisions };
    },

    async reconcile(obs: Observation, candidates: Memory[]): Promise<ReconcileDecision[]> {
      const one = (
        question: string,
        candidateId: string | null,
        a: ReturnType<typeof choiceOf>,
      ) => ({
        candidateId,
        action: a.action,
        probability: a.probability,
        decisions: [{ stage: 'reconcile', question, answer: a.action, probability: a.probability }],
      });

      if (candidates.length === 0) {
        const answers = await ask(
          { observation: obsState(obs), candidates: [] },
          { novel: choice(NOVEL_INSTRUCTIONS, NOVEL_CRITERIA) },
        );
        return [one('novel', null, choiceOf(answers, 'novel'))];
      }

      const questions: Record<string, unknown> = {};
      candidates.forEach((_, i) => {
        questions[`c${i}`] = choice(reconcileInstructions(i), RECONCILE_CRITERIA);
      });
      const state = {
        observation: obsState(obs),
        candidates: candidates.map((m) => ({
          id: m.id,
          text: truncateUtf8(m.text, CANDIDATE_TEXT_MAX_BYTES),
          type: m.type,
          validFrom: m.validFrom,
        })),
      };
      const answers = await ask(state, questions);
      return candidates.map((m, i) => one(`c${i}`, m.id, choiceOf(answers, `c${i}`)));
    },

    /**
     * Judgment memory (CON-71): one Choice over the verdicts, with the item and the precedents
     * (their reasons verbatim, cut to size) as state. Links (`ref`) are not sent.
     */
    async judge(req: JudgeRequest): Promise<JudgeChoice> {
      const verdicts = [...new Set(req.verdicts)];
      if (verdicts.length < 2 || req.precedents.length === 0) throw bad();
      const criteria = Object.fromEntries(verdicts.map((v) => [v, verdictCriterion(v)]));
      const answers = await ask(judgeState(req), {
        verdict: choice(JUDGE_INSTRUCTIONS, criteria),
      });
      const a = labelChoiceOf(answers, 'verdict', verdicts);
      return {
        verdict: a.label,
        probability: a.probability,
        probabilities: a.probabilities,
        decisions: [
          { stage: 'judge', question: 'verdict', answer: a.label, probability: a.probability },
        ],
      };
    },

    async reconcileMany(items) {
      // One call for several facts, split where one request would outgrow the size cap.
      const out: ReconcileDecision[][] = [];
      let chunk: number[] = [];
      const flush = async () => {
        if (chunk.length === 0) return;
        out.push(...(await reconcileChunk(chunk.map((j) => items[j]!))));
        chunk = [];
      };
      for (let j = 0; j < items.length; j++) {
        const next = [...chunk, j].map((k) => items[k]!);
        if (chunk.length > 0 && requestBytes(manyRequest(next)) > MANY_REQUEST_MAX_BYTES)
          await flush();
        chunk.push(j);
      }
      await flush();
      return out;
    },
  };

  async function reconcileChunk(
    items: { obs: Observation; candidates: Memory[] }[],
  ): Promise<ReconcileDecision[][]> {
    const { state, questions } = manyRequest(items);
    const answers = await ask(state, questions);
    return items.map((it, j) => {
      const one = (question: string, candidateId: string | null) => {
        const a = choiceOf(answers, question);
        return {
          candidateId,
          action: a.action,
          probability: a.probability,
          decisions: [
            { stage: 'reconcile', question, answer: a.action, probability: a.probability },
          ],
        };
      };
      if (it.candidates.length === 0) return [one(`f${j}_novel`, null)];
      return it.candidates.map((m, i) => one(`f${j}_c${i}`, m.id));
    });
  }
}

/** Keeps a batched reconcile body under the relay's 56 KB, with room for the request envelope. */
const MANY_REQUEST_MAX_BYTES = 48 * 1024;

const requestBytes = (r: unknown): number => new TextEncoder().encode(JSON.stringify(r)).byteLength;

function manyRequest(items: { obs: Observation; candidates: Memory[] }[]) {
  const questions: Record<string, unknown> = {};
  items.forEach((it, j) => {
    if (it.candidates.length === 0) {
      questions[`f${j}_novel`] = choice(novelManyInstructions(j), NOVEL_CRITERIA);
    } else {
      it.candidates.forEach((_, i) => {
        questions[`f${j}_c${i}`] = choice(reconcileManyInstructions(j, i), RECONCILE_CRITERIA);
      });
    }
  });
  const state = {
    facts: items.map((it) => ({
      observation: obsState(it.obs),
      candidates: it.candidates.map((m) => ({
        id: m.id,
        text: truncateUtf8(m.text, CANDIDATE_TEXT_MAX_BYTES),
        type: m.type,
        validFrom: m.validFrom,
      })),
    })),
  };
  return { state, questions };
}
