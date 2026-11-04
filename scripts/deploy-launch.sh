#!/usr/bin/env bash
# Deploy the Oort Pro relay and the site, with every secret piped from the macOS Keychain.
# No secret is echoed, written to disk or passed in argv.
#
#   scripts/deploy-launch.sh test   # Stripe sandbox (QA with test cards)
#   scripts/deploy-launch.sh live   # Stripe live
#
# Keychain items (service names, account = $USER):
#   oort.voyage  oort.typesafe  oort.anthropic       relay vendor keys
#   oort.deploy.clerk-secret-live                     Clerk production secret key
#   oort.deploy.stripe-secret-{test,live}             Stripe secret (or restricted) key
#   oort.deploy.stripe-webhook-{test,live}            Stripe webhook signing secret
set -euo pipefail

mode="${1:-}"
case "$mode" in test | live) ;; *) echo "usage: $0 test|live" >&2; exit 2 ;; esac

root="$(git rev-parse --show-toplevel)"
cd "$root"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "deploy from main" >&2; exit 1; }
[ "$(git rev-parse --git-dir)" = .git ] || { echo "deploy from the main checkout, not a worktree" >&2; exit 1; }

# Public values (not secrets).
CLERK_PK=pk_live_Y2xlcmsub29ydGNsb3VkLmRldiQ
BEACON=02ce59a815cf4fecb9eb8c91d03aefe5
if [ "$mode" = live ]; then PRICE=price_1UY3uARV1oD9yCAXUGI13EhA; else PRICE=price_1UY3FgDoJyLfFXhjQaT27b0G; fi

kc() { /usr/bin/security find-generic-password -a "$USER" -s "$1" -w; }
need() { /usr/bin/security find-generic-password -a "$USER" -s "$1" >/dev/null 2>&1 || { echo "missing Keychain item $1" >&2; exit 1; }; }
for item in oort.voyage oort.typesafe oort.anthropic oort.deploy.clerk-secret-live \
  "oort.deploy.stripe-secret-$mode" "oort.deploy.stripe-webhook-$mode"; do need "$item"; done

# put <app> <NAME> <keychain item>: value goes Keychain -> pipe -> wrangler, never to the terminal.
put() { (cd "apps/$1" && kc "$3" | tr -d '\n' | pnpm exec wrangler secret put "$2" >/dev/null) && echo "  $1: $2 set"; }
putv() { (cd "apps/$1" && printf '%s' "$3" | pnpm exec wrangler secret put "$2" >/dev/null) && echo "  $1: $2 set"; }

pnpm install --frozen-lockfile
[ "${SKIP_VERIFY:-}" = 1 ] || pnpm verify   # SKIP_VERIFY=1 when timing tests flake under heavy load

echo "== relay"
(cd apps/relay && pnpm exec wrangler deploy)
put relay VOYAGE_API_KEY oort.voyage
put relay TYPESAFE_API_KEY oort.typesafe
put relay ANTHROPIC_API_KEY oort.anthropic

echo "== site ($mode Stripe)"
VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PK" CF_BEACON_TOKEN="$BEACON" pnpm --filter @oortmem/site build
(cd apps/site && pnpm exec wrangler deploy)
put site CLERK_SECRET_KEY oort.deploy.clerk-secret-live
put site STRIPE_SECRET_KEY "oort.deploy.stripe-secret-$mode"
put site STRIPE_WEBHOOK_SECRET "oort.deploy.stripe-webhook-$mode"
putv site STRIPE_PRICE_PRO "$PRICE"

echo "== smoke"
printf 'relay (expect 401): '; curl -s -o /dev/null -w '%{http_code}\n' -X POST https://relay.oortcloud.dev/v1/voyage/embeddings
printf 'site  (expect 200): '; curl -s -o /dev/null -w '%{http_code}\n' https://oortcloud.dev/
