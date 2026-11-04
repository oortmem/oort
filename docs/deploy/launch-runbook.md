# Oort Pro launch runbook

Copied from the backend build report on 2026-11-04. It holds commands and settings only, never secret values. Run the steps in order.


**Before anything else:** set monthly spend limits and alerts on the Voyage AI, Anthropic and TypeSafe accounts, and turn on Stripe's one-subscription-per-customer setting. They are the last line of defence on vendor cost (see §7). `oort login` and the CLI `oort` provider have shipped, so the earlier hold is lifted.

Run from the main checkout after `site` is merged, never from a worktree. Test mode first. Each
`wrangler secret put` prompts for the value.

## 1. D1 `oort-accounts`

```sh
cd ~/repos/oort && pnpm install && pnpm verify
cd apps/relay
pnpm exec wrangler d1 create oort-accounts
# Paste the printed database_id into BOTH files, replacing 00000000-0000-0000-0000-000000000000:
#   apps/relay/wrangler.jsonc  (d1_databases[binding=DB])
#   apps/site/wrangler.jsonc   (d1_databases[binding=ACCOUNTS_DB])
pnpm exec wrangler d1 migrations apply oort-accounts --remote
pnpm exec wrangler d1 execute oort-accounts --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Commit the id change (it is not a secret).

## 2. Relay secrets, deploy and custom domain

```sh
cd ~/repos/oort/apps/relay
pnpm exec wrangler secret put VOYAGE_API_KEY
pnpm exec wrangler secret put TYPESAFE_API_KEY
pnpm exec wrangler secret put ANTHROPIC_API_KEY
pnpm exec wrangler deploy
# The route { pattern: "relay.oortcloud.dev", custom_domain: true } attaches the domain on deploy;
# the oortcloud.dev zone must be on the same Cloudflare account.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://relay.oortcloud.dev/v1/voyage/embeddings   # expect 401
```

## 3. Stripe (new "Oort" account, test mode)

1. Dashboard, Settings, Public details: Terms of service URL
   `https://oortcloud.dev/legal/terms-of-service`, Privacy policy URL
   `https://oortcloud.dev/legal/privacy`. Checkout's required terms consent fails without the
   terms URL.
2. Settings, Tax: head office address in Sweden, turn on Stripe Tax, add the Sweden registration
   (and EU OSS when it applies). Use a SaaS product tax code.
3. Product and price (Stripe CLI shown; the dashboard works too):

   ```sh
   stripe products create --name "Oort Pro" -d "description=Oort Pro: no API keys needed; your memories stay on your machine"
   stripe prices create --product prod_REPLACE --currency usd --unit-amount 1900 \
     -d "recurring[interval]=month" -d "tax_behavior=inclusive"
   ```

   The `price_...` id is `STRIPE_PRICE_PRO`. The price is tax-inclusive: the site and terms say
   "$19/month, VAT included where applicable". Currency is USD until counsel answers USD vs EUR.
4. Settings, Billing, Customer portal: allow cancel (at end of billing period), update payment
   method, update billing address and tax id, invoice history. Save (the code uses the default
   configuration).
5. Webhook endpoint:

   ```sh
   stripe webhook_endpoints create --url https://oortcloud.dev/api/stripe/webhook \
     -d "enabled_events[]=checkout.session.completed" \
     -d "enabled_events[]=customer.subscription.created" \
     -d "enabled_events[]=customer.subscription.updated" \
     -d "enabled_events[]=customer.subscription.deleted" \
     -d "enabled_events[]=invoice.payment_failed"
   ```

   The response's `secret` (`whsec_...`) is `STRIPE_WEBHOOK_SECRET`.

## 4. Clerk

Development instance "Oort" works with the committed dev publishable key. For production: create
the production instance for `oortcloud.dev`, add the DNS records Clerk lists, set up GitHub and
Google OAuth apps for production, keep email on, and set the component paths to `/signin` and
`/signup`. That gives `pk_live_...` and `sk_live_...`.

## 5. Site secrets, build and deploy

```sh
cd ~/repos/oort/apps/site
pnpm exec wrangler secret put CLERK_SECRET_KEY
pnpm exec wrangler secret put STRIPE_SECRET_KEY
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
pnpm exec wrangler secret put STRIPE_PRICE_PRO
cd ~/repos/oort
VITE_CLERK_PUBLISHABLE_KEY=pk_test_or_live_REPLACE CF_BEACON_TOKEN=REPLACE_OR_OMIT pnpm --filter @oortmem/site build
cd apps/site && pnpm exec wrangler deploy
```

## 6. Smoke test (test mode)

1. Sign in at `https://oortcloud.dev/signin`, open Pricing, Get Pro, pay with `4242 4242 4242 4242`.
2. Stripe dashboard, Webhooks: deliveries return 200. `/account` shows Oort Pro, Active.
3. Create a key on `/account`, then:

   ```sh
   curl -s https://relay.oortcloud.dev/v1/voyage/embeddings \
     -H "Authorization: Bearer $OORT_KEY" -H 'content-type: application/json' \
     -d '{"model":"voyage-3.5-lite","input":["hello"],"input_type":"query","output_dimension":512,"output_dtype":"int8"}' | head -c 120
   cd ~/repos/oort/apps/relay && pnpm exec wrangler d1 execute oort-accounts --remote --command "SELECT month, saves, recalls, embed_inputs, rerank_calls, decide_calls FROM usage"
   ```

