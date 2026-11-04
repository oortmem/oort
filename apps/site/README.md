# @oortmem/site

Marketing site, Oort Pro accounts, console demo and Explorer concept. TanStack Start on Cloudflare
Workers.

```sh
pnpm --filter @oortmem/site dev      # local dev server
pnpm --filter @oortmem/site build    # deployable build in dist/
pnpm --filter @oortmem/site test
```

Do not deploy from a worktree. Nothing here logs in to Cloudflare.

## Waitlist (D1)

`POST /api/waitlist` stores `email`, `created_at` and `source` (home or pricing) in D1. No IP and no
user agent are stored. The per-IP rate limit lives in memory only.

The `DB` binding in `wrangler.jsonc` has a placeholder `database_id`. To create the real database
once (this creates a remote resource, run it on purpose):

```sh
cd apps/site
pnpm exec wrangler d1 create oort-site-waitlist   # copy the printed database_id into wrangler.jsonc
pnpm exec wrangler d1 migrations apply DB --remote
```

For local dev, apply the migration to the local database once:
`pnpm exec wrangler d1 migrations apply DB --local`.

To delete someone on request: `wrangler d1 execute DB --remote --command "DELETE FROM waitlist WHERE email = 'a@b.c'"`.

## Oort Pro accounts

- `/signin` and `/signup`: Clerk (GitHub, Google, email). The console at `/dashboard` is still a
  demo with sample data.
- `/account`: plan and status, Subscribe to Pro (Stripe Checkout, subscription mode, automatic
  tax, billing address required, terms of service consent), Manage billing (Stripe Customer
  Portal), API keys (shown once, listed by prefix, revocable) and this month's saves and recalls.
- `/account/cli?session=<id>`: approves an `oort login` request. It shows a code the CLI can
  match: SHA-256 of `oort-cli-code:<id>`, first 8 hex characters, upper case, as `XXXX-XXXX`.
- `GET /api/cli/session/:id`: polled by `oort login`. 202 `{status:"pending"}` until approved,
  then 200 `{status:"approved", key, prefix}` once with a new key named `CLI on <YYYY-MM-DD>`,
  then 410 `{status:"used"}`. 410 `{status:"expired"}` 10 minutes after the first poll or
  approval. 400 for an id that is not 32 to 128 base64url characters. Only a SHA-256 of the
  session id is stored.
- `POST /api/stripe/webhook`: verified with `constructEventAsync` and SubtleCrypto, idempotent
  through `stripe_events`. Handles `checkout.session.completed`,
  `customer.subscription.created|updated|deleted` and `invoice.payment_failed`, re-reads the live
  subscription from Stripe and sets `accounts.plan` (`pro` while the Pro price is on a live
  subscription) and `accounts.status` (the Stripe status). Pro is usable while the status is
  `active` or `trialing`.

Every account action (`src/server/account.ts`) asks Clerk's server-side `auth()` who is signed in
before it reads or writes anything. Account data lives in the shared D1 database `oort-accounts`
(binding `ACCOUNTS_DB`), whose schema is `apps/relay/migrations`; see `apps/relay/README.md`.

Until `CLERK_SECRET_KEY` is set, Clerk's middleware is not installed and the account pages say
accounts are not set up, so the rest of the site keeps working.

### Environment and secrets

| Name                         | Kind                   | What                                                      |
| ---------------------------- | ---------------------- | --------------------------------------------------------- |
| `VITE_CLERK_PUBLISHABLE_KEY` | build-time env, public | Clerk publishable key (`pk_test_...` or `pk_live_...`)    |
| `CLERK_SECRET_KEY`           | Worker secret          | Clerk secret key (`sk_test_...` or `sk_live_...`)         |
| `STRIPE_SECRET_KEY`          | Worker secret          | Stripe secret key (`sk_test_...` first, live later)       |
| `STRIPE_WEBHOOK_SECRET`      | Worker secret          | Signing secret of the webhook endpoint (`whsec_...`)      |
| `STRIPE_PRICE_PRO`           | Worker secret          | Price id of Oort Pro, $19 a month recurring (`price_...`) |
| `CF_BEACON_TOKEN`            | build-time env         | Cloudflare Web Analytics token (optional, see Analytics)  |

Set the secrets once, from `apps/site` (each command prompts for the value):

```sh
pnpm exec wrangler secret put CLERK_SECRET_KEY
pnpm exec wrangler secret put STRIPE_SECRET_KEY
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
pnpm exec wrangler secret put STRIPE_PRICE_PRO
```

The publishable key is public and is inlined when the site is built:

```sh
VITE_CLERK_PUBLISHABLE_KEY=pk_live_... pnpm --filter @oortmem/site build
```

### Local development

```sh
cd apps/site
cp .dev.vars.example .dev.vars        # git-ignored; holds the dev publishable key and test secrets
pnpm exec wrangler d1 migrations apply ACCOUNTS_DB --local
pnpm dev
```

`vite.config.ts` reads only `VITE_CLERK_PUBLISHABLE_KEY` from `.dev.vars` when it is not set in the
environment. To test the webhook locally with the Stripe CLI:
`stripe listen --forward-to <dev server URL>/api/stripe/webhook` and put the `whsec_...` it prints
into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`.

### Deploy

```sh
VITE_CLERK_PUBLISHABLE_KEY=pk_live_... pnpm --filter @oortmem/site build
cd apps/site && pnpm exec wrangler deploy
```

## Analytics

Cloudflare Web Analytics is cookieless. The beacon script is added only when `CF_BEACON_TOKEN` is set
at build time, so dev and tests load nothing:

```sh
CF_BEACON_TOKEN=<token from Cloudflare Web Analytics> pnpm --filter @oortmem/site build
```

## Legal pages

Drafts under `/legal/*`: privacy, terms of use (the website), Oort Pro terms of service,
acceptable use, cookies and subprocessors. Details live in `src/lib/legal.ts`. Every page shows
the "Draft, under legal review" banner until counsel signs off, and the VAT line stays hidden while
`vatNumber` is null.
