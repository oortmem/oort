import { Agent, MemorySession, run, type AgentInputItem, type Session } from '@openai/agents';
import { createOort, formatForPrompt, type Oort } from 'oortmem';

/** Wraps any `Session`: storage stays where it is, and each user and assistant pair is observed. */
export function oortSession(inner: Session, oort: Oort): Session {
  let pending: string | undefined;
  return {
    getSessionId: () => inner.getSessionId(),
    getItems: (limit) => inner.getItems(limit),
    popItem: () => inner.popItem(),
    clearSession: () => inner.clearSession(),
    async addItems(items) {
      await inner.addItems(items);
      for (const i of items) {
        if (!('role' in i)) continue;
        if (i.role === 'user') pending = textOf(i);
        else if (i.role === 'assistant' && pending !== undefined) {
          await oort.observe({ user: pending, assistant: textOf(i) });
          pending = undefined;
        }
      }
    },
  };
}

function textOf(i: AgentInputItem): string {
  if (!('content' in i)) return '';
  if (typeof i.content === 'string') return i.content;
  return i.content.map((c) => ('text' in c ? c.text : '')).join('');
}

await using root = await createOort();
const oort = root.scoped({ agent: 'support-bot', judgeRole: 'agent' });

// Recall goes through dynamic instructions, never by rewriting the history.
const agent = new Agent<{ question: string }>({
  name: 'support',
  instructions: async (ctx) =>
    `You help customers.\n${formatForPrompt(await oort.recall(ctx.context.question))}`,
});

const question = 'When do we deploy billing?';
const result = await run(agent, question, {
  session: oortSession(new MemorySession(), oort),
  context: { question },
});
console.log(result.finalOutput);
