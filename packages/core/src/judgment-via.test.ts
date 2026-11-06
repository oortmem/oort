import { describe, expect, it } from 'vitest';
import { isAgentVia, isUnconfirmedAgentJudgment, type JudgmentVia } from './judgment.js';

describe('isAgentVia', () => {
  it('is the one definition of agent-recorded: mcp only, with no new via value', () => {
    const all: JudgmentVia[] = ['cli', 'mcp', 'import', 'pack', 'sdk'];
    expect(all.filter(isAgentVia)).toEqual(['mcp']);
  });

  it('decides isUnconfirmedAgentJudgment (an expert-role SDK record is a person’s)', () => {
    expect(isUnconfirmedAgentJudgment({ via: 'mcp' })).toBe(true);
    expect(isUnconfirmedAgentJudgment({ via: 'mcp', confirmed: { at: 'x', by: 'p' } })).toBe(false);
    expect(isUnconfirmedAgentJudgment({ via: 'sdk' })).toBe(false);
    expect(isUnconfirmedAgentJudgment({ via: 'cli' })).toBe(false);
  });
});
