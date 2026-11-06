import type { Observation } from '@oortmem/core';

/** One turn as an Observation, the way `oort observe --user --assistant` builds it. */
export function turnObservation(
  userText: string,
  assistantText: string,
  at = new Date().toISOString(),
): Observation {
  return { userText, assistantText, toolSummaries: [], at };
}
