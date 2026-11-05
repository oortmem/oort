import type {
  Decision,
  DecisionController,
  GateDecision,
  Memory,
  MemoryType,
  Observation,
  ReconcileDecision,
} from '@oortmem/core';
import { DEFAULT_DECIDE_MODEL, type DecideModelSpec, type DecideQuestion } from './catalog.js';
import {
  DEFAULT_CAPS,
  GATE_SYSTEM,
  NOVEL_SYSTEM,
  RECONCILE_SYSTEM,
  gateQuestions,
  gateState,
  novelQuestion,
  novelState,
  reconcileQuestions,
  reconcileState,
  treeProbabilities,
  type LocalAction,
  type StateCaps,
  type TreeQuestion,
  type WordQuestion,
} from './decide-prompt.js';
import { LocalModelError, readyModel } from './errors.js';
import { SALIENCE_NAMES } from './questions.js';
import {
  onnxRuntime,
  type DecoderTokenizer,
  type KvCache,
  type LoadedDecoder,
  type Runtime,
} from './runtime.js';

export interface LocalDeciderOptions {
  /** `$OORT_HOME`; models live in `<home>/models/<id>`. */
  home: string;
  /** Catalog id, default `DEFAULT_DECIDE_MODEL`. */
  model?: string;
  /** Default: ONNX Runtime. */
  runtime?: Runtime;
  threads?: number;
  /** A model outside the catalog (tests, experiments); used when its id is `model`. */
  spec?: DecideModelSpec;
  /**
   * false (the default): reconcile never rewrites or ends a memory. It asks only whether the
   * observation is about the same thing as each candidate, and answers NOOP (unrelated) or ADD:
   * a missed supersede leaves two memories, a wrong one ends a true memory, and no small model
   * measured so far tells REINFORCE, REFINE, SUPERSEDE and CORRECT apart reliably enough.
   * true: the whole reconcile tree is asked, and `minRewriteProbability` guards its rewrites.
   */
  allowRewrites?: boolean;
  /**
   * With `allowRewrites`: a rewrite (REFINE, SUPERSEDE or CORRECT) chosen with less probability
   * than this becomes the likeliest answer that keeps the memory (ADD, REINFORCE or NOOP).
   * Default `DEFAULT_MIN_REWRITE_PROBABILITY`.
   */
  minRewriteProbability?: number;
  /** How much of a turn the model reads. */
  caps?: Partial<StateCaps>;
  /** Called after every forward pass, for benchmarks. */
  onPass?: (p: { tokens: number; ms: number }) => void;
  /** Called with each yes-or-no answer before calibration, for fitting it (pnpm eval --fit). */
  onAnswer?: (question: DecideQuestion, yes: number) => void;
}

export interface LocalDecider extends DecisionController {
  readonly model: string;
  /** Loads the model now instead of on the first decision. */
  load(): Promise<void>;
}

export const DEFAULT_MIN_REWRITE_PROBABILITY = 0.5;

const REWRITES = new Set<LocalAction>(['REFINE', 'SUPERSEDE', 'CORRECT']);
const KEEPS = ['ADD', 'REINFORCE', 'NOOP'] as const;
const MEMORY_TYPES: MemoryType[] = ['semantic', 'episodic', 'procedural', 'preference'];
const TREE: TreeQuestion[] = ['related', 'conflict', 'mistake', 'newinfo', 'samefact'];

/**
 * The token ids that start `word` as a model would write it: as is, capitalised, and after a
 * space. "Yes" and "yes" are the same answer; scoring only one of them reads the model's casing
 * preference instead of its judgement.
 */
export function answerTokenIds(tokenizer: DecoderTokenizer, word: string): number[] {
  const cap = word.charAt(0).toUpperCase() + word.slice(1);
  const ids = [word, cap, ` ${word}`, ` ${cap}`].map((v) => tokenizer.encode(v)[0]);
  return [...new Set(ids.filter((i): i is number => i !== undefined))];
}

/**
 * The probability of each answer among the answers only: each answer's mass is the sum over its
 * token ids (log-sum-exp of their logits), then normalised across answers.
 */
export function answerProbabilities(
  logits: Float32Array,
  answers: readonly (readonly number[])[],
): number[] {
  const lse = answers.map((ids) => {
    const xs = ids.map((id) => logits[id] ?? -Infinity);
    const max = Math.max(...xs);
    if (max === -Infinity) return -Infinity;
    return max + Math.log(xs.reduce((a, x) => a + Math.exp(x - max), 0));
  });
  const max = Math.max(...lse);
  const es = lse.map((x) => Math.exp(x - max));
  const sum = es.reduce((a, b) => a + b, 0);
  return es.map((e) => e / sum);
}

