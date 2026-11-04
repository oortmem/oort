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

| Route                       | Upstream                                 | Allowed                                                                                                                                                      |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/voyage/embeddings`     | `https://api.voyageai.com/v1/embeddings` | model `voyage-3.5-lite`, at most 128 inputs, `input_type` `query` or `document` (required)                                                                   |
| `/v1/voyage/rerank`         | `https://api.voyageai.com/v1/rerank`     | model `rerank-3-lite` (the engine default) or `rerank-2.5-lite` (the earlier lite model), at most 100 documents                                              |
| `/v1/typesafe/v1/systemone` | `https://api.typesafe.ai/v1/systemone`   | only this path (the one `@typesafe-ai/sdk` 0.7.0 calls); `{state, questions, model}` with model `jev-latest`, 1 to 32 noul, score or choice questions, 64 KB |
| `/v1/anthropic/v1/messages` | `https://api.anthropic.com/v1/messages`  | model `claude-haiku-5-5`, `max_tokens` 1 to 2048, text-only content, top-level fields from an allowlist                                                      |

Every body must be uncompressed `application/json` and is capped at 256 KB (128 KB for Anthropic, 64 KB for Jev;
413 above that). Fields have caps too, also 413 with no upstream call and no metering: a rerank
`query` 2 KB, a rerank document 4 KB (at most 100 documents), an embedding input 8 KB. Unknown top-level fields are refused with 400 on every route. The Anthropic allowlist is
`model`, `max_tokens`, `messages`, `system`, `stop_sequences`, `metadata` (`user_id` only),
`stream`, `thinking` and `output_config` (`format` as a JSON schema, `effort`); message and system
content may only be strings or `{type: "text", text}` blocks, so no URL documents or images, and no
`cache_control`. What goes upstream is the checked object, re-serialised, never the caller's bytes.

Client base URLs:

- Voyage: `https://relay.oortcloud.dev/v1/voyage`.
- TypeSafe: `new TypeSafeClient({ apiKey: oortKey, baseURL: 'https://relay.oortcloud.dev/v1/typesafe', compression: false, defaultModel: 'jev-latest' })`
  (what `@oortmem/decide-jev` does in relay mode).
- Anthropic (AI SDK): `createAnthropic({ authToken: oortKey, baseURL: 'https://relay.oortcloud.dev/v1/anthropic/v1' })`.

## Access, limits and metering

- **Auth.** A key must have the exact shape the site mints (`oort_sk_` plus 43 base64url
  characters); anything else is 401 before any limiter or database work. The relay hashes the key
  with SHA-256 and looks up `api_keys.hash`. Unknown or revoked keys get 401, and count against the
  caller's IP (`AUTH_LIMITER`, 20 a minute): past that, 429.
- **Entitlement.** The account's `status` must be `active` or `trialing`, its `plan` must have
  limits (`pro`), and `current_period_end` must be less than 3 days ago (a grace for a late
  renewal webhook). Otherwise 402 with a link to `https://oortcloud.dev/account`.
- **Rate limit.** 60 requests per 10 s per key and again per account across all its keys
  (`RATE_LIMITER`, keyed by the key hash and by `account:<id>`). 429 with `Retry-After: 10` and
  `reason` `rate limit: key` or `rate limit: account`. The simple limiter counts per Cloudflare
  location, so it is a speed bump; the monthly caps are the budget.
- **Monthly caps**, per account per calendar month (UTC), in D1 `usage`:

  | Counter        | Cap     | Counted                                           | Also stops at                         |
  | -------------- | ------- | ------------------------------------------------- | ------------------------------------- |
  | `saves`        | 25,000  | one per Anthropic call                            |                                       |
  | `recalls`      | 50,000  | one per embedding call with `input_type: "query"` |                                       |
  | `embed_inputs` | 200,000 | every embedding input, query or document          | the save cap, for document embeddings |
  | `rerank_calls` | 60,000  | one per rerank call                               | the recall cap                        |
  | `decide_calls` | 150,000 | one per Jev call (the gate runs one every turn)   | the save cap                          |

  `saves` and `recalls` are the user-facing units and equal `rates.managed.Pro` in
  `apps/site/src/lib/oort-data.ts` (a test keeps them equal). At a cap the relay returns 429 with
  a plain message and `reason`, for example `monthly cap: recalls`. There is no overage billing yet.

- **Metering.** Capacity is reserved before the call with one conditional upsert (`... DO UPDATE
... WHERE usage.saves + 1 <= 25000 AND ...`), so concurrent calls cannot pass a cap. The
  reservation is refunded (in `ctx.waitUntil`) when the provider did no work: a network failure, a
  401 or 403 (our key), a 429 or a 5xx. When the client disconnected first (the request's signal
  is aborted), the reservation is kept, because the provider may have done the work.
  `api_keys.last_used_at` is updated at the same time.

## No content, no key leaks

- No `console` call exists in the handler. A test spies on every console method across success
  and error paths and asserts none is called. The Worker entry logs one line per request with the
  status and duration only.
- Error responses are fixed messages and never echo the request body or an upstream body (which
  can name our organisation, its limits or ids). An upstream 401 or 403 (our key) becomes a plain
  502; an upstream 429 or 5xx becomes 503 `Oort Pro is busy, try again shortly.` with only the
  upstream `Retry-After`; another upstream 4xx becomes `The provider rejected this request (HTTP
4xx).`
- Upstream response headers are filtered to `content-type` and `retry-after`; request ids, cookies
  and key echoes are dropped.
- Workers Logs: invocation logs are off (`observability.logs.invocation_logs: false`), so
  Cloudflare does not store request URLs, headers or the `cf` object for this Worker. Only the
  status-and-duration line above is kept, at a 10% head sample.

## Configuration

`wrangler.jsonc` binds:

| Binding        | What                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `DB`           | D1 `oort-accounts`, shared with `apps/site` (binding `ACCOUNTS_DB` there). Placeholder id. |
| `RATE_LIMITER` | Rate Limiting, namespace `4101`, 60 per 10 s (per key and per account)                     |
| `AUTH_LIMITER` | Rate Limiting, namespace `4102`, 20 per 60 s (failed sign-ins per IP)                      |

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
