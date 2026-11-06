import { createOort, formatForPrompt } from 'oortmem';

// What `oort setup` chose on this machine (local by default), with its keys.
await using oort = await createOort();

await oort.observe({ user: 'We deploy on Fridays now.', assistant: 'Noted.' });

// Put this block in your model's system prompt: it is escaped, so a memory cannot break out.
const memory = formatForPrompt(await oort.recall('how do we deploy?'));
console.log(memory);
