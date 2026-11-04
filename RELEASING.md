# Releasing to npm

Eight packages publish from `packages/*`: `oortmem` (the CLI) and `@oortmem/core`, `store-sqlite`,
`writer`, `decide-jev`, `embed-voyage`, `rerank-voyage` and `claude-code`. `@oortmem/bench` is
private. All share one version.

## One-time setup

1. On npmjs.com, sign in with the Oort account and create the organization **`oortmem`** (free,
   public packages). This reserves the `@oortmem` scope.
2. Turn on two-factor authentication for publishing.
3. Create a **granular access token**: packages and scopes `oortmem` and `@oortmem/*`, read and
   write, an expiry of 30 days or less. The old token was exposed, so never reuse it.
4. Store it in the Keychain, not in a file:

   ```sh
   security add-generic-password -a "$USER" -s oort.npm-token -w
   ```

## Each release

The first release is `0.1.0`, which every package already has: skip the version bump and tag `v0.1.0`.

```sh
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm verify
# Bump every package to the same version, e.g. 0.1.1:
pnpm -r --filter './packages/*' exec npm version 0.1.1 --no-git-tag-version
# and set VERSION in packages/core/src/index.ts (a test keeps them equal).
pnpm build
pnpm -r --filter './packages/*' --filter '!@oortmem/bench' publish --dry-run --no-git-checks --access public
# .npmrc holds only a reference; npm reads the token from the environment at publish time.
printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > .npmrc
NPM_TOKEN="$(security find-generic-password -a "$USER" -s oort.npm-token -w)" \
  pnpm -r --filter './packages/*' --filter '!@oortmem/bench' publish --access public
rm .npmrc
git tag v0.1.1 && git push origin v0.1.1
```

pnpm publishes in dependency order (`@oortmem/core` first, `oortmem` last) and turns `workspace:*`
into the real version.

Later, prefer npm trusted publishing from a GitHub Actions workflow (OIDC, with provenance), so no
long-lived token exists at all.

## After the first release

- Replace "build from source" in the README quickstart with `npm install -g oortmem`.
- Update the install line on oortcloud.dev (private repo, `apps/site`).
