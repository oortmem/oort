# @oortmem/relay

The Oort Pro relay: a Cloudflare Worker at `https://relay.oortcloud.dev` that lets a paying user run
Oort without their own Voyage, TypeSafe or Anthropic keys. The user holds one Oort key
(`oort_sk_...`). We hold the vendor keys as Worker secrets. Memories stay on the user's machine; the
relay only passes requests through.

```sh
pnpm --filter @oortmem/relay test        # unit tests (fakes, SQLite-backed D1)
pnpm --filter @oortmem/relay typecheck
pnpm --filter @oortmem/relay build       # wrangler deploy --dry-run, bundles to dist/, no login
```

Do not deploy from a worktree.

## Routes

All routes are `POST` and need `Authorization: Bearer oort_sk_...` (`x-api-key: oort_sk_...` is also
accepted, for the Anthropic SDK's default header).

| Route                       | Upstream                                 | Allowed                                                                                                         |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/v1/voyage/embeddings`     | `https://api.voyageai.com/v1/embeddings` | model `voyage-3.5-lite`, at most 128 inputs                                                                     |
| `/v1/voyage/rerank`         | `https://api.voyageai.com/v1/rerank`     | model `rerank-3-lite` (the engine default) or `rerank-2.5-lite` (the earlier lite model), at most 100 documents |
| `/v1/typesafe/v1/systemone` | `https://api.typesafe.ai/v1/systemone`   | only this path (the one `@typesafe-ai/sdk` 0.7.0 calls); JSON or multipart, plain or zstd body                  |
| `/v1/anthropic/v1/messages` | `https://api.anthropic.com/v1/messages`  | model `claude-haiku-5-5`, `max_tokens` 1 to 2048, no `tools`, `tool_choice`, `mcp_servers`                      |

Every body is capped at 256 KB (413 above that). Client base URLs:

- Voyage: `https://relay.oortcloud.dev/v1/voyage` (the adapters in `packages/embed-voyage` and
  `packages/rerank-voyage` hard-code the Voyage URL today, so they need a base URL option).
- TypeSafe: `new TypeSafeClient({ apiKey: oortKey, baseURL: 'https://relay.oortcloud.dev/v1/typesafe' })`.
- Anthropic (AI SDK): `createAnthropic({ authToken: oortKey, baseURL: 'https://relay.oortcloud.dev/v1/anthropic/v1' })`.

## Access, limits and metering

- **Auth.** The relay hashes the key with SHA-256 and looks up `api_keys.hash`. Unknown or revoked
  keys get 401.
- **Entitlement.** The account's `status` must be `active` or `trialing` and its `plan` must have
  limits (`pro`). Otherwise 402 with a link to `https://oortcloud.dev/account`.
- **Rate limit.** 60 requests per 10 s per key (Workers Rate Limiting binding `RATE_LIMITER`, keyed
  by the key hash). 429 with `Retry-After: 10`.
- **Monthly caps.** Pro includes 25,000 saves and 50,000 recalls per calendar month (UTC), the same
  numbers as `rates.managed.Pro` in `apps/site/src/lib/oort-data.ts` (a test keeps them equal). At
  the cap the relay returns 429 with a plain message. There is no overage billing yet.
  - One Anthropic call is one save. Jev calls and document embeddings are part of a save: they are
    not counted, but they stop at the save cap.
  - One embedding call with `input_type: "query"` is one recall. That is the one call every engine
    recall makes, so one recall counts once. Rerank calls are not counted, but they are
    rate-limited, allow-listed and stop at the recall cap.
- **Metering.** Counters live in D1 `usage(account_id, month, saves, recalls)` and are incremented
  with `ctx.waitUntil` after a 2xx upstream response, together with `api_keys.last_used_at`.

## No content, no key leaks

- No `console` call exists in this package. A test spies on every console method across success
  and error paths and asserts none is called.
- Error responses are fixed messages and never echo the request body.
- Upstream response headers are filtered to `content-type` and `retry-after`; request ids, cookies
  and key echoes are dropped. Upstream error bodies are passed through with our keys and the
  top-level `request_id` removed. An upstream 401 or 403 (our key) becomes a plain 502.
- Workers Logs keep invocation logs only (method, path, status, duration) at a 10% head sample.
  Cloudflare redacts header values whose name contains `auth` or `key`, so neither
  `Authorization` nor `x-api-key` is recorded.

## Configuration

`wrangler.jsonc` binds:

| Binding        | What                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `DB`           | D1 `oort-accounts`, shared with `apps/site` (binding `ACCOUNTS_DB` there). Placeholder id. |
| `RATE_LIMITER` | Rate Limiting, namespace `4101`, 60 per 10 s                                               |

Secrets (names only in the config; values never in git):

| Secret              | What                                   |
| ------------------- | -------------------------------------- |
| `VOYAGE_API_KEY`    | Our Voyage AI key (embeddings, rerank) |
| `TYPESAFE_API_KEY`  | Our TypeSafe key (Jev)                 |
| `ANTHROPIC_API_KEY` | Our Anthropic key (Claude Haiku 5.5)   |

Set them once, from `apps/relay` (each command prompts for the value):

```sh
pnpm exec wrangler secret put VOYAGE_API_KEY
pnpm exec wrangler secret put TYPESAFE_API_KEY
pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

For `wrangler dev`, put the same names in `apps/relay/.dev.vars` (git-ignored). See
`.dev.vars.example`.

## Database

Migrations live in `apps/relay/migrations` and are the single schema for `oort-accounts`. The site
points its `ACCOUNTS_DB` binding at the same directory (`../relay/migrations`), and a site test
checks that. Create and migrate it once (remote resources, run on purpose):

```sh
cd apps/relay
pnpm exec wrangler d1 create oort-accounts          # copy database_id into both wrangler.jsonc files
pnpm exec wrangler d1 migrations apply oort-accounts --remote
pnpm exec wrangler d1 migrations apply oort-accounts --local   # for wrangler dev
```

Deploy (attaches `relay.oortcloud.dev` as a custom domain):

```sh
cd apps/relay && pnpm exec wrangler deploy
```
