import type {
  DecisionController,
  Embedder,
  MemoryStore,
  MemoryWriter,
  Reranker,
  ResolvedConfig,
  Scope,
} from '@oortmem/core';
import type { HookLogger } from './log.js';

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
}
