// NOTE: duplicated in packages/decide-jev/src/questions.ts (scripts/check-voyage-http.mjs)
/**
 * The questions Jev answers. Question ids are not sent to the model, so every
 * instruction must stand on its own. Later calibration work tunes this file.
 */

export const SHOULD_STORE_INSTRUCTIONS =
  'Does this exchange between a developer and an AI coding assistant contain a fact, decision, preference, or reusable procedure that would be useful to remember in a future session? Small talk, acknowledgements, and transient progress updates are not.';

export const SALIENCE_INSTRUCTIONS =
  'How important would it be for the assistant to remember this in future sessions?';

/** Ordered low to high; the gate maps score 0..3 to salience 0.1..1.0. */
export const SALIENCE_LEVELS = [
  'trivial: no lasting value',
  'useful: nice to recall but not essential',
  'important: changes how future work should be done',
  'critical: forgetting it would cause a mistake or repeated work',
] as const;

/** Short names of the salience levels, in the same order as SALIENCE_LEVELS. */
export const SALIENCE_NAMES = ['trivial', 'useful', 'important', 'critical'] as const;

export const TYPE_INSTRUCTIONS = {
  semantic:
    'Does this exchange contain a durable fact about a codebase, system, product or person that would stay true across sessions?',
  episodic:
    'Does this exchange describe a specific event or incident at a point in time, such as a debugging session or a decision made on a particular day?',
  procedural:
    'Does this exchange contain a reusable how-to, such as a command sequence, workflow or playbook for getting something done?',
  preference:
    'Does this exchange contain a stated preference or rule for style, tools or communication that the assistant should follow in future?',
} as const;

export const VOLATILE_INSTRUCTIONS =
  'Is what this exchange states likely to change within weeks, such as a status, a current version, an owner, an assignee, a deadline or a temporary workaround? Stable facts, decisions and preferences are not.';

export function reconcileInstructions(i: number): string {
  return `How does the new observation relate to the existing memory at \`candidates[${i}]\`? Judge only this one memory.`;
}

/** `reconcileInstructions` for fact `j` of a batched request (CON-56). */
export function reconcileManyInstructions(j: number, i: number): string {
  return `How does the new fact at \`facts[${j}].observation\` relate to the existing memory at \`facts[${j}].candidates[${i}]\`? Judge only this fact and this one memory.`;
}

/** `NOVEL_INSTRUCTIONS` for fact `j` of a batched request. */
export function novelManyInstructions(j: number): string {
  return `Does the new fact at \`facts[${j}].observation\` contain information worth storing as a new memory?`;
}

export const RECONCILE_CRITERIA = {
  NOOP: 'unrelated: the observation is about something else',
  REINFORCE: 'restates or confirms the memory with no new information',
  REFINE: 'the same fact with added or sharper detail; it does not contradict the memory',
  SUPERSEDE:
    'the situation changed: the memory was true until now and something else is true from now on',
  CORRECT:
    'the memory was never right: the observation says it was a mistake, a misreading or a wrong assumption',
  ADD: 'touches the same subject but carries a separate new fact that should be stored on its own',
} as const;

export const NOVEL_INSTRUCTIONS =
  'Does the new observation contain information worth storing as a new memory?';

export const NOVEL_CRITERIA = {
  ADD: 'yes, it contains a new fact, decision, preference or procedure',
  NOOP: 'no, nothing new worth storing',
} as const;
