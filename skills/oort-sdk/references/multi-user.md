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
- **Cloud mode** applies the Oort key's scope: one key is one account, so `user` is a usage error
  there in 0.6.1. Multi-user apps run local mode today. An agent configured as a Star cannot write
  in cloud mode (`star-in-cloud`).
- **Consolidation** runs per scope. The hooks consolidate only the person's own memories, so a
  multi-tenant host calls `consolidate({ budgetMs: 200 })` on each user's handle at the end of a
  session, or from a scheduled job. It calls no model.
- A separate `home` per tenant gives physical separation (files, backups, deletion) when a
  contract needs it.
- The CLI acts as the person: memories written for a `user` are invisible to `oort recall`.
