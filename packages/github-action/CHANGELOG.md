# @scopebond/github-action

## 0.5.9

### Patch Changes

- 88a6380: The changed-file list is now read as one JSON entry per file (or a NUL-delimited diff) and counted per entry, so a file name holding a newline cannot inflate the count and hide a truncated list; any path with a control character fails the check closed. The check step no longer runs `npx` in the workspace: it installs the version named by the action's own package.json (the `version` input now defaults to empty, meaning that version) into the runner's temp directory with lifecycle scripts off, runs it from the workspace, and passes inputs through env instead of template expansion.
- Updated dependencies [258cdb6]
- Updated dependencies [d6996ad]
- Updated dependencies [7fc5efb]
- Updated dependencies [0f7268b]
  - @scopebond/gateway@0.17.1
  - @scopebond/verify@0.6.1

## 0.5.8

### Patch Changes

- Updated dependencies [cb4d4e0]
- Updated dependencies [e343292]
- Updated dependencies [e0f2de4]
- Updated dependencies [ce7728c]
- Updated dependencies [c877e45]
- Updated dependencies [d4b34d8]
  - @scopebond/policy-schema@0.7.0
  - @scopebond/gateway@0.17.0
  - @scopebond/verify@0.6.0

## 0.5.7

### Patch Changes

- Updated dependencies [40c1fb7]
  - @scopebond/gateway@0.16.0

## 0.5.6

### Patch Changes

- Updated dependencies [9fd79e2]
  - @scopebond/verify@0.5.0
  - @scopebond/gateway@0.15.0

## 0.5.5

### Patch Changes

- Updated dependencies [c4514ca]
- Updated dependencies [7736223]
- Updated dependencies [8e42db0]
- Updated dependencies [2a9b060]
- Updated dependencies [6c3b253]
  - @scopebond/gateway@0.14.0

## 0.5.4

### Patch Changes

- Updated dependencies [433c8df]
  - @scopebond/gateway@0.13.0
  - @scopebond/policy-schema@0.6.0
  - @scopebond/verify@0.4.3

## 0.5.3

### Patch Changes

- Updated dependencies [3308250]
  - @scopebond/gateway@0.12.0

## 0.5.2

### Patch Changes

- Updated dependencies [6e61a3b]
  - @scopebond/gateway@0.11.0

## 0.5.1

### Patch Changes

- Updated dependencies [1b8be99]
  - @scopebond/gateway@0.10.0

## 0.5.0

### Minor Changes

- d5ba4cb: Optional `evidence-out` input and `--evidence-out` flag. Writes JSON with the exact pull request head commit, the policy digest, the boundary receipt hash when one was signed, the check result and the run ids, for a workspace collector that has registered the runner. The document states it is not independent and carries no key, source text or path list.

### Patch Changes

- Updated dependencies [b65261d]
- Updated dependencies [b08c8df]
- Updated dependencies [b08c8df]
- Updated dependencies [7c6fa19]
- Updated dependencies [aac4f6f]
  - @scopebond/gateway@0.9.0
  - @scopebond/policy-schema@0.5.0
  - @scopebond/verify@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [978e7a3]
- Updated dependencies [978e7a3]
  - @scopebond/gateway@0.8.0
  - @scopebond/verify@0.4.1

## 0.4.0

### Minor Changes

- a42fc81: Security: evaluate the policy from the pull request's base commit, not the branch under review, so a pull request cannot loosen the policy it is checked against. The changed-file list now comes from the pull request API (including renamed files' old names) with a merge-base fallback, and the check fails closed when neither yields paths or when fewer paths than the PR's `changed_files` were resolved (the files API stops at 3000 files). The README example now runs on `pull_request_target` with a base-only checkout, so a pull request cannot edit the workflow that checks it. `--policy-source workspace` remains for local testing.

### Patch Changes

- Updated dependencies [df4fc67]
- Updated dependencies [df4fc67]
- Updated dependencies [f2e4d62]
- Updated dependencies [792c40f]
- Updated dependencies [5329932]
- Updated dependencies [a488918]
  - @scopebond/gateway@0.7.0
  - @scopebond/verify@0.4.0
  - @scopebond/policy-schema@0.4.1

## 0.3.1