/** `p` moved by `bias` in log-odds: sigmoid(logit(p) + bias). */
export function shiftProbability(p: number, bias: number | undefined): number {
  if (bias === undefined || bias === 0) return p;
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return 1 / (1 + Math.exp(-(Math.log(q / (1 - q)) + bias)));
}

/**
 * The decision controller on this machine's CPU: a small instruction-tuned language model
 * answers the questions Jev answers (decide-jev), each with one word, and the probabilities are
 * read from the next-token distribution in one forward pass per question. Nothing is generated,
 * so the answers are deterministic. Loaded on the first decision; constructing one only checks
 * that the model was pulled.
 */
export function localDecider(opts: LocalDeciderOptions): LocalDecider {
  const id = opts.model ?? DEFAULT_DECIDE_MODEL;
  const { spec: s, dir } = readyModel(opts.home, 'decide', id, opts.spec);
  const spec = s as DecideModelSpec;
  const runtime = opts.runtime ?? onnxRuntime();
  if (runtime.loadDecoder === undefined) {
    throw new LocalModelError('wrong-role', `this runtime cannot run decision model ${id}.`);
  }
  const loadDecoder = runtime.loadDecoder.bind(runtime);
  const caps: StateCaps = { ...DEFAULT_CAPS, ...opts.caps };
  const minRewrite = opts.minRewriteProbability ?? DEFAULT_MIN_REWRITE_PROBABILITY;
  const allowRewrites = opts.allowRewrites === true;
  const shift = (q: DecideQuestion, p: number): number => {
    opts.onAnswer?.(q, p);
    return shiftProbability(p, spec.calibration[q]);
  };
  const gq = gateQuestions(spec);
  const rq = reconcileQuestions(spec);
  const nq = novelQuestion(spec);

  interface Ready {
    m: LoadedDecoder;
    ids: Map<string, number[]>;
    prefixes: Map<string, Promise<KvCache>>;
  }
  let ready: Promise<Ready> | undefined;
  const load = (): Promise<Ready> => {
    if (ready === undefined) {
      const p = (async (): Promise<Ready> => {
        const m = await loadDecoder(
          dir,
          spec.kvCache,
          opts.threads === undefined ? {} : { threads: opts.threads },
        );
        return { m, ids: new Map(), prefixes: new Map() };
      })();
      p.catch(() => {
        if (ready === p) ready = undefined;
      });
      ready = p;
    }
    return ready;
  };

  function idsOf(r: Ready, q: WordQuestion<string>): number[][] {
    const sets = q.words.map((w) => {
      let ids = r.ids.get(w);
      if (ids === undefined) {
        ids = answerTokenIds(r.m.tokenizer, w);
        r.ids.set(w, ids);
      }
      return ids;
    });
    // A token that starts two answers (an unknown-word token, say) tells them apart from nothing.
    const count = new Map<number, number>();
    for (const t of sets.flat()) count.set(t, (count.get(t) ?? 0) + 1);
    const distinct = sets.map((ids) => ids.filter((t) => count.get(t) === 1));
    if (distinct.some((ids) => ids.length === 0)) {
      throw new Error(`local model ${id}: the answers ${q.words.join(', ')} share a first token`);
    }
    return distinct;
  }

  async function forward(r: Ready, text: string, past?: KvCache) {
    const ids = r.m.tokenizer.encode(text);
    const t0 = performance.now();
    const out = await r.m.forward(ids, past);
    opts.onPass?.({ tokens: ids.length, ms: performance.now() - t0 });
    return out;
  }

  /** The cache after a fixed prefix (a system prompt), computed once per decider. */
  function prefix(r: Ready, text: string): Promise<KvCache> {
    let p = r.prefixes.get(text);
    if (p === undefined) {
      p = forward(r, text).then((o) => o.cache);
      p.catch(() => r.prefixes.delete(text));
      r.prefixes.set(text, p);
    }
    return p;
  }

  /** The cache after a prefix and then `text`. */
  async function state(r: Ready, sys: string, text: string): Promise<KvCache> {
    return (await forward(r, text, await prefix(r, sys))).cache;
  }

  async function ask<T extends string>(
    r: Ready,
    q: WordQuestion<T>,
    past: KvCache,
  ): Promise<Record<T, number>> {
    const { logits } = await forward(r, q.suffix, past);
    const ps = answerProbabilities(logits, idsOf(r, q));
    const out = {} as Record<T, number>;
    q.answers.forEach((a, i) => (out[a] = ps[i]!));
    return out;
  }

  async function reconcileOne(
    r: Ready,
    obs: Observation,
    candidates: Memory[],
    qid: (i: number) => string,
    novelId: string,
  ): Promise<ReconcileDecision[]> {
    if (candidates.length === 0) {
      const p = shift(
        'novel',
        (await ask(r, nq, await state(r, NOVEL_SYSTEM, novelState(obs, caps)))).yes,
      );
      const action = p >= 0.5 ? 'ADD' : 'NOOP';
      const probability = action === 'ADD' ? p : 1 - p;
      return [
        {
          candidateId: null,
          action,
          probability,
          decisions: [{ stage: 'reconcile', question: novelId, answer: action, probability }],
        },
      ];
    }
    const out: ReconcileDecision[] = [];
    for (const [i, m] of candidates.entries()) {
      const st = await state(r, RECONCILE_SYSTEM, reconcileState(obs, m, caps));
      const yes = {} as Record<TreeQuestion, number>;
      if (!allowRewrites) {
        // Same thing or not: ADD keeps the new fact and the old memory both.
        const related = shift('related', (await ask(r, rq.related, st)).yes);
        const action = related >= 0.5 ? 'ADD' : 'NOOP';
        const probability = action === 'ADD' ? related : 1 - related;
        out.push({
          candidateId: m.id,
          action,
          probability,
          decisions: [{ stage: 'reconcile', question: qid(i), answer: action, probability }],
        });
        continue;
      }
      for (const q of TREE) yes[q] = shift(q, (await ask(r, rq[q], st)).yes);
      const ps = treeProbabilities(yes);
      let action = (Object.keys(ps) as LocalAction[]).reduce((b, a) => (ps[a] > ps[b] ? a : b));
      let probability = ps[action];
      const decisions: Decision[] = [
        { stage: 'reconcile', question: qid(i), answer: action, probability },
      ];
      if (REWRITES.has(action) && probability < minRewrite) {
        // Too unsure to end or rewrite a memory: the likeliest answer that keeps it.
        const safe = KEEPS.reduce((b, a) => (ps[a] > ps[b] ? a : b));
        decisions.push({
          stage: 'reconcile',
          question: `${qid(i)}_guard`,
          answer: `${action}->${safe}`,
          probability,
        });
        action = safe;
        probability = ps[safe];
      }
      out.push({ candidateId: m.id, action, probability, decisions });
    }
    return out;
  }

  return {
    model: id,
    async load() {
      await load();
    },

    async gate(obs: Observation): Promise<GateDecision> {
      const r = await load();
      const st = await state(r, GATE_SYSTEM, gateState(obs, caps));
      const decisions: Decision[] = [];
      const yesNo = (question: string, p: number) =>
        decisions.push({
          stage: 'gate',
          question,
          answer: p >= 0.5 ? 'yes' : 'no',
          probability: p,
        });

      const shouldStore = shift('should_store', (await ask(r, gq.should_store, st)).yes);
      yesNo('should_store', shouldStore);

      const sal = await ask(r, gq.salience, st);
      // The expected level, as Jev's score: 0 (trivial) to 3 (critical).
      const score = gq.salience.answers.reduce((acc, a, i) => acc + i * (sal[a] ?? 0), 0);
      const level = Math.round(score);
      decisions.push({
        stage: 'gate',
        question: 'salience',
        answer: SALIENCE_NAMES[level]!,
        probability: sal[gq.salience.answers[level]!] ?? 0,
      });

      // One question over the four types, so their probabilities sum to 1.
      const type = await ask(r, gq.type, st);
      const types: Partial<Record<MemoryType, number>> = {};
      for (const t of MEMORY_TYPES) {
        types[t] = type[t];
        yesNo(`type_${t}`, type[t]);
      }

      const volatile = shift('volatile', (await ask(r, gq.volatile, st)).yes);
      yesNo('volatile', volatile);
      return { shouldStore, salience: 0.1 + 0.3 * score, types, volatile, decisions };
    },

    async reconcile(obs: Observation, candidates: Memory[]): Promise<ReconcileDecision[]> {
      const r = await load();
      return reconcileOne(r, obs, candidates, (i) => `c${i}`, 'novel');
    },

    async reconcileMany(items) {
      const r = await load();
      const out: ReconcileDecision[][] = [];
      for (const [j, it] of items.entries()) {
        out.push(await reconcileOne(r, it.obs, it.candidates, (i) => `f${j}_c${i}`, `f${j}_novel`));
      }
      return out;
    },
  };
}
