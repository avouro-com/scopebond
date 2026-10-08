# Releasing

Packages are versioned and published with
[Changesets](https://github.com/changesets/changesets). **The Release workflow
publishes on merge** once version changes are committed and no pending changesets
remain. A public merge or npm publication needs maintainer approval; approving and
merging a version PR is a publication decision, not just a documentation update.

## Flow

1. Add a changeset for a releasable package change with `pnpm changeset`.
   Select affected packages and an appropriate bump, and describe the behavior
   change. A repository documentation-only change does not need a package bump.
2. An approved PR merged to `main` triggers `.github/workflows/release.yml`.
   When changesets remain, it opens or updates **Version packages**, which bumps
   versions and writes package changelogs. `pnpm version:packages` also synchronizes
   plugin versions and README release references.
3. Review the version PR, checks, and package scope. Obtain maintainer approval
   before merging. With the version changes committed and changesets consumed,
   the workflow's `version` job finds the package versions missing from npm, the
   `pack` job builds all packages and packs those versions into tarballs, and the
   `publish` job waits for approval in the `npm-publish` environment.
4. Approve the `npm-publish` deployment on the workflow run (the second publication
   decision). The `publish` job publishes the tarballs with npm trusted publishing
   and provenance, then creates the git tags and GitHub releases.
5. Verify the workflow result, npm versions and provenance, and generated release
   notes. A merged version is not proof of a successful npm publication. If a
   publish fails or the deployment was rejected, inspect the existing registry
   versions and re-run the failed jobs (or run the Release workflow on `main` from
   the Actions tab) rather than inventing another version or publishing from a
   different source tree.

## Release workflow jobs

`.github/workflows/release.yml` keeps npm publishing rights in one small job:

| Job | Runs when | Environment | Permissions | npm credentials |
| --- | --- | --- | --- | --- |
| `version` | every push to `main` | none | `contents: write`, `pull-requests: write` | none |
| `pack` | a publish is due | none | `contents: read` | none |
| `publish` | a publish is due | `npm-publish` (owner approval) | `contents: write`, `id-token: write` | OIDC; token fallback |

"A publish is due" means no changesets are pending and some public package
version is not on npm (the `changesets/action/select-mode` publish plan). A merge
that leaves every version published does not reach `pack` or `publish`, so it does
not ask for approval.

## Trusted publishing

npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) lets the
`publish` job authenticate with a short-lived OIDC token instead of a long-lived
npm token, and npm attaches provenance automatically. Requirements and how the
workflow meets them:

- npm CLI 11.5.1 or later. Node 22.20.0 bundles npm 10, so the `publish` job
  installs a pinned `npm@11.21.0` first.
- `changeset publish` in this pnpm workspace runs `pnpm publish` for each packed
  tarball, and pnpm 10 hands a tarball to `npm publish` from `PATH`, so the
  upgraded npm performs the OIDC exchange.
- `id-token: write` only on the `publish` job, which runs in the `npm-publish`
  environment named in each package's trusted publisher.

npm allows one trusted publisher per package, so only `release.yml` can publish
with OIDC; the manual `publish.yml` workflow authenticates only with the
`NPM_TOKEN` secret and stops working once tokens are disallowed.

### One-time owner setup

1. In the repository settings, create the `npm-publish` environment with the
   owner as a required reviewer, limited to protected branches.
2. Add a trusted publisher to each published package: `@scopebond/agent`,
   `@scopebond/framework`, `@scopebond/gateway`, `@scopebond/github-action`,
   `@scopebond/hook`, `@scopebond/mcp`, `@scopebond/policy-schema`,
   `@scopebond/sdk`, and `@scopebond/verify` (every `packages/*` package that is
   not `private`).
   - On npmjs.com: package **Settings** → **Trusted publishing** → **GitHub
     Actions**, with organization or user `avouro-com`, repository `scopebond`,
     workflow filename `release.yml`, and environment `npm-publish`.
   - Or with the npm CLI (npm 11.15.0 or later, logged in with 2FA enabled; the
     first call asks for 2FA, where npm offers to skip it for the next 5 minutes):

     ```sh
     for pkg in agent framework gateway github-action hook mcp policy-schema sdk verify; do
       npm trust github "@scopebond/$pkg" --repo avouro-com/scopebond \
         --file release.yml --env npm-publish --allow-publish --yes
       sleep 2
     done
     npm trust list @scopebond/hook
     ```

3. After the first release whose `publish` job log shows a successful trusted
   publish (and npm shows the new versions with provenance):
   - remove `NODE_AUTH_TOKEN` from the `publish` job in `release.yml`;
   - delete the `NPM_TOKEN_SCOPEBOND` and `NPM_TOKEN` repository secrets and remove
     the token-only `publish.yml` workflow;
   - revoke those tokens on npmjs.com (**Access Tokens**);
   - for each package, set **Settings** → **Publishing access** to **Require
     two-factor authentication and disallow tokens**. Trusted publishing keeps
     working with this setting.

## Configuration and checks

- Use the Node version in `.nvmrc` and pnpm 10.34.6 from `package.json`.
- The `publish` job authenticates with npm trusted publishing. Until the first
  trusted publish succeeds it also supplies `NPM_TOKEN_SCOPEBOND` as
  `NODE_AUTH_TOKEN` (read through the `.npmrc` that `actions/setup-node` writes);
  npm tries the OIDC exchange first and uses that token only if the exchange
  fails. Keep credentials in repository secrets; never put their values in source
  or release instructions.
- Public packages set `publishConfig.access: public`. The Changesets ignore list
  is empty; the gateway is already published, not awaiting its first release.
- Run `pnpm run gate` and the relevant build, test, and package smoke checks before
  requesting a merge. `check:release-state` verifies README release references,
  public gateway installation instructions, and plugin version pins.
- Current public npm/npx setup examples use `@latest`. Runtime hook commands,
  managed workspace client updates, and reproducible CI configurations may pin
  exact versions separately; do not replace those pins with `@latest`.
- README and npm description changes appear on npm when the relevant package is
  next published through an approved release. A GitHub documentation merge alone
  does not update the README of an already published npm version.

## Exceptional manual publication

After explicit maintainer approval and verification of the exact source/version
set, run the Release workflow on `main` from the Actions tab: it plans, packs, and
(after the `npm-publish` approval) publishes the versions missing from npm.
`pnpm release` builds all packages and publishes from a workstation, but needs
an npm token, which is unavailable once packages disallow tokens. Prefer the
workflow for provenance and traceability; do not change the workflow or bypass
checks merely to publish from a workstation.