4. Cancel in Manage billing (at period end) and check the webhook leaves the account Active until
   the period ends, then Canceled.
5. `oort login` (added by the review fix wave): the terminal prints a code like `BCDF-GHJK` and
   opens `https://oortcloud.dev/account/cli` with nothing after `/cli`. Type the code; the page
   shows the start time, country, OS and host. Approve; the terminal stores the key. Then:
   `pnpm exec wrangler d1 execute oort-accounts --remote --command "SELECT user_code, country, client_os FROM cli_sessions"`
   shows the row, and an hour later (after the relay's `17 * * * *` cron) it is gone.

## 7. After the independent security review (2026-11-04)

The review fix wave (`.superpowers/review-fix-report.md`) adds migrations 0003 and 0004, two rate
limit namespaces on the relay (`4101`, `4102`) and one on the site (`4103`), and an hourly cron on
the relay. A later pass adds a second site namespace, `4104` (`CODE_ATTEMPT_LIMITER`, typed
`oort login` codes: 10 a minute per account and 10 a minute per IP, so a shared office IP can
trip it; the IP is only the counter's key). `wrangler d1 migrations apply oort-accounts --remote` in step 1 applies the new
migrations; the deploys in steps 2 and 5 create the limiters and the cron. Make sure namespace ids
4101 to 4104 are not used by another Worker on the account. Then, before taking real payments:

1. **Customer Portal: cancel at period end.** Settings, Billing, Customer portal, Cancellations:
   allow cancel, mode "At the end of the billing period" (not immediately), no proration. Terms §5
   promises Pro until the period ends, and the relay's 3-day grace after `current_period_end`
   assumes it.
2. **Refund-then-cancel, for a 14-day withdrawal or any refund.** Refunds and disputes do not
   change entitlement by themselves (review M7). In the Stripe dashboard:
   1. Customers, find the customer, open the subscription, Cancel subscription, "Immediately"
      (with "Refund last payment" off; the refund is the next step, so the amount is exact).
   2. Payments, the latest invoice payment, Refund: the unused part, pro rata to the day, or all
      of it within 14 days of the start if nothing was used.
   3. Check the webhook delivered `customer.subscription.deleted` with 200 and that `/account`
      shows the account as Canceled; the relay refuses its keys from then on.
   4. For a dispute (`charge.dispute.created` in the dashboard): cancel immediately as in 1, then
      answer the dispute. The webhook does not subscribe to dispute events yet; consider adding
      `charge.dispute.created` and a handler that cancels.
3. **Vendor spend limits and alerts.** The relay's monthly caps are per account; nothing caps the
   total. Set, per vendor account that holds the relay's key:
   (Menu names are from memory; use whatever each dashboard calls them.)
   - Voyage AI (dashboard, billing settings): a monthly usage limit and an email alert at
     50% and 80% of it. Size it from accounts times the per-account caps (200k embedding inputs and
     60k rerank calls a month at most each).
   - Anthropic (Console, limits settings): a monthly spend limit on the workspace the key belongs
     to, and the usage notification email. Put the relay's key in its own workspace so the limit
     only covers Oort Pro.
   - TypeSafe (dashboard, Billing): a spend cap or alert, as its dashboard offers; if it has none,
     ask TypeSafe for one and watch usage weekly until it exists.
   Note that hitting a vendor limit makes every Pro call answer 503 "Oort Pro is busy" (the relay
   maps the vendor's 429 to that), which is the intended failure.
4. **Vendor retention and training settings (review M11).** The privacy notice (`What leaves your
   machine`) and `/legal/subprocessors` say each provider processes requests "to answer them,
   under its own API terms", and the subprocessor page says "in transit". Confirm, for the account
   that holds each relay key:
   - Voyage AI: whether API inputs are retained, for how long, and whether they may be used for
     training; opt out of training if the account offers it.
   - Anthropic: whether API inputs may be used for training under the account's terms, how long
     the workspace retains inputs and outputs, and whether to ask for zero data retention.
   - TypeSafe: its API data retention and training terms.
   If any provider keeps inputs beyond answering the request, or may train on them, change the
   subprocessor wording from "in transit" to say so (for example "kept by the provider for up to
   N days for abuse monitoring, never used for training"), and the privacy notice to match,
   before the first paying user. I did not check any vendor's settings or terms.
5. **Stripe: one subscription per customer.** Checkout now refuses while any subscription has not
   ended and sends the user to the Portal, and it expires open Checkout sessions from other tabs.
   Two clicks in the same instant can still create two sessions; turning on Stripe's "Limit
   customers to one subscription" (Settings, Checkout) closes that if it applies to API-created
   sessions on this account.

