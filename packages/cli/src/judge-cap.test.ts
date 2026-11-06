import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';
import {
  AGENT_JUDGMENTS_PER_DAY,
  AgentJudgmentCapError,
  refundAgentJudgment,
  reserveAgentJudgment,
} from './judge-cap.js';
import { MCP_JUDGMENTS_PER_DAY } from './mcp.js';

describe('the shared agent judgment cap (CON-108 §6.3)', () => {
  it("keeps 0.5.x's counter file, so MCP and the SDK count against one cap", async () => {
    expect(MCP_JUDGMENTS_PER_DAY).toBe(AGENT_JUDGMENTS_PER_DAY);
    const home = tmpdir();
    fs.writeFileSync(
      path.join(home, 'judge-mcp-count.json'),
      JSON.stringify({ day: '2026-11-06', count: AGENT_JUDGMENTS_PER_DAY - 1 }),
    );
    await reserveAgentJudgment(home, '2026-11-06');
    const err = await reserveAgentJudgment(home, '2026-11-06').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentJudgmentCapError);
    expect((err as AgentJudgmentCapError).kind).toBe('daily-limit');
    // Another day starts from zero; a refund gives a slot back.
    await reserveAgentJudgment(home, '2026-11-07');
    await refundAgentJudgment(home, '2026-11-06');
    await reserveAgentJudgment(home, '2026-11-07');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'judge-mcp-count.json'), 'utf8'))).toEqual({
      day: '2026-11-07',
      count: 2,
    });
    expect(fs.existsSync(path.join(home, 'judge-mcp-count.lock'))).toBe(false);
  });

  it('never lets concurrent reservations pass the cap', async () => {
    const home = tmpdir();
    const results = await Promise.allSettled(
      Array.from({ length: AGENT_JUDGMENTS_PER_DAY + 5 }, () =>
        reserveAgentJudgment(home, '2026-11-06'),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(AGENT_JUDGMENTS_PER_DAY);
  });

  it('refuses (unavailable) when the counter file is damaged', async () => {
    const home = tmpdir();
    fs.writeFileSync(path.join(home, 'judge-mcp-count.json'), '{not json');
    const err = await reserveAgentJudgment(home, '2026-11-06').catch((e: unknown) => e);
    expect((err as AgentJudgmentCapError).kind).toBe('unavailable');
  });
});
