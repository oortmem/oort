import { createOort, formatForPrompt } from 'oortmem';

// One root handle per tenant (`org`), kept in trusted host code: it can reach every user.
const oort = await createOort({
  mode: 'local',
  home: process.env['OORT_HOME'] ?? '/data/oort',
  org: 'acme',
  project: null,
  projectConfig: false,
  keySources: ['env'],
});

// Per request: a handle fixed to one end user. Hand only this one to the model's tools.
const forUser = (userId: string) => oort.scoped({ user: userId, agent: 'support-bot' });

await forUser('user-ada').remember('My order number is 1042.');

const ada = await forUser('user-ada').recall('what is my order number?');
const bob = await forUser('user-bob').recall('what is my order number?');
console.log(formatForPrompt(ada)); // Ada's Planet holds her order number
console.log(bob.memories.length); // 0: each end user has a Planet of their own

// At the end of a user's session (or from a scheduled job): no model call.
await forUser('user-ada').consolidate({ budgetMs: 200 });
await oort.close();
