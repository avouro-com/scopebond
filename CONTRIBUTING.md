# Contributing to Scopebond

Thanks for your interest. Scopebond is open source (Apache-2.0) and built mostly
with AI assistance. This guide covers how to contribute and the boundaries that
keep the project healthy and safe.

## Before you start — is it in scope?

Scopebond has a deliberately narrow scope. Read **[SCOPE.md](SCOPE.md)** first,
and follow the contribution ladder in **[GOVERNANCE.md](GOVERNANCE.md)**: small
fixes can go straight to a PR, but a new clause type, a public-interface change, a
new package, or anything touching a hard constraint needs a **proposal issue and
maintainer sign-off before you write code**. Every PR gets an automated
scope-review against SCOPE.md; out-of-scope PRs are routed to a maintainer, not
silently closed.

## Getting started

1. Install [Node ≥ 20](.nvmrc) and `pnpm`.
2. `pnpm install` — this also activates the local git hooks
   (`git config core.hooksPath .githooks`).
3. Make your change on a branch, add tests, and run `pnpm run gate` and
   `pnpm -r test` before you commit.

## The open-source content gate

This is a **public** repository. Avouro's private business/strategy/legal design
documents live in a separate private repository and must never be committed here.
A hard gate (`scripts/oss-gate.mjs`) runs on **commit** (`.githooks/pre-commit`),
**push** (`.githooks/pre-push`), and every **pull request** (CI required check).
It enforces a path allowlist, blocks known-private paths and prior-project
codenames, and scans for secrets. If it blocks a file that legitimately belongs in
the open-source repo, add it to `ALLOW` in `scripts/oss-gate.mjs` in the same PR
and explain why. Do not bypass the gate.

## Contributor License Agreement (CLA)

Contributions are accepted under a CLA (Apache ICLA-style) — see [CLA.md](CLA.md).
This preserves the option to relicense the proprietary control plane later; it
does **not** change the Apache-2.0 terms of your contribution to this repository.
The CLA check must pass before a PR is merged.

## Coding standards

- ESM + TypeScript, `pnpm` workspaces, LF line endings.
- Core packages carry no vendor/agent-framework SDK dependencies
  (`scripts/deps-allowlist.mjs` enforces this).
- Fail closed; no PII in receipts/anchors/evidence.
- Add tests; keep schema and generated JSON Schema in agreement.

## Trademarks

"Scopebond", "Scopebond Gateway", and "Scopebond-compatible" are trademarks of
Avouro LLC. The license grants no trademark rights. A build may call itself
"Scopebond-compatible" only if it passes the conformance suite; a fork must use a
different name.

## Reporting security issues

Do not open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).
