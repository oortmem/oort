# Errors

Every error is an `OortError` subclass with:

- `code`: the `oort.v1` code, the same the CLI's `--json` uses. Branch on this.
- `reason`: finer and stable, but new reasons may appear in any release.
- `fix`: a runnable `oort …` command, or `null`.
- `retryable`: `true` when trying again can succeed.
- `retryAfter`: seconds, when the service sent `Retry-After`.
- `status`: the HTTP status, for Oort Cloud refusals.

Messages name fields, never values, and never carry a key. A vendor's own error is reported by
its class name only.

| Class                        | `code`               | Typical `reason`                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OortUsageError`             | `usage`              | `invalid-argument`, `principal-required`, `self-not-derivable`, `user-missing`, `bad-user`, `user-hop`, `user-not-supported`, `closed`, `embedder-mismatch`, `bad-request`, `too-large`                                                                                                                      |
| `OortNotFoundError`          | `not-found`          |                                                                                                                                                                                                                                                                                                              |
| `OortAmbiguousIdError`       | `ambiguous-id`       |                                                                                                                                                                                                                                                                                                              |
| `OortNeedsKeyError`          | `needs-key`          | `missing-key`, with `role` and `envVar`                                                                                                                                                                                                                                                                      |
| `OortNeedsLoginError`        | `needs-login`        | `no-key`, `key-rejected`                                                                                                                                                                                                                                                                                     |
| `OortNeedsConfirmationError` | `needs-confirmation` | `preview-required`, `findings-unacknowledged`                                                                                                                                                                                                                                                                |
| `OortCloudOnlyError`         | `cloud-only`         | `hive-level`, `end-users`                                                                                                                                                                                                                                                                                    |
| `OortNetworkError`           | `network`            | `unreachable`, `timeout`, `busy`                                                                                                                                                                                                                                                                             |
| `OortRefusedError`           | `refused`            | `scope-denied`, `star-in-cloud`, `star-with-user`, `local-only`, `experts-not-listed`, `not-an-expert`, `daily-limit`, `expert-only`, `rate-limit`, `migration-required`; per-user memory in Oort Cloud (after 0.7.1): `end-users-unsupported`, `end-users-not-allowed`, `end-user-limit`, `end-user-erased` |
| `OortInternalError`          | `internal`           | `store-busy`                                                                                                                                                                                                                                                                                                 |

What to do:

- `retryable` (`network`, `rate-limit`, `store-busy`): retry with backoff, waiting `retryAfter`
  seconds when set. In cloud mode retry an `observe` with the same `turnRef`.
- `needs-key`, `needs-login`: a deployment problem, not a user problem. Report `fix` to the
  operator (it names `oort models pull`, `oort keys set <vendor>` or `oort login`); do not show a
  key or ask the end user for one. A recall without keys still works, lexical-only.
- `usage`: a bug in the calling code. Do not retry.
- `refused`: a rule said no (a scope, a role, a plan). Do not retry, and do not widen the scope to
  get around it.
- `not-found`: also what an id outside the handle's scope gives, by design.

<!-- example: examples/src/errors.ts -->

```ts
import { createOort, OortError } from 'oortmem';

/** Retries what Oort marks `retryable`, waiting `retryAfter` seconds when the service sent it. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof OortError) || !e.retryable || attempt >= tries) throw e;
      await new Promise((done) => setTimeout(done, (e.retryAfter ?? attempt) * 1000));
    }
  }
}

try {
  await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });
  const r = await withRetry(() =>
    oort.observe({ user: 'Our staging database runs on port 6543.', assistant: 'Noted.' }),
  );
  console.log('saved:', r.outcome);
} catch (e) {
  if (!(e instanceof OortError)) throw e;
  // Branch on `code` first: new `reason` strings may appear in any release.
  switch (e.code) {
    case 'needs-login':
      console.error(`No usable Oort key (${e.reason}). Fix: ${e.fix}`);
      break;
    case 'refused':
      console.error(`Refused (${e.reason}): ${e.message}`);
      break;
    case 'network':
      console.error(`Oort Cloud is unreachable (${e.reason}); try again later.`);
      break;
    default:
      throw e;
  }
}
```

The CLI reports the same codes in its `oort.v1` failure envelope (`error.code`, `error.fix`,
`error.exitCode`); see [cli-and-python.md](cli-and-python.md).
