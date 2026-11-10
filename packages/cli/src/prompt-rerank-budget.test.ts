import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@oortmem/core';
import { tmpdir } from '../test/helpers.js';
import { promptRecallConfig } from './commands/hook.js';

// CON-136: recall, MCP and the SDK wait 2 s for the reranker; the prompt hook keeps 400 ms.
describe('the prompt hook rerank budget', () => {
  it('defaults: 2000 ms for recall, 400 ms for the prompt hook', () => {
    const c = resolveConfig(tmpdir(), { OORT_HOME: tmpdir() });
    expect(c.recall.rerankBudgetMs).toBe(2000);
    expect(promptRecallConfig(c).recall.rerankBudgetMs).toBe(400);
  });

  it('follows recall.promptRerankBudgetMs and leaves the rest of the config alone', () => {
    const c = resolveConfig(tmpdir(), { OORT_HOME: tmpdir() });
    const tuned = { ...c, recall: { ...c.recall, promptRerankBudgetMs: 250 } };
    const p = promptRecallConfig(tuned);
    expect(p.recall).toEqual({ ...tuned.recall, rerankBudgetMs: 250 });
    expect(tuned.recall.rerankBudgetMs).toBe(2000);
    expect({ ...p, recall: undefined }).toEqual({ ...tuned, recall: undefined });
  });
});
