#!/usr/bin/env bash
# Trust .github/workflows/release.yml (environment `npm`) to publish Oort packages.
# Needs npm 11.5.1+, a logged-in npm session with 2FA, and each package to exist on npm.
# Usage: scripts/npm-trust.sh [package ...]   (no arguments: every Oort package)
# Packages that already trust a publisher are skipped, so re-running is safe.
set -euo pipefail
if [ "$#" -gt 0 ]; then pkgs=("$@"); else
  pkgs=(@oortmem/core @oortmem/store-sqlite @oortmem/writer @oortmem/decide-jev
    @oortmem/embed-voyage @oortmem/rerank-voyage @oortmem/claude-code @oortmem/mcp
    @oortmem/local-models oortmem)
fi
for pkg in "${pkgs[@]}"; do
  # Output is shown live (npm prints its 2FA link there). A package that already trusts a
  # publisher answers 409: skip it and carry on.
  if out=$(npm trust github "$pkg" --repository oortmem/oort --file release.yml \
    --environment npm --allow-publish --yes 2>&1 | tee /dev/stderr); then
    echo "trusted $pkg"
  elif grep -q "E409" <<<"$out"; then
    echo "skip $pkg (a trusted publisher already exists)"
  else
    exit 1
  fi
done
