import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';
import {
  AGENT_JUDGMENTS_PER_DAY,
  AgentJudgmentCapError,
  refundAgentJudgment,
  removeLockIfSame,
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

  it('a stale-lock takeover never deletes the fresh lock that replaced it', () => {
    const home = tmpdir();
    const lock = path.join(home, 'judge-mcp-count.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const seen = fs.statSync(lock);
    // Another waiter took the stale lock over first and now holds a fresh one.
    fs.rmSync(lock);
    fs.writeFileSync(lock, 'fresh');
    const fresh = fs.statSync(lock);
    expect(removeLockIfSame(lock, seen)).toBe(false);
    expect(fs.statSync(lock).ino).toBe(fresh.ino);
    expect(fs.readdirSync(home)).toEqual(['judge-mcp-count.lock']);
    // The lock it really saw goes.
    expect(removeLockIfSame(lock, fresh)).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('takes over a lock a crashed process left behind', async () => {
    const home = tmpdir();
    const lock = path.join(home, 'judge-mcp-count.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await reserveAgentJudgment(home, '2026-11-06');
    expect(fs.readdirSync(home)).toEqual(['judge-mcp-count.json']);
  });

  it('two real processes contending, past a stale lock, never pass the cap together', async () => {
    const home = tmpdir();
    const lock = path.join(home, 'judge-mcp-count.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    fs.writeFileSync(
      path.join(home, 'judge-mcp-count.json'),
      JSON.stringify({ day: '2026-11-06', count: AGENT_JUDGMENTS_PER_DAY - 30 }),
    );
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/judge-cap.js');
    const script = `const { reserveAgentJudgment } = await import(${JSON.stringify(dist)});
let ok = 0;
for (let i = 0; i < 25; i++) { try { await reserveAgentJudgment(process.argv[1], '2026-11-06'); ok++; } catch {} }
console.log(ok);`;
    const runOne = (): Promise<number> =>
      new Promise((resolve, reject) =>
        execFile(
          process.execPath,
          ['--input-type=module', '-e', script, home],
          { timeout: 60_000 },
          (e, stdout) => (e === null ? resolve(Number(stdout.trim())) : reject(e)),
        ),
      );
    const counts = await Promise.all([runOne(), runOne()]);
    expect(counts[0]! + counts[1]!).toBe(30);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'judge-mcp-count.json'), 'utf8'))).toEqual({
      day: '2026-11-06',
      count: AGENT_JUDGMENTS_PER_DAY,
    });
    expect(fs.readdirSync(home)).toEqual(['judge-mcp-count.json']);
  }, 90_000);
});
