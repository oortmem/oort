import * as path from 'node:path';
import { generateText, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tmpdir } from '../../../test/helpers.js';
import { fakeAdapters } from '../../../test/helpers/sdk-fakes.js';
import { createOortWith } from '../create.js';
import { oortInstructions, oortObserve, oortTools } from './ai-sdk.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function handle(over: Record<string, unknown> = {}) {
  const root = tmpdir('oort-ai-sdk-');
  return createOortWith(
    {
      mode: 'local',
      home: path.join(root, 'home'),
      cwd: root,
      env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
      ...over,
    },
    { adapters: fakeAdapters(), now: () => new Date('2026-11-05T12:00:00.000Z') },
  );
}

/** A model that calls one tool, then answers in text. */
function toolThenText(toolName: string, input: unknown, text = 'Done.') {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () =>
      step++ === 0
        ? {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'c1',
                toolName,
                input: JSON.stringify(input),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: 'text' as const, text }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage,
            warnings: [],
          },
  });
}

describe('oortmem/ai-sdk (@experimental)', () => {
  it('its tools run inside generateText: remember, then recall through formatForPrompt', async () => {
    const oort = await handle();
    const tools = oortTools(oort);
    // tool() has no runtime behaviour: our objects are already what it returns.
    expect(tool(tools.recall)).toBe(tools.recall);
    await generateText({
      model: toolThenText('remember', { facts: ['We deploy the billing service on Fridays.'] }),
      tools: { ...tools },
      stopWhen: isStepCount(3),
      prompt: 'Remember that we deploy billing on Fridays.',
    });
    const r = await generateText({
      model: toolThenText('recall', { query: 'when do we deploy billing' }),
      tools: { ...tools },
      stopWhen: isStepCount(3),
      prompt: 'When do we deploy billing?',
    });
    const result = r.steps[0]!.toolResults[0]!.output as { memory: string };
    expect(result.memory).toMatch(/^<oort-memory>\n- \[semantic, today\] We deploy the billing/);
    await oort.close();
  });

  it('offers the judgment tools only on request, without the widening options', async () => {
    const oort = await handle();
    expect(Object.keys(oortTools(oort))).toEqual(['recall', 'remember', 'forget']);
    const tools = oortTools(oort, { judge: true });
    expect(Object.keys(tools)).toEqual([
      'recall',
      'remember',
      'forget',
      'judge',
      'record_judgment',
    ]);
    for (const t of Object.values(tools)) {
      const shape = Object.keys((t.inputSchema as z.ZodObject).shape);
      expect(shape).not.toContain('includeAgentRecorded');
      expect(shape).not.toContain('includeImported');
    }
    await oort.close();
  });

  it('acts in the agent role even on an expert handle', async () => {
    const oort = await handle({
      judge: { role: 'expert' },
      config: { judge: { experts: ['ada'] } },
    });
    const tools = oortTools(oort, { judge: true });
    const r = (await tools.record_judgment!.execute({
      subject: 'Post claims a cure',
      verdict: 'rejected',
      reason: 'No source.',
      domain: 'content',
      by: 'ada',
    })) as { status: string; id: string };
    expect(r.status).toBe('agent-recorded');
    const listed = await oort.judge.list();
    expect(listed.judgments[0]).toMatchObject({ id: r.id, via: 'mcp', agentRecorded: true });
    // A refusal comes back as data the model can read, not a thrown stack.
    expect(
      await tools.record_judgment!.execute({
        subject: 's',
        verdict: 'rejected',
        reason: 'r',
        domain: 'content',
        by: 'mallory',
      }),
    ).toEqual({ error: { code: 'refused', message: expect.stringContaining('judge.experts') } });
    await oort.close();
  });

  it('oortObserve saves the turn on onEnd; oortInstructions renders the block', async () => {
    const oort = await handle();
    const onEnd = oortObserve(oort, 'Our staging database runs on port 6543.');
    await generateText({
      model: new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: 'Noted, port 6543.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        }),
      }),
      prompt: 'Our staging database runs on port 6543.',
      onEnd,
    });
    const block = await oortInstructions(oort, 'staging database port');
    expect(block).toContain('staging database runs on port 6543');
    await oort.close();
  });
});
