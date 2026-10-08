# Releasing

Packages are versioned and published with
[Changesets](https://github.com/changesets/changesets). **The Release workflow
publishes on merge** of the "Version packages" pull request, once no pending
changesets remain. Any other push to `main`, including a PR that edits a `version`
field directly, publishes nothing. A public merge or npm publication needs
maintainer approval; approving and merging a version PR is a publication
decision, not just a documentation update.

## Flow

1. Add a changeset for a releasable package change with `pnpm changeset`.
   Select affected packages and an appropriate bump, and describe the behavior
   change. A repository documentation-only change does not need a package bump.
2. An approved PR merged to `main` triggers `.github/workflows/release.yml`.
   When changesets remain, it opens or updates **Version packages**, which bumps
   versions and writes package changelogs. `pnpm version:packages` also synchronizes
   plugin versions and README release references.
3. Review the version PR, checks, and package scope. Obtain maintainer approval
   before merging. When the pushed commit is the merge of that PR (branch
   `changeset-release/main`) and changesets are consumed, the workflow's `publish`
   job (environment `npm-publish`) builds all packages, then runs
   `changeset publish`, pushes the release tags and creates the GitHub releases.
4. Verify the workflow result, npm versions and provenance, and generated release
   notes. A merged version is not proof of a successful npm publication. If a
   publish fails, inspect the existing registry versions and rerun the approved
   workflow rather than inventing another version or publishing from a different
   source tree.

## Configuration and checks

- Use the Node version in `.nvmrc` and pnpm 9.12.0 from `package.json`.
- The workflow supplies `NPM_TOKEN_SCOPEBOND` as `NPM_TOKEN` to the publish step
  only (not to install or build), and enables npm provenance. The automation token
  is used only by the step that opens the version PR. Installs run with
  `--ignore-scripts` and no dependency cache, and checkouts keep no token. Never
  put credential values in source or release instructions.
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
set, `pnpm release` builds all packages and publishes versions missing from npm.
Prefer the existing workflow for provenance and traceability; do not change the
workflow or bypass checks merely to publish from a workstation.
