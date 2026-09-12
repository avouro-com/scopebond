# Changelog

All notable changes to the open-source Scopebond packages are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project will adopt [Semantic Versioning](https://semver.org/) at its first
tagged release.

## [Unreleased]

### Added
- Repository scaffolding: Apache-2.0 license, monorepo layout (`packages/`), the
  first packages (`@scopebond/policy-schema`, `@scopebond/verify`), and the
  open-source content gate (`scripts/oss-gate.mjs`) enforced on commit, push, and
  merge.
- `@scopebond/sdk` (early): operator-side Ed25519 signing of agent action intents,
  signature verification, and a thin `submit()` gateway client (zero deps).
- `@scopebond/gateway`: `createHttpExecutor()` — a real HTTP-forwarding executor for
  allowed `http.call` actions (records a response digest as the execution ref).
- `examples/quickstart.mjs`: end-to-end demo (agent signs → gateway enforces →
  countersigned receipt), plus a sample policy.
- `@scopebond/gateway` (alpha): a policy-enforcement proxy on Hono — HTTP +
  minimal MCP ingress, in-line enforcement via `@scopebond/verify` (deny out-of-policy,
  fail closed; enforce/monitor/require_approval modes), **Ed25519-countersigned
  `scopebond:receipt`s**, a kill switch, and swappable `ReceiptStore`/`Executor`
  interfaces. `npx scopebond-gateway <policy.json>`.
- `@scopebond/verify`: fixed window/rate dedup to key on receipt occurrence (hash +
  timestamp) so distinct actions sharing an intent hash both count.
- `@scopebond/verify`: full v1 clause coverage in `violates()` — `spend_limit`,
  `rate_limit`, `require_approval`, `sequence`, `time_window`, endpoint/address/
  contract allow- and deny-lists, `action_allowlist` param bounds, and `key_policy`
  (`oracle_condition` planned). Added the reference **conformance vector suite**
  (`vectors/conformance.json`, 30 cases: prevented / covered / ambiguity / refused)
  with a runner.
