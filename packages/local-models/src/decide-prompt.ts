import { capUtf8, truncateUtf8, type Memory, type Observation } from '@oortmem/core';
import type { DecideModelSpec } from './catalog.js';
import {
  NOVEL_INSTRUCTIONS,
  SALIENCE_INSTRUCTIONS,
  SALIENCE_LEVELS,
  SALIENCE_NAMES,
  SHOULD_STORE_INSTRUCTIONS,
  TYPE_INSTRUCTIONS,
  VOLATILE_INSTRUCTIONS,
} from './questions.js';

/**
 * The prompts the local decider runs. Every question is answered by one word (yes or no, or one
 * of a few named options), read from the next-token distribution: one forward pass per question,
 * nothing generated. Text that several questions share (the system prompt, the exchange, the
 * memory and observation pair) comes first, so its key/value cache is computed once and each
 * question only adds its own few tokens.
 *
 * Small models answer yes-or-no questions far better than one six-way choice (measured in
 * docs/local-decider.md), so reconcile is asked as a short tree of yes-or-no questions and the
 * six actions' probabilities are the products along its branches.
 */

/** Data never closes the chat format: `<|im_end|>` in a turn would end the message early. */
export function neutralise(s: string): string {
  return s.replace(/<\|/g, '< |').replace(/\|>/g, '| >');
}

/** How much of a turn the local model reads (UTF-8 bytes): prefill time grows with every token. */
export interface StateCaps {
  user: number;
  assistant: number;
  tools: number;
  toolBytes: number;
  candidate: number;
}

export const DEFAULT_CAPS: StateCaps = {
  user: 2000,
  assistant: 1500,
  tools: 4,
  toolBytes: 160,
  candidate: 600,
};

/** A question answered by one of `answers` (each a single word), after the shared text. */
export interface WordQuestion<T extends string> {
  answers: readonly T[];
  /** The answer word for each answer, in the same order (what the model writes). */
  words: readonly string[];
  /** The question, its options and the answer cue. */
  suffix: string;
}

export function answerCue(spec: Pick<DecideModelSpec, 'template'>): string {
  const open = '<|im_end|>\n<|im_start|>assistant\n';
  return spec.template === 'chatml-nothink' ? `${open}<think>\n\n</think>\n\n` : open;
}

function yesNo(spec: Pick<DecideModelSpec, 'template'>, text: string): WordQuestion<'yes' | 'no'> {
  return {
    answers: ['yes', 'no'],
    words: ['yes', 'no'],
    suffix: `${text}\nAnswer yes or no.${answerCue(spec)}`,
  };
}

