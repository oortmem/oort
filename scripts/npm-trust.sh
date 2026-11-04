#!/usr/bin/env bash
# Trust .github/workflows/release.yml (environment `npm`) to publish every Oort package.
# Needs npm 11.5.1+, a logged-in npm session with 2FA, and each package to exist on npm.
set -euo pipefail
for pkg in @oortmem/core @oortmem/store-sqlite @oortmem/writer @oortmem/decide-jev \
  @oortmem/embed-voyage @oortmem/rerank-voyage @oortmem/claude-code @oortmem/mcp oortmem; do
  npm trust github "$pkg" --repository oortmem/oort --file release.yml --environment npm --allow-publish --yes
done
