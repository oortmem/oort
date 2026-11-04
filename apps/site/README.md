# @oortmem/site

Marketing site, console demo and Explorer concept. TanStack Start on Cloudflare Workers.

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

## Analytics

Cloudflare Web Analytics is cookieless. The beacon script is added only when `CF_BEACON_TOKEN` is set
at build time, so dev and tests load nothing:

```sh
CF_BEACON_TOKEN=<token from Cloudflare Web Analytics> pnpm --filter @oortmem/site build
```

## Legal pages

Drafts under `/legal/*`. Fill `{{LEGAL_ENTITY}}`, `{{ADDRESS}}`, `{{CONTACT_EMAIL}}` and
`{{COUNTRY}}` in `src/lib/legal.ts`, then have counsel review before publishing.
