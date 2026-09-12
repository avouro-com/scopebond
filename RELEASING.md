# Releasing

Packages are versioned and published to npm with
[Changesets](https://github.com/changesets/changesets). Publishing is one command
away and gated on a merged "Version packages" PR.

Publishing is a **deliberate** step — CI never auto-publishes (so nothing, least of
all a `0.0.0`, goes out by accident).

## Flow

1. **Add a changeset** with your change:
   ```bash
   pnpm changeset
   ```
   Select the packages that changed (e.g. `@scopebond/verify`,
   `@scopebond/policy-schema`) and the bump (**minor** for the first release), and
   write a one-line summary. Commit the generated `.changeset/*.md` with your PR.
2. **Merge to `main`.** The Release workflow opens/updates a **"Version packages"**
   PR that bumps versions and updates each package's changelog from the changesets.
   (It only versions — it does not publish.)
3. **Merge the "Version packages" PR.** Versions are now real (e.g. `0.1.0`).
4. **Publish, deliberately:**
   ```bash
   pnpm release        # builds all, then `changeset publish`
   ```
   Run it locally (with `npm whoami` authenticated), or enable publish-on-merge by
   adding `publish: pnpm release` (and `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`)
   to the workflow step — see the comment in `.github/workflows/release.yml`.

## Setup / notes

- Requires the **`NPM_TOKEN`** repo secret — a granular npm token with read+write on
  the `@scopebond` scope and **2FA-bypass** (CI can't prompt). All packages set
  `publishConfig.access: public`.
- **First publish:** the changeset bumps `0.0.0 → 0.1.0`, so packages publish at
  `0.1.0` (npm rejects `0.0.0`). Publishing `@scopebond/verify` + `@scopebond/policy-schema`
  first establishes the open standard (the spec + conformance vectors) ahead of the proxy.
- **`@scopebond/gateway` is in `ignore`** (`.changeset/config.json`) while it's alpha —
  remove it from `ignore` when you're ready to publish the gateway.
- Manual publish (if ever needed): `pnpm release` (builds all, then `changeset publish`).
