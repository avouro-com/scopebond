# Changelog

All notable changes to the open-source Scopebond packages are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project will adopt [Semantic Versioning](https://semver.org/) at its first
tagged release.

## [Unreleased]

Per-package versions and notes are managed with changesets; this section is a
human summary. The published set is policy-schema 0.4.1, verify 0.4.0, gateway
0.7.0, sdk 0.1.2, hook 0.6.0, github-action 0.4.0 and mcp and framework at 0.3.2.
Per-release detail lives in each package's own `CHANGELOG.md`; past security
advisories are summarized in [SECURITY.md](SECURITY.md).

### Security
- **github-action:** the Action read `scopebond.policy.json` from the pull request's
  own checkout, so a pull request could rewrite the policy it was checked against.
  It now reads the policy from the base commit. Fixed in github-action 0.4.0.
- **hook:** the mapper compared command text literally, so a governed agent could do
  what the starter policy forbids by spelling it differently — protected branches via
  `refs/heads/main`, a second refspec or `--all`; keys and `.env` files via `cp`,
  `tar`, `scp`, `curl -T`, globs, variables, case variants or Windows paths; config
  and CI files via copies, `tee`, `sed -i` or spaceless redirections; destructive
  commands under `cmd /c`, `pwsh -EncodedCommand`, `find -exec` or `busybox`. Inputs
  are canonicalized before evaluation, and a project's own `.scopebond/policy.json`
  no longer takes precedence over the user's install. Fixed in hook 0.6.0.
- **verify, hook:** `force_push_guard` fired only on a `--force` push whose single
  resolved ref matched the protected set, so branch deletion (`git push origin :main`,
  `--delete`), all-branch pushes (`--all --force`, `--mirror`) and nested release
  branches slipped through. Fixed in verify 0.4.0 and hook 0.6.0.
- **hook:** the command digest was computed before scrubbing, so a receipt's digest
  leaked the credential the scrubber had removed; the scrubber also missed `-p`/`-u`
  flag values and custom auth headers. Fixed in hook 0.6.0.
- **policy-schema:** `canonical()` escaped lone surrogates instead of refusing them,
  so two distinct inputs could canonicalize to the same bytes. It now rejects them.
  Fixed in policy-schema 0.4.1.
- **hook:** the secret scrubber leaked credentials — single-token shapes (GitHub,
  AWS, Slack, Stripe, npm, OpenAI/Anthropic, Google keys, JWTs, high-entropy blobs)
  were emitted as `secret***` and signed into receipts. Rewritten with explicit
  rules and a property-based regression suite; structured mapper parameters are
  scrubbed too.
- **hook:** command-injection bypasses — a denied program could ride in behind an
  allowed one (`a && b`, `bash -c '…'`, `$(…)`, `FOO=1 rm`, `git -C`, `+ref`). The
  mapper now decomposes a command into every simple command and denies the call if
  any is out of policy; the hook defers to the host on allow instead of
  auto-approving; the starter policy protects the hook's own config and keys.
- **gateway, mcp:** stateful clauses (rate_limit, spend_limit, sequence) never bound
  in cooperative mode; they now count prior cooperative allows.
- **framework:** `guardedTool` returned a tool unguarded when it lacked `execute`;
  it now throws rather than silently pass a tool through with no policy check.

### Fixed
- **gateway:** local stores tolerate concurrent writers and crashes — SQLite opens
  with WAL and a busy timeout so parallel hook processes wait for the lock instead of
  failing, a database that exists but cannot be opened is an error rather than a
  silent switch to another log, and the JSONL fallback truncates a torn final line.
- **github-action:** governs `claude[bot]` and `github-actions[bot]`, and evaluates
  at a real timestamp so `time_window` clauses bind (was epoch 0).
- Reconciled public package status and enrollment examples with the published
  release set; CI rejects release metadata that drifts from package manifests.

### Added
- **verify:** offline WebCrypto verification of receipt signatures, and `SPEC.md`
  states exactly which verifiers support what.
- **gateway, verify:** RFC 9162 Merkle anchors v2 — signed, versioned and chained to
  the last v1 anchor, with audit-path and consistency proofs the client verifies
  itself. `gateway.anchor()` refuses to sign when the receipt log no longer
  reproduces the previous anchor.
- A bounded `scopebond-gateway enroll` handoff that reads a one-use Cloud bundle,
  proves possession with the local attester key, and prints the scoped exporter
  credential only to the gateway terminal.
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
