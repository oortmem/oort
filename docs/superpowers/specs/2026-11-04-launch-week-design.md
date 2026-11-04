# Launch week: Oort Pro (no API keys), interactive setup, local connectors, guides

Date: 2026-11-04. Status: approved direction (Marcus chose "Oort Pro: no API keys" and asked for a
highly interactive CLI, easy connectors for Claude and ChatGPT, and clear guides with visuals).
Builds on the Phase 1 engine (PR #1) and the site (PR #2, `apps/site`).

## 1. Intent

Two readers:
- **A solo developer.** Gets memory working in their agent in under two minutes, with one command and no vendor accounts.
- **A paying user.** Pays $19 a month so they never have to deal with Voyage, TypeSafe or Anthropic keys.

Memories stay on the user's machine. Oort Cloud's hosted memory is a later phase.

Success this week:
- `npx oortmem setup` (or `oort setup`) walks a new user from nothing to working memory in Claude Code, Claude Desktop, Codex, Cursor or Gemini CLI.
- A Pro user signs in at oortcloud.dev, pays, and runs `oort login`. Everything then works without other keys.

## 2. Goals, non-goals, anti-goals

Goals:
- G1. **Oort Pro relay.** We hold the vendor keys and the user holds one Oort key.
- G2. **Accounts.** Clerk sign-in, Stripe Checkout and Customer Portal, and key management on the site.
- G3. **`oort setup`.** An interactive wizard, plus `oort mcp` (a local stdio MCP server) and `oort connect <host>`.
- G4. **Guides.** Pages on the site with simple illustrations, one per host plus a "generic MCP client" page and an "any framework" page.

Non-goals this week:
- Hosted memory.
- A remote MCP URL. That is what ChatGPT and claude.ai web/mobile need, so they stay Planned.
- Team billing, SSO, and the hive/Constellation features (CON-58 to CON-68).

Anti-goals:
- The relay must never store, log or inspect prompt or memory content. Usage is counted as numbers only.
- Our keys must never be readable by a client.
- No dark patterns: cancel is one click in the Stripe portal, and the 14-day EU withdrawal right is respected.
- The CLI must never block a non-interactive environment (CI, hooks). Every prompt needs a flag or env alternative, and a non-TTY session never prompts.

## 3. Oort Pro relay (`apps/relay`, Cloudflare Worker at `relay.oortcloud.dev`)

An authenticated, allow-listed reverse proxy. Routes:

| Route | Upstream | Allowed |
| --- | --- | --- |
| `POST /v1/voyage/embeddings` | `https://api.voyageai.com/v1/embeddings` | model `voyage-3.5-lite`, input <= 128 items, body <= 256 KB |
| `POST /v1/voyage/rerank` | `https://api.voyageai.com/v1/rerank` | model `rerank-2.5-lite` (or the current lite rerank), <= 100 documents |
| `POST /v1/typesafe/...` | the TypeSafe API path the Jev adapter calls (read `@oortmem/decide-jev` and the TypeSafe SDK to find it) | only that path |
| `POST /v1/anthropic/v1/messages` | `https://api.anthropic.com/v1/messages` | model `claude-haiku-5-5`, `max_tokens` <= 2048, no tools, body <= 256 KB |

Auth and access:
- **Key format.** `Authorization: Bearer oort_sk_<random>`. D1 stores only the SHA-256 hash, with a key prefix for display.
- **Entitlement.** A key is valid only while its account's subscription status is `active` or `trialing`. Otherwise the relay returns 402 with a link to `https://oortcloud.dev/account`.
- **Rate limits.** Per key, using the Workers Rate Limiting binding: 60 requests per 10 s. Monthly hard caps come from the plan (Pro: 25k saves, 50k recalls; read the exact included amounts from `docs/research/2026-11-04-pricing.md` Structure A and `apps/site/src/lib/oort-data.ts`). At the cap the relay returns 429 with a clear message. Overage billing comes later.
- **Metering.** One Anthropic call counts as one save. One rerank call, or one embedding call with `input_type: "query"`, counts as one recall. Counters live in D1 (`usage(account_id, month, saves, recalls)`), incremented with `ctx.waitUntil`.
- **No content.** No `console.log` of bodies, Workers Logs head sampling for this Worker kept to status and timings only, and no body in any error path. A test asserts that the handler never logs request or response bodies.
- **Header hygiene.** Our vendor keys are Worker secrets (`VOYAGE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`). Upstream response headers are filtered so no upstream request id or key echo leaks.

Shared D1 database `oort-accounts`, bound by both `apps/site` and `apps/relay`:
- `accounts(id, clerk_user_id unique, stripe_customer_id, plan, status, current_period_end, created_at)`
- `api_keys(id, account_id, prefix, hash unique, name, created_at, last_used_at, revoked_at)`
- `usage(account_id, month, saves, recalls, primary key(account_id, month))`
- `stripe_events(id primary key, received_at)` for webhook idempotency

The waitlist stays in its own D1 database.

## 4. Accounts on the site (`apps/site`)

- **Sign-in.** Clerk replaces the demo sign-in. The Clerk application is "Oort" (development instance `ins_3LdPYODE3agLbKY434cidwvVi32`, publishable key in `.dev.vars`/env, never committed as a secret). It offers GitHub, Google and email.
- **`/account`.**
  - Plan and status.
  - "Subscribe to Pro": a Stripe Checkout session in subscription mode with automatic tax and billing address collection.
  - "Manage billing": the Stripe Customer Portal.
  - API keys: create (shown once, with a copy button), list by prefix, revoke.
  - This month's saves and recalls against the plan limits.
- **`POST /api/stripe/webhook`.** Verifies the signature and is idempotent via `stripe_events`. It handles `checkout.session.completed`, `customer.subscription.created|updated|deleted` and `invoice.payment_failed`, and updates `accounts.status` and `plan`.
- **Secrets.** `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_PRO` are Worker secrets.
- **Stripe account.** A new Oort account, in test mode first. Marcus creates it in the Stripe dashboard. Until then the code runs against test-mode env vars and placeholders.
- **CLI sign-in (`/account/cli`).** The page shows a one-time code flow. `oort login` opens `https://oortcloud.dev/account/cli?session=<random>` and polls `GET /api/cli/session/<random>` until the signed-in user approves. A new API key is then minted for the CLI and handed over once. It expires after 10 minutes, and the session id is single use.

## 5. CLI (`packages/cli`)

- **`oort setup`.** An interactive wizard built with `@clack/prompts` (or an equally small library), with colour, spinners and the tier glyphs. Steps:
  1. **Detect agents.** Finds Claude Code (`~/.claude`), Claude Desktop (its config file per OS), Codex (`~/.codex/config.toml`), Cursor (`~/.cursor/mcp.json`) and Gemini CLI (`~/.gemini/settings.json`).
  2. **Choose keys.** "Oort Pro (no keys, $19/month)" runs `oort login`. "Bring my own keys" runs `oort keys set` for each provider and shows where to get each key.
  3. **Connect.** Hooks for Claude Code, and the MCP server for the others.
  4. **Offer an import.** Runs `oort import` with its estimate.
  5. **Demo.** A remember-then-recall check that shows it works.
  6. **Finish.** A summary of what changed and how to undo it.

  Rules:
  - Every step is skippable.
  - `--yes` with flags reproduces any path non-interactively.
  - Non-TTY input never prompts.
  - `NO_COLOR` is respected.
- **`oort mcp`.** A stdio MCP server built with the official TypeScript SDK. Tools follow connectors note D2: `recall` (read-only), `remember` (1 to 5 distilled facts, never transcripts), `forget` (destructive), `pin`, `explain`, `list_recent` and `whoami`, with correct read/write/destructive annotations. Server instructions stay short: recall before answering about past work, remember decisions and preferences. Scope comes from the MCP client's working directory where the host provides it, otherwise global, and every project-id rule from Phase 1 applies.
- **`oort connect <host>` / `oort disconnect <host>`.** Writes or removes the MCP entry for `claude-desktop`, `claude-code` (MCP in addition to hooks), `codex`, `cursor`, `gemini` and `vscode`. Each run backs up the config file first, prints the diff, and is idempotent.
- **`oort login` / `oort logout`.** Runs the flow in section 4 and stores the key as Keychain item `oort.oort` (CON-55 mechanism). The `oort` provider then routes embed, rerank, decide and write through the relay, and is used when an Oort key exists and no vendor key is set. A vendor key always wins if present.
- **`oort doctor`.** Checks keys (presence only), hooks, connectors, store health and relay reachability, with a fix suggestion per failure.
- **Output.** Every command gains a consistent look (one header line, aligned key/value output, coloured tiers) and `--json` where output is data.

## 6. Guides (`apps/site`, `/docs`)

Pages, each with a numbered "do this" path, copyable commands, and one simple SVG illustration (in the site's theme, inline, light and dark):
- Quickstart (Claude Code)
- Claude Desktop
- Codex
- Cursor
- Gemini CLI
- Any MCP client: stdio config snippet
- Any agent framework: Vercel AI SDK, LangGraph, OpenAI Agents SDK and Mastra, each through MCP or the `oort` CLI, plus "your own code" through `oort recall/observe --json`
- Oort Pro
- Bring your own keys
- Privacy: what leaves your machine
- Troubleshooting: `oort doctor`

ChatGPT and claude.ai web/mobile get a "Planned: needs Oort Cloud" page explaining why (remote MCP) and linking to the waitlist.

## 7. Legal

- **Terms of Service for Oort Pro.** A subscription, cancel anytime, and the EU consumer 14-day withdrawal: the user consents to immediate start and acknowledges losing the right once service begins, with a pro-rata refund on request within 14 days as our policy.
- **Privacy update.** The relay processes content transiently and stores none. Account data lives with Clerk, Stripe and Cloudflare D1. Subprocessors are Cloudflare, Clerk, Stripe, Voyage AI, TypeSafe and Anthropic.
- **Drafts.** Every page keeps the "Draft, under legal review" banner until counsel signs off.
- **Not yet published.** The VAT number and postcode, until Marcus confirms them.

## 8. Order of work

1. CLI UX track (sections 5 except login and the provider, plus 6's command reference), on branch `cli-ux`.
2. Pro backend track (sections 3, 4 and 7) on `site`, in apps only, in parallel with step 1.
3. `oort login`, the `oort` provider and `oort doctor`'s relay check, after steps 1 and 2.
4. Guides, after step 1's command names are final.
5. Review, then deploys, which Marcus runs.
