# Changelog

All notable changes to the open-source Scopebond packages are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project will adopt [Semantic Versioning](https://semver.org/) at its first
tagged release.

## [Unreleased]

### Added
- A release-candidate Cloud exporter with scoped machine credentials, a bounded
  durable SQLite outbox and gap journal, duplicate-safe acknowledgements, retry
  backoff, and explicit status for capacity, conflict, expiry and legacy-ID gaps.
- A coherent local package release set: policy-schema 0.2.0, verifier 0.1.1,
  gateway 0.4.0 and the SDK's first 0.1.0 candidate.
- Durable execution reconciliation: atomic request/approval/budget consumption,
  signed pre-dispatch lifecycle records, read-only adapter result queries,
  control-protected unresolved-action inspection, pinned-policy restart recovery,
  and an outbound-disabled restore mode. Ambiguous HTTP responses return `202` and
  retain `outcome_unknown`; no reconciliation path redispatches an action.
- One shared strict RFC-8785-target canonical serializer and cross-package vectors
  now define schema, verifier, gateway and SDK signature/hash bytes.
- Policy schemas now load through bundleable JSON modules, keeping strict gateway
  validation available in Cloudflare Workers without a `node:fs` dependency.
- Authenticated agent-intent and approval envelopes: Ed25519 key binding, bounded
  validity, single-use replay identifiers, exact intent/policy references, receipt
  evidence, and offline principal verification.
- Stable action identifiers and atomic in-memory/SQLite authority reservations,
  including write-ahead lifecycle state, pinned policy snapshots, conservative
  accounting for unknown outcomes, and durable global/per-agent stops.
- Bearer authentication for receipt, status, stop/resume, and manual-anchor control
  routes.
- Clean-consumer package smoke testing now forces the candidate schema and verifier
  tarballs for transitive gateway dependencies, preventing a false pass against a
  mixed local/published release set.
- `createSupportRefundExecutor()`, a constrained reference adapter with a fixed
  operator-controlled HTTPS destination, gateway-owned credentials, action-ID
  idempotency, normalized fields, redirect denial, bounded responses, and
  transport-injection rejection.
- Strict runtime policy/action validation, enforce-first all-clause evaluation,
  closed action allowlists and parameter types, fail-safe policy reload, and an
  explicit non-authorizing passive observation endpoint.
- Evidence contract v1 for `scopebond:receipt`: explicit execution states, exact
  policy/action references, minimized request evidence, separate legacy schema,
  Node/WebCrypto/offline vectors, and verification results that never imply an
  independently proven external effect. The default no-op is now `simulated` and
  ambiguous adapter exceptions are signed as `outcome_unknown` without retaining
  raw error text.
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

### Changed
- The constrained support-refund adapter can query the upstream result by its
  durable idempotency key, distinguishing confirmed success or no effect from an
  outcome that must remain unknown.
- Global-scope window clauses now fail closed unless the caller explicitly declares
  that the coordinator has the complete gateway set.
- Stores without atomic authority reservations reject real dispatch while retaining
  simulation and passive-observation support.
