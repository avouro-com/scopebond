# AGENTS.md — contributor & AI-agent guide (public repo)

This repository is **public and Apache-2.0**. Most changes here are AI-assisted.
This file is the contract for humans and coding agents working in it.

## The one rule that matters most

**Only open-source-appropriate content may be committed here.** Avouro's private
business, strategy, legal, economics, and security design documents live in a
**separate private repository** and must never be added to this repo — not in
`docs/`, not pasted into a code comment, not in a commit message.

A hard gate enforces this on every commit, push, and merge:

- `scripts/oss-gate.mjs` — checks staged files (commit), the whole tree (push),
  and every pull request (CI). It enforces a path **allowlist**, blocks known
  private paths, scans for private-doc signatures, and scans for secrets.
- Local hooks live in `.githooks/` and are activated by `pnpm install`
  (`git config core.hooksPath .githooks`). If you skip install, run
  `pnpm run hooks:install` once.
- CI runs the same gate as a **required check** (`.github/workflows/oss-guard.yml`).

The gate also blocks prior/other private project codenames (see `BLOCKED_TERMS`).
No code, comments, or docs derived from a separate private project may enter this
repo. Anything proprietary or business-internal lives in separate private
repositories — not here.

If the gate blocks something that genuinely belongs in the open-source repo, add
it to `ALLOW` in `scripts/oss-gate.mjs` in the same change and say why.

Never bypass the gate (`--no-verify`, disabling the workflow, force-pushing past
it) without an explicit maintainer decision recorded in the PR.

## What belongs here

The component and its neighbours (see `packages/`, landing incrementally):
`policy-schema` (+ test vectors), `verify` (the deterministic verdict library),
`gateway`, `sdk`, `attest`, framework integrations, the on-chain `contracts`,
the registry indexer/read API, and the `conformance` suite. Public-facing docs,
examples, and tooling are welcome.

**Not here:** any proprietary or hosted-service code and any internal/business/legal
material — those live in separate private repositories.

## Conventions

- **Node ≥ 20**, `pnpm` workspaces, ESM, TypeScript. LF line endings (`.gitattributes`).
- Core packages (`policy-schema`, `verify`, `gateway`, `sdk`, `contracts`) carry
  **no vendor or agent-framework SDK dependencies**; external services sit behind
  an interface with a local implementation exercised in tests. Framework
  integrations are separate leaf packages.
- **Fail closed.** Deny-by-default policy evaluation; unparseable input denies or
  goes stale; never "no limit".
- **No PII** in receipts, anchors, or evidence — hashes only.
- Trademarks ("Scopebond", "Scopebond Gateway", "Scopebond-compatible") are not
  granted by the license; using the Gateway name is gated on passing the
  conformance suite.

## Definition of done

1. Tests pass; a schema/vector change keeps the spec and the JSON Schema in agreement.
2. `pnpm run gate` passes locally.
3. Public docs updated if behaviour changed; an entry added to `CHANGELOG.md`.
4. No secrets, no private material (the gate is the backstop, not the first line).
