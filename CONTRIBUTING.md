# Contributing to Scopebond

Thanks for your interest. Scopebond is open source (Apache-2.0) and built mostly
with AI assistance.

> **Early stage.** A formal contribution scope policy and a Contributor License
> Agreement (CLA) are being finalized and will be added before external
> contributions are accepted. For now, please **open an issue to discuss** any
> non-trivial change before writing code.

## Getting started

1. Install [Node ≥ 20](.nvmrc) and `pnpm`.
2. `pnpm install` — this also activates the local git hooks
   (`git config core.hooksPath .githooks`).
3. Make your change on a branch, add tests, and run `pnpm run gate` before you
   commit.

## The open-source content gate

This repository is **public** and must contain only open-source-appropriate
content. A hard gate (`scripts/oss-gate.mjs`) runs on **commit**
(`.githooks/pre-commit`), **push** (`.githooks/pre-push`), and every **pull
request** (CI). It enforces a path allowlist, blocks known-private paths and
prior-project codenames, and scans for secrets. If it blocks a file that
legitimately belongs in the open-source repo, add it to `ALLOW` in
`scripts/oss-gate.mjs` in the same PR and explain why. Do not bypass the gate.

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
