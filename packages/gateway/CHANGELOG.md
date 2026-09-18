# @scopebond/gateway

## 0.5.0

### Minor Changes

- 973507f: Add signed boundary receipts. The evidence contract gains a `boundary` authorization mode — a clean representation for a receipt with **no agent signature**, where a gate attested a consequence and the identity is the receipt's boundary attribution (previously a boundary receipt would have had to misuse `insecure_development`). `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildBoundaryReceipt(input, attester)` — a reusable builder for any boundary-lane connector that constructs and signs a `boundary`-class receipt (gate, outcome_ref, attribution, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`).

  `@scopebond/github-action` uses it: with a signing key configured (`SCOPEBOND_ATTESTER_KEY`), the PR check emits a signed boundary receipt per PR head, verifiable offline, signed with the customer's own key in their runner. A `not_evaluated` (human) pull request emits none.

- 6417866: Add a `cooperative_allow` execution state to the receipt evidence contract. It records that an action was evaluated and allowed by policy but **not executed by the gateway** — the model for cooperative (M0 / check-only) enforcement, where the agent performs the action itself. Such a receipt is always `executed: false` with `external_effect: "not_independently_verified"`, so a cooperative allow is never labeled as executed. The verdict engine (`violates`) is unaffected: it evaluates the `executed` flag, not the execution state.
- 8ad0aab: Add the receipt evidence class (GATEWAY_SPEC §15 / D65): every receipt can carry an additive `evidence_class` of `signed_intent`, `pep_authorized` or `boundary`, so a verifier, the workspace and exports say how strong the evidence is without over-claiming.

  - `@scopebond/policy-schema` extends the closed `receipt.schema.json` with optional `evidence_class`, `principal` (required for `pep_authorized`) and `boundary` (`gate` ∈ merge/deploy/egress/platform_event, `outcome_ref`, `attribution` {kind: asserted|inferred, actor}; required for `boundary`), enforced by conditional schema rules, and exports `EVIDENCE_CLASSES`, `BOUNDARY_GATES`, `ATTRIBUTION_KINDS` and their types.
  - `@scopebond/gateway` tags its own signed-intent receipts explicitly, classifies legacy receipts at read time (`signed_intent` when an agent signature is present, else `pep_authorized`), and **never upgrades** an explicitly set class. `verifyReceipt` now reports `evidence_class` and rejects a receipt whose class-required fields are missing or whose foreign class fields are smuggled in. New exports: `classifyEvidenceClass`, `EVIDENCE_CLASSES`, `BOUNDARY_GATES` and the `EvidenceClass`/`BoundaryGate`/`BoundaryEvidence`/`PepPrincipal` types.

  The envelope is otherwise unchanged and receipts emitted before this field still verify. A boundary-receipt builder is intentionally left to the boundary connector that will consume it.

- 0cb916f: Add `scopebond-gateway init [--force]`. It scaffolds a working project — an Ed25519 agent signing key, a `principal-keys.json` registry that trusts that key, and a starter `scopebond.policy.json` bound to it — then prints the start, sign, submit and verify steps with a one-time control token that is never written to disk. A refused run (an existing registry or policy without `--force`) now leaves the directory untouched, generating no agent key.
- c17c1fb: `buildPepReceipt` and `buildBoundaryReceipt` now set a deterministic `action_ref.action_id`, so PEP-authorized and boundary receipts carry the idempotency key the durable Cloud outbox and the ingest use. Boundary receipts key on `(gate, outcome_ref, intent)` (re-evaluating the same PR head dedupes); PEP receipts key on `(intent, timestamp, principal)` (unique per authorized call, deterministic under an injected clock). Without this, those receipt classes could not be enqueued for export.
- 1fd3470: Wire up M0 (check-only / cooperative) enforcement. `createGateway({ mode: "check_only" })`, the `serve --check-only` flag and `SCOPEBOND_MODE=check_only` make an allowed action a **cooperative allow**: the gateway decides and countersigns but never dispatches to an executor, recording `execution.state: "cooperative_allow"` (always `executed: false`, `external_effect: "not_independently_verified"`). A new `gateway.check(req)` forces the same cooperative semantics regardless of the configured mode, so an agent can obtain a decision plus a portable signed receipt in-process with no HTTP server. Denials and the kill switch remain fail-closed, and replayed signed requests are still rejected.

  A cooperative allow is never counted as executed — not even transiently while reserved — so it cannot inflate a spend window it did not dispatch. Cumulative window enforcement across cooperative allows is therefore not provided in M0 by design; the per-action decision still applies, and in-path dispatch mode remains the way to enforce cumulative budgets. Also fixes the MCP `serverInfo.version` (previously reported `0.0.0`).

- 1260a51: Add signed PEP-authorized receipts, completing the three-class receipt model. The evidence contract gains a `pep` authorization mode — the honest representation for a receipt with **no agent signature** where a proxy/PEP decided a request carrying the caller's own identity; the identity is the receipt's `principal`. `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildPepReceipt(input, attester)` — a reusable builder for any M1/PEP connector (the MCP proxy, gateway interceptors). It constructs and signs a `pep_authorized`-class receipt (the normalized action, the principal, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`). Like the boundary class, it attests only that the PEP authorized the action for the principal — never agent non-repudiation.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [c0d81f6]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/verify@0.2.0

## 0.4.1

### Patch Changes

- b434d38: Add a bounded CLI enrollment flow that proves possession of the gateway attester key and returns scoped Cloud exporter configuration only to the gateway terminal.

## 0.4.0

### Minor Changes

- 2dabf5f: Publish the authenticated evidence SDK and add scoped-machine Cloud export with a
  bounded durable SQLite outbox, duplicate-safe acknowledgement, retry backoff and
  explicit delivery-gap status.

### Patch Changes

- Updated dependencies [875d640]
  - @scopebond/policy-schema@0.2.0
  - @scopebond/verify@0.1.1
