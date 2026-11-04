# Releasing to npm

Nine packages publish from `packages/*`: `oortmem` (the CLI) and `@oortmem/core`, `store-sqlite`,
`writer`, `decide-jev`, `embed-voyage`, `rerank-voyage`, `claude-code` and `mcp`. `@oortmem/bench` is
private. All share one version.

Releases run in GitHub Actions (`.github/workflows/release.yml`) with **npm trusted publishing**:
npm trusts that one workflow through OIDC, so no npm token exists anywhere, and every package gets
a provenance statement that links it to the commit and workflow run that built it. The workflow
runs in the GitHub environment `npm`, which needs Marcus's approval before it can publish.

## One-time setup

1. **npm organization** `oortmem` exists (done 2026-11-04). Turn on two-factor authentication for
   the account.
2. **First publish (bootstrap).** npm only lets you add a trusted publisher to a package that
   exists, so `0.1.0` is published once from a terminal:

   ```sh
   npm login                      # opens the browser; uses your 2FA
   git checkout main && git pull && pnpm install --frozen-lockfile && pnpm verify && pnpm build
   pnpm -r --filter './packages/*' --filter '!@oortmem/bench' publish --access public
   npm logout
   ```

3. **Trust the workflow** for each package (npm 11.5.1 or later):

   ```sh
   scripts/npm-trust.sh           # runs `npm trust github` for all nine packages
   ```

   Or on npmjs.com: each package → Settings → Trusted Publisher → GitHub Actions, with
   organization `oortmem`, repository `oort`, workflow `release.yml`, environment `npm`.

4. **Lock tokens out.** On each package: Settings → Publishing access → "Require two-factor
   authentication and disallow tokens". Trusted publishing keeps working; stolen tokens do not.

## Each release

```sh
git checkout main && git pull
# Bump every package to the same version, e.g. 0.1.1, VERSION in packages/core/src/index.ts, and the
# version in distribution/*/oort plugin.json files, distribution/claude-desktop/manifest.json and
# .claude-plugin/marketplace.json (release-check fails the run if any differ):
pnpm -r --filter './packages/*' exec npm version 0.1.1 --no-git-tag-version
# commit through a PR, merge it, then tag main:
git tag v0.1.1 && git push origin v0.1.1
```

The tag starts the workflow. Approve the `npm` environment in the Actions run. The workflow checks
that the tag equals every package version, runs `pnpm verify`, packs (resolving `workspace:*`), and
publishes in dependency order, skipping any version already on npm so a re-run is safe.

## After the first release

- Replace "build from source" in the README quickstart with `npm install -g oortmem`.
- Update the install line on oortcloud.dev (private repo, `apps/site`).
