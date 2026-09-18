---
"@scopebond/github-action": minor
---

Add `@scopebond/github-action` — the GitHub connector's boundary-lane runner (a leaf package; no GitHub SDK, no Scopebond-held credential). It checks an agent pull request against policy in the customer's own Actions runner before it can merge (ADR-011 §2 / D33 — enforcement stays customer-side).

- The pure `evaluatePullRequest(ctx, policy)` maps a PR to the taxonomy `pr.merge` action and decides it with `@scopebond/verify`. A governed-agent PR that violates policy is `deny` (the check fails, blocking the merge); a human author and non-pull-request events are `not_evaluated` (never blocked). Attribution is asserted from the agent bot login (Copilot, Devin, Jules, Codex, Cursor; extendable).
- Path policy uses the D67 element-wise array bound: `{ paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } }` denies a PR touching `infra/prod/**`.
- `scopebond-verify-pr` reads the `pull_request` event, the changed paths and the policy, and exits non-zero to fail the required status check on a deny. It fails closed on a bad policy or when a changed PR yields no resolvable paths. A composite `action.yml` and a workflow recipe install it as a required check.
- Conformance vector (agent prod-path PR fails, docs PR passes, human PR not evaluated, non-PR event not evaluated, fail-closed) plus CLI subprocess tests.

The signed **boundary receipt** per PR head (the `boundary` evidence class), the Cloud webhook/check-run posting, deploy gating via OIDC and the Marketplace listing are added in following increments.