function oneOf<T extends string>(
  spec: Pick<DecideModelSpec, 'template'>,
  text: string,
  options: readonly (readonly [T, string, string])[],
): WordQuestion<T> {
  const words = options.map(([, w]) => w);
  const list = `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
  return {
    answers: options.map(([a]) => a),
    words,
    suffix: `${text}\n${options.map(([, w, label]) => `${w}: ${label}`).join('\n')}\nAnswer with one word: ${list}.${answerCue(spec)}`,
  };
}

const system = (text: string): string =>
  `<|im_start|>system\n${text}<|im_end|>\n<|im_start|>user\n`;

export const GATE_SYSTEM = system(
  'You help an AI coding assistant decide what to remember between sessions. You read one exchange between a developer and the assistant, then answer a question about it with one word.',
);

/** The exchange, as the gate's questions share it. Ends with a blank line. */
export function gateState(obs: Observation, caps: StateCaps = DEFAULT_CAPS): string {
  const tools = obs.toolSummaries
    .slice(0, caps.tools)
    .map((t) => `- ${neutralise(truncateUtf8(t, caps.toolBytes))}`);
  return [
    `Exchange (at ${neutralise(obs.at)}):`,
    `<user>\n${neutralise(capUtf8(obs.userText, caps.user))}\n</user>`,
    `<assistant>\n${neutralise(capUtf8(obs.assistantText, caps.assistant))}\n</assistant>`,
    ...(tools.length > 0 ? [`<tools>\n${tools.join('\n')}\n</tools>`] : []),
    '',
    '',
  ].join('\n');
}

/** The memory types as one question; the labels restate TYPE_INSTRUCTIONS. */
const TYPE_OPTIONS = [
  ['semantic', 'fact', 'a durable fact about a codebase, system, product or person'],
  ['episodic', 'event', 'a specific event or incident at a point in time'],
  [
    'procedural',
    'procedure',
    'a reusable how-to, such as a command sequence, workflow or playbook',
  ],
  ['preference', 'preference', 'a stated preference or rule for style, tools or communication'],
] as const;

export const TYPE_QUESTION = `Which kind of memory would this exchange make? (${Object.keys(TYPE_INSTRUCTIONS).join(', ')} in the memory's terms)`;

export function gateQuestions(spec: Pick<DecideModelSpec, 'template'>) {
  return {
    should_store: yesNo(spec, SHOULD_STORE_INSTRUCTIONS),
    salience: oneOf(
      spec,
      SALIENCE_INSTRUCTIONS,
      SALIENCE_LEVELS.map((l, i) => {
        const [name, ...rest] = l.split(': ');
        return [String(i), name ?? SALIENCE_NAMES[i]!, rest.join(': ')] as const;
      }),
    ),
    type: oneOf(spec, TYPE_QUESTION, TYPE_OPTIONS),
    volatile: yesNo(spec, VOLATILE_INSTRUCTIONS),
  };
}

export const RECONCILE_SYSTEM = system(
  "You maintain an AI coding assistant's long-term memory. You compare a new observation with one existing memory and answer a yes-or-no question about them.",
);

export const NOVEL_SYSTEM = system(
  "You maintain an AI coding assistant's long-term memory. You read a new observation and answer a yes-or-no question about it.",
);

/** An observation as reconcile reads it: a fact the writer split out is its user text alone. */
function observationText(obs: Observation, caps: StateCaps): string {
  const user = neutralise(capUtf8(obs.userText, caps.user));
  if (obs.assistantText === '' && obs.toolSummaries.length === 0) return user;
  return `user: ${user}\nassistant: ${neutralise(capUtf8(obs.assistantText, caps.assistant))}`;
}

/** The memory and observation pair every reconcile question shares. Ends with a blank line. */
export function reconcileState(
  obs: Observation,
  candidate: Pick<Memory, 'text' | 'validFrom'>,
  caps: StateCaps = DEFAULT_CAPS,
): string {
  return [
    `Existing memory (valid from ${neutralise(candidate.validFrom)}):`,
    neutralise(truncateUtf8(candidate.text, caps.candidate)),
    '',
    `New observation (at ${neutralise(obs.at)}):`,
    observationText(obs, caps),
    '',
    '',
  ].join('\n');
}

/**
 * The reconcile tree. `related` no: NOOP. Related and `conflict`: SUPERSEDE, or CORRECT when
 * `mistake`. Related, no conflict: REINFORCE unless `newinfo`; with new information, REFINE when
 * `samefact`, else ADD. The wording follows RECONCILE_CRITERIA.
 */
export const RECONCILE_TREE = {
  related:
    'Are the new observation and the existing memory about the same specific thing (the same setting, component, person, schedule or rule)?',
  conflict:
    'Do the new observation and the existing memory disagree, so that both cannot be true now?',
  mistake:
    'Does the new observation say the existing memory was never right: a mistake, a misreading, a typo or a wrong assumption?',
  newinfo:
    'Does the new observation add any information that the existing memory does not already contain?',
  samefact:
    'Is the added information more detail about the very same fact, rather than a separate new fact that should be stored on its own?',
} as const;

export type TreeQuestion = keyof typeof RECONCILE_TREE;

export function reconcileQuestions(spec: Pick<DecideModelSpec, 'template'>) {
  const out = {} as Record<TreeQuestion, WordQuestion<'yes' | 'no'>>;
  for (const [k, text] of Object.entries(RECONCILE_TREE)) {
    out[k as TreeQuestion] = yesNo(spec, text);
  }
  return out;
}

export type LocalAction = 'NOOP' | 'REINFORCE' | 'REFINE' | 'SUPERSEDE' | 'CORRECT' | 'ADD';

/** The six actions' probabilities from the tree's yes-probabilities (they sum to 1). */
export function treeProbabilities(p: Record<TreeQuestion, number>): Record<LocalAction, number> {
  const { related: r, conflict: c, mistake: m, newinfo: n, samefact: f } = p;
  return {
    NOOP: 1 - r,
    SUPERSEDE: r * c * (1 - m),
    CORRECT: r * c * m,
    REINFORCE: r * (1 - c) * (1 - n),
    REFINE: r * (1 - c) * n * f,
    ADD: r * (1 - c) * n * (1 - f),
  };
}

export function novelState(obs: Observation, caps: StateCaps = DEFAULT_CAPS): string {
  return `New observation (at ${neutralise(obs.at)}):\n${observationText(obs, caps)}\n\n`;
}

export function novelQuestion(spec: Pick<DecideModelSpec, 'template'>) {
  return yesNo(spec, NOVEL_INSTRUCTIONS);
}
