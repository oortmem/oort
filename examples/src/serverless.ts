import { createOort, formatForPrompt } from 'oortmem';

// Module scope: warm invocations reuse the handle and its connection. Cloud mode writes nothing
// to disk and loads no native module.
const oort = await createOort({
  mode: 'cloud',
  keySources: ['explicit', 'env'],
  project: 'support-site',
  projectConfig: false,
});

export async function handler(event: { question: string; requestId: string }): Promise<string> {
  const memory = formatForPrompt(await oort.recall(event.question, { speed: 'fast' }));
  const answer = await answerWith(memory, event.question);
  // Await before returning: the runtime freezes after the response. `turnRef` makes a retried
  // invocation save the turn once.
  await oort.observe({ user: event.question, assistant: answer, turnRef: event.requestId });
  return answer;
}

// A one-shot job (a cron function, a queue consumer) closes its own handle when it ends.
export async function importFacts(facts: string[]): Promise<number> {
  await using job = await createOort({
    mode: 'cloud',
    keySources: ['explicit', 'env'],
    project: 'support-site',
    projectConfig: false,
  });
  const { results } = await job.remember(facts);
  return results.length;
}

/** Your model call goes here. */
async function answerWith(memory: string, question: string): Promise<string> {
  return `(an answer to "${question}", written with ${memory.length} characters of memory)`;
}
