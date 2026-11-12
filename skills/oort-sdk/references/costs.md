# Which calls cost usage

No model is called at construction, by `whoami`, or by any read of stored records. "Vendor"
below means your own key (billed by that vendor) or the Oort key through the Oort Pro relay
(metered on your Oort account); `whoami().routes` says which applies to each role.

| Call                                                                                                  | Local, own keys or Oort Pro relay                                                                                                                                              | Local models                               | Cloud mode                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------- |
| `recall`                                                                                              | A Voyage embed (skipped on a cache hit or a confident keyword answer) and a Voyage rerank (skipped when confident, or with `speed: 'fast'`). `speed: 'lexical'`: no model call | none                                       | Metered Oort Cloud recall    |
| `observe`                                                                                             | A TypeSafe gate, always. If kept: one Anthropic writer call, one batched Voyage embed, and a TypeSafe reconcile per fact                                                       | Gate, writer and reconcile still need keys | Metered Oort Cloud observe   |
| `remember`                                                                                            | One observe per fact                                                                                                                                                           | as above                                   | One metered observe per fact |
| `judge.record`                                                                                        | One Voyage embed                                                                                                                                                               | none                                       | `refused`                    |
| `judge.apply`                                                                                         | One Voyage embed and one TypeSafe judge call                                                                                                                                   | TypeSafe judge only                        | `refused`                    |
| `forget`, `pin`, `unpin`, `explain`, `recent`, `judge.list`, `judge.confirm`, `consolidate`, `whoami` | none                                                                                                                                                                           | none                                       | No model call                |

Ways to spend less:

- `observe` is the expensive call. Observe real conversation turns, once each; do not observe
  tool chatter or retries (in cloud mode a `turnRef` deduplicates a retry).
- `remember(facts)` costs one observe per fact: batch the facts of one decision into one call (at
  most five), and do not use it to replay a transcript.
- `recall(query, { speed: 'fast' })` skips the rerank; `speed: 'lexical'` makes no model call.
- `recall.adaptiveStop: 'decide'` (0.9.0 or newer) adds one TypeSafe call to a `full` recall that
  finds archived matches; the default, `rule`, decides in code.
- `oort models pull` (with `@oortmem/local-models` installed) runs embed and rerank on the CPU
  with no key; deciding and writing still need TypeSafe and Anthropic keys, or Oort Pro.
- `keySources: ['explicit']` turns off every implicit source, the relay included unless you pass
  `keys.oort`, so nothing is billed to a key you did not pass.

Oort Pro is a subscription (see https://oortcloud.dev/pricing); the relay and Oort Cloud meter
usage on that account.
