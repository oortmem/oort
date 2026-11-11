# Services, serverless and self-hosting

Oort is open source (Apache 2.0): the engine runs inside your own process in local mode, on your
own infrastructure, with your own model keys. Oort Cloud is the hosted option (cloud mode). Both
take the same code.

## A long-running service (self-hosted)

ECS, GKE, EKS, a VM: embed the SDK in local mode with the store on a block volume.

- **One replica per store**, because SQLite needs one host. Scale by tenant (a `home` per tenant
  or group of tenants), not by adding replicas in front of one store.
- **Never put the store on a network filesystem** (EFS, NFS, GCS FUSE).
- Pass everything explicitly: `mode: 'local'`, `home`, `org`, `project` (or `null`),
  `projectConfig: false` and `keySources: ['env']`, with the model keys (`VOYAGE_API_KEY`,
  `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, or `OORT_API_KEY` for the Oort Pro relay) injected from
  your secret manager. The multi-user example in [multi-user.md](multi-user.md) is this shape.
- Create the root handle once at start-up, derive `scoped()` handles per request, `close()` on
  shutdown.
- Call `consolidate({ budgetMs: 200 })` per user at the end of a session or from a scheduled job:
  the hooks only consolidate the person's own memories.
- `oort doctor --json`, run with the service's `OORT_HOME` and environment, checks the keys, the
  store and its permissions. It never writes.

## Serverless (Lambda, Cloud Functions, Cloud Run)

Use cloud mode:

- **No disk writes, no native module.** `mode: 'cloud'` reads `OORT_HOME` only if files exist
  there, and never creates the directory, a store, a log or a cache. `@oortmem/store-sqlite` (and
  with it `better-sqlite3`) is imported only by local mode, so mark `@oortmem/store-sqlite`,
  `better-sqlite3` and `sqlite-vec` as external when you bundle.
- **Keys** from the environment: `keySources: ['explicit', 'env']`, or `OORT_NO_KEYCHAIN=1`.
  There is no Keychain in Lambda.
- **A checkout as the working directory** (a monorepo deploy): pass `projectConfig: false`.
- **Create the handle at module scope**, so warm invocations reuse its connection. The pool's
  sockets do not keep the process alive, so a function that never calls `close()` still ends.
- **Await `observe` before returning**: the runtime freezes after the response. A `turnRef` (the
  request id) makes a retried invocation save the turn once.
- **A multi-user app in cloud mode** needs per-user memory in Oort Cloud: a server key and
  `scoped({ user })`. It requires Oort Pro and `oortmem` 0.8.0 or newer. See
  [multi-user.md](multi-user.md#per-user-memory-in-oort-cloud).

<!-- example: examples/src/serverless.ts -->

```ts
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
```

## Choosing

| Need                                                     | Mode                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Several end users per tenant (`scoped({ user })`)        | `local` (cloud mode takes no `user` in 0.7.3)                                                 |
| Serverless, no disk, no native build                     | `cloud`                                                                                       |
| The store on your own hardware                           | `local` (saving still sends each turn to TypeSafe and Anthropic, with your keys or the relay) |
| One person's memory shared with their CLI, hooks and MCP | `auto` on their machine                                                                       |
| Judgments                                                | `local` (cloud mode refuses `judge.*`)                                                        |
