# Multi-user and multi-tenant apps

A handle's scope is fixed when it is made: no method takes a scope argument. `scoped()` derives a
cheap handle from trusted host code; hand only that handle to the model's tools.

<!-- example: examples/src/multi-user.ts -->

```ts
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
```

## The rules

- **A handle is the whole org.** `scoped()` moves sideways as well as down: from any handle it
  derives any user, project or agent in the same org (only the judge role is one-way). The root
  handle, and an anonymous one, are as powerful as the org itself: keep them in trusted host code
  and never hand them to untrusted code or to a model. Give a model only a handle already scoped
  to one user, through tools that do not expose `scoped` (the `oortmem/ai-sdk` tools never do).
- **`org`** is your tenant: the storage and deletion boundary. **`user`** gives each end user
  their own Planet. The agent is still recorded as the author.
- **`user` needs an explicit `org` other than `'local'`**, and `scoped({ user: 'self' })` is
  refused (`self-not-derivable`).
- **An end user's id** is 1 to 128 characters: a letter or digit first, then letters, digits and
  `_ . : @ -`. It is never trimmed or normalized, and `self`, `anonymous`, `default`, `local`,
  `root` and `count` are reserved, in any case. Anything else is refused before any I/O:
  `user-missing` for `undefined`, `null` or `''`, `self-not-derivable` for `self`, else
  `bad-user`. Map your own ids to this (a hash works). Local mode and Oort Cloud use the same rule.
- **A user handle never switches users.** `scoped({ user })` on a handle already scoped to
  another end user is refused (`user-hop`); the same id, `agent`, `project` and `judgeRole` still
  derive. Make each end user's handle from the handle you made the first one from.
- **An end user gets their Planet only, never a Star.** An agent's Star is kept per org and
  agent, not per user, so it would leak between users. `include: ['star']` on a user handle is
  `refused`, and an agent configured as a Star together with `user` is refused (`star-with-user`).
- **A dropped user id fails loudly.** When the `user` key is present it must hold a user id:
  `scoped({ user: req.user?.id })` with `undefined`, `null` or an empty string throws
  `OortUsageError` (`user-missing`). Only an options object without a `user` key acts as the
  person. Never catch `user-missing` and retry without `user`: that would read the tenant's own
  memory.
- `include` only narrows: a Constellation or Galaxy in local mode is `cloud-only`
  (`hive-level`), any other level the scope lacks is `refused` (`scope-denied`).
- `agent` and `user` are configuration, not authentication. Every process running as the same OS
  user can open the same home. Authenticate your end users yourself, then map the verified id to
  `user`.
- **Cloud mode** applies the Oort key's scope: one key is one account. In 0.7.1 `user` is a usage
  error there and multi-user apps run local mode. Per-user memory in Oort Cloud comes after
  0.7.1, with a server key: see "Per-user memory in Oort Cloud" below.
  An agent configured as a Star cannot write in cloud mode (`star-in-cloud`).
- **Consolidation** runs per scope. The hooks consolidate only the person's own memories, so a
  multi-tenant host calls `consolidate({ budgetMs: 200 })` on each user's handle at the end of a
  session, or from a scheduled job. It calls no model.
- A separate `home` per tenant gives physical separation (files, backups, deletion) when a
  contract needs it.
- The CLI acts as the person: memories written for a `user` are invisible to `oort recall`.

## Per-user memory in Oort Cloud

> **Requires Oort Cloud with server keys (rolling out after 18 Nov 2026)** and an `oortmem`
> newer than 0.7.1. Until the account has it, every end-user call is refused with
> `end-users-unsupported` and nothing is sent. Do not tell a user it is available before then.

The same `scoped({ user })` against Oort Cloud, with a **server key**: an Oort key made on
oortcloud.dev/account with "Acts for end users". Each end user gets a Planet of their own inside
the account; the account's own memory, Stars, Constellations and Galaxies stay out of their reach.

<!-- example: examples/src/cloud-multi-user.ts -->

```ts
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
```

- The client-side rules are the local ones: `user-missing`, `self-not-derivable`,
  `star-with-user`, and `user` needs an explicit `org` other than `'local'`. In cloud mode `org`
  is your name for the key's account and is never sent.
- An end user's handle sends `Oort-User: <id>` on its memory calls; `whoami` and `endUsers` act
  as the account, and a handle without `user` never sends it.
- Before the first request that names an end user, the SDK checks once per root handle that
  `whoami` lists the key's `end-users` capability, and otherwise throws `OortRefusedError`
  (`end-users-unsupported`): an Oort Cloud without per-user memory would ignore the header and
  write the account's own Planet. Never work around this refusal by dropping `user`.
- A server key never acts as the account: its handle without `user` gets `user-missing`. Keep a
  normal key for the account's own memory.
- `oort.endUsers.erase(id)` erases one end user completely (a deletion request) and returns
  counts; `oort.endUsers.count()` returns `{ endUsers, limit }`. Both cloud only, from server
  code, never from a handle scoped to an end user. Python: `oort.end_users.erase(id)` and
  `oort.end_users.count()`.
- Refusals to handle: `end-user-limit` (the plan's end users are all taken; erase ones you no
  longer serve), `end-user-erased` (a write lost the race with an erasure; do not retry),
  `end-users-not-allowed` (not a server key).
