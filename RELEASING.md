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
   scripts/npm-trust.sh           # `npm trust github` for every package; already-trusted ones are skipped
   ```

   Or on npmjs.com: each package → Settings → Trusted Publisher → GitHub Actions, with
   organization `oortmem`, repository `oort`, workflow `release.yml`, environment `npm`.

4. **Lock tokens out.** On each package: Settings → Publishing access → "Require two-factor
   authentication and disallow tokens". Trusted publishing keeps working; stolen tokens do not.

## Each release

```sh
git checkout main && git pull
# Bump every package to the same version, e.g. 0.1.1, VERSION in packages/core/src/index.ts, and the
# version in every plugin.json under distribution/ (oort and oort-dev, Claude Code and Codex),
# distribution/claude-desktop/manifest.json, .claude-plugin/marketplace.json, server.json (its
# version and the oortmem package version) and metadata.oortmem-version in skills/*/SKILL.md
# (release-check fails the run if any differ):
pnpm -r --filter './packages/*' exec npm version 0.1.1 --no-git-tag-version
# Review skills/ against what changed in the SDK and CLI, then copy it into the plugins:
pnpm skills:sync
# commit through a PR, merge it, then tag main:
git tag v0.1.1 && git push origin v0.1.1
```

The tag starts the workflow. Approve the `npm` environment in the Actions run. The workflow checks
that the tag equals every package version, runs `pnpm verify`, packs (resolving `workspace:*`), and
publishes in dependency order, skipping any version already on npm so a re-run is safe.

## The MCP Registry

`server.json` lists Oort in the official MCP Registry as `io.github.oortmem/oort`. The registry
checks `mcpName` in the published `oortmem` package, so a version can only be listed once it is on
npm. Publishing to the registry is not automated: after the npm run finishes, publish the same
version by hand (Marcus, signed in to GitHub as a member of the `oortmem` org):

```sh
brew install mcp-publisher        # once
mcp-publisher login github        # once per machine; a device-code sign-in
mcp-publisher publish             # from the repo root, on the tagged commit
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.oortmem/oort"
```

Skip a release and the registry keeps showing the last version you published.

## After the first release

- Replace "build from source" in the README quickstart with `npm install -g oortmem`.
- Update the install line on oortcloud.dev (private repo, `apps/site`).
