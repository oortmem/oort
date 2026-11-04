import type {
  DecisionController,
  Embedder,
  Memory,
  MemoryStore,
  MemoryWriter,
  Observation,
  RecallResult,
  Reranker,
  ResolvedConfig,
  Scope,
} from '@oortmem/core';
import type { HookLogger } from './log.js';

/**
 * Memory that lives somewhere else (Oort Cloud). When set, the hooks recall and save through it
 * instead of the local engine; the local store still keeps the Stop cursors and the queue.
 * Every method rejects on failure; the hooks then inject nothing (they never fall back to a local
 * store that may hold nothing, or stale memories).
 */
export interface RemoteMemory {
  recall(q: { text: string; projectId?: string }): Promise<RecallResult>;
  /** Pinned and hot memories, for SessionStart. */
  sessionMemories(q: { projectId?: string }): Promise<Memory[]>;
  /**
   * Saves one turn. A rejection with `holdQueue: true` (sign-in, plan, rate limit, outage) keeps
   * the line queued untouched and stops the drain run; any other rejection counts as an attempt.
   */
  observe(obs: Observation, projectId?: string): Promise<void>;
}

export interface HookDeps {
  store: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  decide?: DecisionController;
  write?: MemoryWriter;
  config: ResolvedConfig;
  scope?: Scope;
  now?: () => Date;
  log: HookLogger;
  spawnDrain?: () => void;
  /** Oort Cloud mode: recall and save remotely (see `RemoteMemory`). */
  remote?: RemoteMemory;
}
