import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@oortmem/core';
import { tmpdir } from '../test/helpers.js';
import { promptRecallConfig, promptReranker } from './commands/hook.js';

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

// CON-131: `recall.promptGateMissRerank` keeps a hosted reranker for the prompt hook in `fast`
// mode, called only when the relevance gate would drop everything. The local reranker is
// English-only and slow to load, so it never runs in the hook.
describe('the prompt hook gate-miss rerank', () => {
  const base = () => resolveConfig(tmpdir(), { OORT_HOME: tmpdir() });
  const tune = (
    c: ReturnType<typeof base>,
    promptMode: 'full' | 'fast' | 'lexical',
    promptGateMissRerank: boolean,
    provider = c.rerank.provider,
  ) => ({
    ...c,
    rerank: { ...c.rerank, provider },
    recall: { ...c.recall, promptMode, promptGateMissRerank },
  });

  it('off by default: fast mode drops the reranker, as before', () => {
    const c = base();
    expect(promptReranker(c)).toBe(false);
    expect(promptRecallConfig(c).recall.rerankWhen).toBe('always');
  });

  it('on, in fast mode with a hosted reranker: kept, and called on a gate miss only', () => {
    const c = tune(base(), 'fast', true);
    expect(promptReranker(c)).toBe(true);
    expect(promptRecallConfig(c).recall.rerankWhen).toBe('gate-miss');
  });

  it('never with the local reranker, and never in lexical mode', () => {
    const local = tune(base(), 'fast', true, 'local');
    expect(promptReranker(local)).toBe(false);
    const lexical = tune(base(), 'lexical', true);
    expect(promptReranker(lexical)).toBe(false);
    expect(promptRecallConfig(lexical).recall.rerankWhen).toBe('always');
  });

  it('full mode reranks every prompt, as before', () => {
    const c = tune(base(), 'full', true);
    expect(promptReranker(c)).toBe(true);
    expect(promptRecallConfig(c).recall.rerankWhen).toBe('always');
  });
});
