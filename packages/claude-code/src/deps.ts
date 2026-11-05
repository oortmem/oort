import type {
  DecisionController,
  Embedder,
  Memory,
  MemoryStore,
  MemoryWriter,
  Observation,
  Home,
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
  /**
   * Saves one turn. `turnRef` is stable for the turn across retries, so a drain that crashes after
   * the save and runs again cannot save it twice.
   */
  observe(obs: Observation, projectId?: string, turnRef?: string): Promise<void>;
}

export interface HookDeps {
  store: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  decide?: DecisionController;
  write?: MemoryWriter;
  config: ResolvedConfig;
  scope?: Scope;
  /** Where Claude Code's new memories land: its Star when configured as one, else the Planet. */
  home?: Home;
  now?: () => Date;
  log: HookLogger;
  spawnDrain?: () => void;
  /** Oort Cloud mode: recall and save remotely (see `RemoteMemory`). */
  remote?: RemoteMemory;
}
