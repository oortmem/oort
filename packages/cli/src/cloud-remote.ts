import type { RemoteMemory } from '@oortmem/claude-code';
import type { Memory } from '@oortmem/core';
import { createHash } from 'node:crypto';
import { OortCloudError, type CloudClient } from './cloud.js';

/** The API's turnRef cap; a longer ref is replaced by its hash (still stable across retries). */
const TURN_REF_MAX = 128;

export function cloudTurnRef(ref: string): string {
  return ref.length <= TURN_REF_MAX && /^[\x20-\x7e]+$/.test(ref)
    ? ref
    : createHash('sha256').update(ref).digest('hex');
}

/** Pinned and hot memories SessionStart injects: at most this many of each from the API. */
const SESSION_LIMIT = 100;

/**
 * The hooks' view of Oort Cloud. Recall and save go to the API; every failure rejects (the hooks
 * then inject nothing, and the drain keeps account-level refusals queued). With no client (no Oort
 * key, a bad URL), every call rejects the same way.
 */
export function cloudRemote(
  client: CloudClient | undefined,
  problem?: string,
  here?: { projectId: string | undefined; private?: boolean },
  /** The agent the hooks act as: it reads only the Constellations it is attached to (CON-64). */
  agent?: string,
): RemoteMemory {
  // Calls about the project this process runs in state its privacy when its own config file sets
  // it, so the cloud knows whether that project's memories may be shared. A default states
  // nothing, and so does another project (a drained turn).
  const privacy = (projectId: string | undefined) =>
    projectId !== undefined && here?.private !== undefined && projectId === here.projectId
      ? { projectPrivate: here.private }
      : {};
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
      client.recall({
        text,
        ...(projectId !== undefined && { project: projectId }),
        ...privacy(projectId),
        ...(agent !== undefined && { agent }),
        k: 10,
      }),
    sessionMemories: async ({ projectId }) => {
      const project = projectId !== undefined && { project: projectId };
      // Pinned first (any tier), then the hot tier; a memory in both appears once.
      const [pinned, hot] = await Promise.all([
        client.list({ ...project, pinned: true, limit: SESSION_LIMIT }),
        client.list({ ...project, tier: 'hot', limit: SESSION_LIMIT }),
      ]);
      const seen = new Set<string>();
      const out: Memory[] = [];
      for (const m of [...pinned.memories, ...hot.memories]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m as Memory);
      }
      return out;
    },
    observe: async (obs, projectId, turnRef) => {
      try {
        // A repeat of the same turnRef answers `duplicate: true`: already saved, so success.
        await client.observe({
          ...(projectId !== undefined && { project: projectId }),
          ...privacy(projectId),
          ...(turnRef !== undefined && { turnRef: cloudTurnRef(turnRef) }),
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
