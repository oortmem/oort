import type { RemoteMemory } from '@oortmem/claude-code';
import { scrubForCloud } from './cloud-scrub.js';
import type { Memory } from '@oortmem/core';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OortCloudError, type CloudClient } from './cloud.js';

/** The API's turnRef cap; a longer ref is replaced by its hash (still stable across retries). */
const TURN_REF_MAX = 128;

export function cloudTurnRef(ref: string): string {
  return ref.length <= TURN_REF_MAX && /^[\x20-\x7e]+$/.test(ref)
    ? ref
    : createHash('sha256').update(ref).digest('hex');
}

/**
 * The API reads at most this many bytes of recall text (`recallTextBytes` in the contract) and
 * refuses a longer one with 413, so a long prompt (a pasted log, a diff) would recall nothing.
 */
export const RECALL_TEXT_MAX_BYTES = 2048;
const ELLIPSIS = '\n…\n';

/**
 * `text` within RECALL_TEXT_MAX_BYTES of UTF-8: unchanged when it fits, else its start and its end
 * (where a question after a paste usually is) joined by an ellipsis, never splitting a character.
 */
export function clipRecallText(text: string, max = RECALL_TEXT_MAX_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(text).byteLength <= max) return text;
  const room = max - enc.encode(ELLIPSIS).byteLength;
  const chars = [...text];
  const take = (from: 'start' | 'end', budget: number): string => {
    const out: string[] = [];
    let used = 0;
    for (let i = 0; i < chars.length; i++) {
      const c = from === 'start' ? chars[i]! : chars[chars.length - 1 - i]!;
      const n = enc.encode(c).byteLength;
      if (used + n > budget) break;
      used += n;
      out.push(c);
    }
    return from === 'start' ? out.join('') : out.reverse().join('');
  };
  const head = take('start', Math.floor(room / 2));
  const tail = take('end', room - enc.encode(head).byteLength);
  return `${head}${ELLIPSIS}${tail}`;
}

/** What the prompt hook asks of the API for `recall.promptMode` (CON-101). */
const PROMPT_MODE: Record<PromptMode, { rerank?: false; embed?: false }> = {
  full: {},
  fast: { rerank: false },
  lexical: { rerank: false, embed: false },
};

export type PromptMode = 'full' | 'fast' | 'lexical';

/**
 * Whether this API refused `rerank: "gate-miss"` lately (CON-131). An API from before it answers
 * 400; the prompt hook then recalls as plain `fast` and stops asking, in this process (`oort
 * serve`) and in the hooks that start after it (a file in the cache, by API URL). It asks again
 * a day later, or against another API, so a deploy that adds it is picked up.
 */
export interface GateMissSupport {
  refused(): boolean;
  remember(): void;
}

const GATE_MISS_RETRY_MS = 24 * 3600_000;
const refusedInProcess = new Map<string, number>();

export function gateMissSupport(
  home: string,
  apiUrl: string,
  now: () => number = Date.now,
): GateMissSupport {
  const file = path.join(home, 'cache', 'cloud-gate-miss.json');
  // A refusal counts for a day after it, never before: a time ahead of the clock (a clock that
  // ran fast, or an edited file) would otherwise keep the back-off on for good.
  const fresh = (at: number | undefined) => {
    if (at === undefined) return false;
    const age = now() - at;
    return age >= 0 && age < GATE_MISS_RETRY_MS;
  };
  return {
    refused() {
      if (fresh(refusedInProcess.get(apiUrl))) return true;
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        const at = v[apiUrl];
        return typeof at === 'number' && fresh(at);
      } catch {
        return false;
      }
    },
    remember() {
      const at = now();
      refusedInProcess.set(apiUrl, at);
      // Best effort: a hook that cannot write still recalls, and asks again next time.
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, `${JSON.stringify({ [apiUrl]: at })}\n`, { mode: 0o600 });
      } catch {
        // ignore
      }
    },
  };
}

/** A 400 from an API that does not know `rerank: "gate-miss"`: it names the field. */
const refusesGateMiss = (e: unknown): boolean =>
  e instanceof OortCloudError &&
  e.kind === 'bad-request' &&
  e.status === 400 &&
  /\brerank\b/.test(e.message);

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
  /** `recall.promptMode`: what the prompt hook's recall may skip. An older API ignores it. */
  promptMode: PromptMode = 'full',
  /**
   * `recall.lexicalFirst`: whether a clear lexical answer may skip the prompt's embedding (CON-101).
   * Sent as it is (Oort Cloud runs lexical first unless told otherwise); not sent in `lexical`
   * mode, which never embeds. An older API ignores it.
   */
  lexicalFirst?: boolean,
  /**
   * `recall.promptGateMissRerank` (CON-131): in `fast` mode, ask for a rerank only when the
   * relevance gate would drop every candidate, instead of never. An API without it answers 400:
   * the recall is sent again as plain `fast`, and `gateMiss` remembers not to ask that API.
   */
  gateMissRerank?: boolean,
  gateMiss?: GateMissSupport,
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
    // Only the prompt hook recalls through here.
    recall: async ({ text, projectId }) => {
      const q = {
        text: clipRecallText(text),
        ...(projectId !== undefined && { project: projectId }),
        ...privacy(projectId),
        ...(agent !== undefined && { agent }),
        k: 10,
        ...PROMPT_MODE[promptMode],
        ...(lexicalFirst !== undefined && promptMode !== 'lexical' && { lexicalFirst }),
      };
      const ask = promptMode === 'fast' && gateMissRerank === true && gateMiss?.refused() !== true;
      if (!ask) return client.recall(q);
      try {
        return await client.recall({ ...q, rerank: 'gate-miss' });
      } catch (e) {
        if (!refusesGateMiss(e)) throw e;
        gateMiss?.remember();
        return client.recall(q);
      }
    },
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
      // Scrubbed here, before it leaves the machine; a mostly-secret turn is done, never sent.
      const s = scrubForCloud({
        user: obs.userText,
        assistant: obs.assistantText,
        at: obs.at,
        ...(obs.sessionId !== undefined && { session: obs.sessionId }),
        ...(obs.toolSummaries.length > 0 && { tools: obs.toolSummaries }),
      });
      if (s.dropped) return;
      try {
        // A repeat of the same turnRef answers `duplicate: true`: already saved, so success.
        await client.observe({
          ...(projectId !== undefined && { project: projectId }),
          ...privacy(projectId),
          ...(turnRef !== undefined && { turnRef: cloudTurnRef(turnRef) }),
          observation: s.turn,
        });
      } catch (e) {
        if (e instanceof OortCloudError) throw e; // carries holdQueue
        throw Object.assign(new Error('Oort Cloud save failed.'), { holdQueue: true });
      }
    },
  };
}