### Patch Changes

- Updated dependencies [f212f82]
- Updated dependencies [7343f01]
  - @scopebond/policy-schema@0.4.0
  - @scopebond/verify@0.3.0
  - @scopebond/gateway@0.6.1

## 0.3.0

### Minor Changes

- 5d5724a: Connector hardening (SB68).

  - **github-action:** `claude[bot]` and `github-actions[bot]` are now governed
    coding-agent actors (a repo can still narrow the set via `agentActors`), and a
    pull request is evaluated at a real timestamp (injectable via a `now` option)
    instead of epoch 0, so `time_window` clauses actually bind.
  - **framework:** `guardedTool` (and `wrapOpenAITools`) now throw when a tool has no
    `execute` function instead of returning it unguarded — a silent passthrough on an
    unrecognized tool shape (for example an already-constructed OpenAI Agents tool that
    exposes only `invoke`) would let a tool run with no policy check. Wrap the tool
    _definition_'s `execute` before constructing the tool, or use `guardExecute`.

### Patch Changes

- Updated dependencies [4dd6919]
  - @scopebond/gateway@0.6.0

## 0.2.0

### Minor Changes

- 973507f: Add signed boundary receipts. The evidence contract gains a `boundary` authorization mode — a clean representation for a receipt with **no agent signature**, where a gate attested a consequence and the identity is the receipt's boundary attribution (previously a boundary receipt would have had to misuse `insecure_development`). `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildBoundaryReceipt(input, attester)` — a reusable builder for any boundary-lane connector that constructs and signs a `boundary`-class receipt (gate, outcome_ref, attribution, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`).

  `@scopebond/github-action` uses it: with a signing key configured (`SCOPEBOND_ATTESTER_KEY`), the PR check emits a signed boundary receipt per PR head, verifiable offline, signed with the customer's own key in their runner. A `not_evaluated` (human) pull request emits none.

- 451ef6d: Add optional Cloud export to `scopebond-verify-pr`. When `SCOPEBOND_CLOUD_URL` and `SCOPEBOND_CLOUD_CREDENTIAL` are set (alongside `SCOPEBOND_ATTESTER_KEY`), the runner POSTs the signed boundary receipt for a governed-agent PR to the workspace's `/v1/ingest`, so agent PRs show in the hosted portal. Export is best-effort — a Cloud outage never fails the required check, which already gated the merge — and no receipt is sent for a `not_evaluated` (human) PR. The composite `action.yml` gains a `workspace-url` input. This is the Actions-runner receipt-export path; the GitHub App's Cloud webhook/check-run route remains separate.
- 3d3606f: Add `@scopebond/github-action` — the GitHub connector's boundary-lane runner (a leaf package; no GitHub SDK, no Scopebond-held credential). It checks an agent pull request against policy in the customer's own Actions runner before it can merge (ADR-011 §2 / D33 — enforcement stays customer-side).

  - The pure `evaluatePullRequest(ctx, policy)` maps a PR to the taxonomy `pr.merge` action and decides it with `@scopebond/verify`. A governed-agent PR that violates policy is `deny` (the check fails, blocking the merge); a human author and non-pull-request events are `not_evaluated` (never blocked). Attribution is asserted from the agent bot login (Copilot, Devin, Jules, Codex, Cursor; extendable).
  - Path policy uses the D67 element-wise array bound: `{ paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } }` denies a PR touching `infra/prod/**`.
  - `scopebond-verify-pr` reads the `pull_request` event, the changed paths and the policy, and exits non-zero to fail the required status check on a deny. It fails closed on a bad policy or when a changed PR yields no resolvable paths. A composite `action.yml` and a workflow recipe install it as a required check.
  - Conformance vector (agent prod-path PR fails, docs PR passes, human PR not evaluated, non-PR event not evaluated, fail-closed) plus CLI subprocess tests.

  The signed **boundary receipt** per PR head (the `boundary` evidence class), the Cloud webhook/check-run posting, deploy gating via OIDC and the Marketplace listing are added in following increments.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [c0d81f6]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [0cb916f]
- Updated dependencies [c17c1fb]
- Updated dependencies [1fd3470]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/verify@0.2.0
  - @scopebond/gateway@0.5.0
