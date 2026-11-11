import { createOort, formatForPrompt } from 'oortmem';

// Oort Cloud with a server key ("Acts for end users", made on oortcloud.dev/account) in
// OORT_API_KEY. An Oort Cloud without per-user memory refuses end users (end-users-unsupported).
const oort = await createOort({
  mode: 'cloud',
  org: 'acme',
  project: null,
  projectConfig: false,
  keySources: ['env'],
});

// Per request: a handle fixed to one end user (it sends Oort-User). Hand only this one to tools.
// Take userId from your own signed-in session, never from the request: the key reads every end user.
const forUser = (userId: string) => oort.scoped({ user: userId, agent: 'support-bot' });

await forUser('user-ada').remember('My order number is 1042.');

console.log(formatForPrompt(await forUser('user-ada').recall('what is my order number?')));
console.log((await forUser('user-bob').recall('what is my order number?')).memories.length); // 0

// The account's end users: how many, and erasing one (a deletion request). Server code only.
const { endUsers, limit } = await oort.endUsers.count();
console.log(`${endUsers} of ${limit} end users`);
const erased = await oort.endUsers.erase('user-ada');
console.log(`erased ${erased.memories} memories`);
await oort.close();
