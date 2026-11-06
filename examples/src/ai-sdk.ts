import { generateText, isStepCount } from 'ai';
import { createOort } from 'oortmem';
import { oortInstructions, oortObserve, oortTools } from 'oortmem/ai-sdk';

await using oort = await createOort();

const prompt = 'When do we deploy billing?';
const { text } = await generateText({
  model: 'anthropic/claude-sonnet-5.5', // any AI SDK model; a string goes through the AI Gateway
  instructions: await oortInstructions(oort, prompt), // `system` before AI SDK 7
  tools: oortTools(oort), // recall, remember, forget; { judge: true } adds judge and record_judgment
  stopWhen: isStepCount(5),
  prompt,
  onEnd: oortObserve(oort, prompt), // `onFinish` before AI SDK 7
});
console.log(text);
