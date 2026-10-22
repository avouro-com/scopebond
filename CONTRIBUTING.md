# Contributing to Scopebond

Thanks for your interest. The software in this repository is free and open source
(Apache-2.0). Scopebond Cloud, the hosted shared workspace, is a separate
proprietary service. This guide covers contributions to the open-source software.

## Before you start — is it in scope?

Scopebond has a deliberately narrow scope. Read **[SCOPE.md](SCOPE.md)** first,
and follow the contribution ladder in **[GOVERNANCE.md](GOVERNANCE.md)**: small
fixes can go straight to a PR, but a new clause type, a public-interface change, a
new package, or anything touching a hard constraint needs a **proposal issue and
maintainer sign-off before you write code**. Every PR gets an automated
scope-review against SCOPE.md; out-of-scope PRs are routed to a maintainer, not
silently closed.

## Getting started

1. Use the [Node version pinned for this repository](.nvmrc) and pnpm 10.34.6
   (the `packageManager` in `package.json`). Individual packages have their own
   runtime requirements; the hook and the Scopebond service (`@scopebond/agent`) require Node >=22.13.
2. `pnpm install` — this also activates the local git hooks
   (`git config core.hooksPath .githooks`).
3. Make your change on a branch, add tests, and run `pnpm run gate` and
   `pnpm -r test` before you commit.

## The open-source content gate

This is a **public** repository. Documents that are not part of the open-source
project are not kept here and must never be committed. A hard gate (`scripts/oss-gate.mjs`) runs on **commit** (`.githooks/pre-commit`),
**push** (`.githooks/pre-push`), and every **pull request** (CI required check).
It enforces a path allowlist, blocks known-private paths and prior-project
codenames, and scans for secrets. If it blocks a file that legitimately belongs in
the open-source repo, add it to `ALLOW` in `scripts/oss-gate.mjs` in the same PR
and explain why. Do not bypass the gate.

## Contributor License Agreement (CLA)

Contributions are accepted under a CLA (Apache ICLA-style) — see [CLA.md](CLA.md).
The CLA lets Avouro LLC offer the hosted service under its own terms. Your
contribution stays available under Apache-2.0. The CLA check must pass before a PR is merged.

## Coding standards

- ESM + TypeScript, `pnpm` workspaces, LF line endings.
- Core packages carry no vendor/agent-framework SDK dependencies
  (`scripts/deps-allowlist.mjs` enforces this).
- Fail closed; no PII in receipts/anchors/evidence.
- Add tests; keep schema and generated JSON Schema in agreement.

## Contributing a rule pack

General rule packs (data that teaches the hook what a common tool does, and rules for it) live in
[`packages/hook/packs/`](packages/hook/packs/README.md), whose README is the authoring guide. A pack here must not
describe a single vendor's tool or service. Give it at least ten vectors, run
`scopebond packs test packages/hook/packs/` and the hook's tests, and explain each rule's default mode in the pull
request. Packs are contributed under the same CLA as code.

## Trademarks

"Scopebond", "Scopebond Gateway", and "Scopebond-compatible" are trademarks of
Avouro LLC. The license grants no trademark rights. A build may call itself
"Scopebond-compatible" only if it passes the conformance suite; a fork must use a
different name.

## Reporting security issues

Do not open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).
