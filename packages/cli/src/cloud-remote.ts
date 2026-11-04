import type { RemoteMemory } from '@oortmem/claude-code';
import type { Memory } from '@oortmem/core';
import { OortCloudError, type CloudClient } from './cloud.js';

/** Hot or pinned memories SessionStart injects, at most this many from the API's first page. */
const SESSION_LIMIT = 100;

/**
 * The hooks' view of Oort Cloud. Recall and save go to the API; every failure rejects (the hooks
 * then inject nothing, and the drain keeps account-level refusals queued). With no client (no Oort
 * key, a bad URL), every call rejects the same way.
 */
export function cloudRemote(client: CloudClient | undefined, problem?: string): RemoteMemory {
  const missing = (): never => {
    throw Object.assign(new Error(problem ?? 'Oort Cloud is not set up on this machine.'), {
      holdQueue: true,
    });
  };
  if (client === undefined) {
    return {
      recall: async () => missing(),
      sessionMemories: async () => missing(),
      observe: async () => missing(),
    };
  }
  return {
    recall: ({ text, projectId }) =>
      client.recall({ text, ...(projectId !== undefined && { project: projectId }), k: 10 }),
    sessionMemories: async ({ projectId }) => {
      const r = await client.list({
        ...(projectId !== undefined && { project: projectId }),
        tier: 'hot',
        limit: SESSION_LIMIT,
      });
      return r.memories as Memory[];
    },
    observe: async (obs, projectId) => {
      try {
        await client.observe({
          ...(projectId !== undefined && { project: projectId }),
          observation: {
            user: obs.userText,
            assistant: obs.assistantText,
            at: obs.at,
            ...(obs.sessionId !== undefined && { session: obs.sessionId }),
            ...(obs.toolSummaries.length > 0 && { tools: obs.toolSummaries }),
          },
        });
      } catch (e) {
        if (e instanceof OortCloudError) throw e; // carries holdQueue
        throw Object.assign(new Error('Oort Cloud save failed.'), { holdQueue: true });
      }
    },
  };
}
