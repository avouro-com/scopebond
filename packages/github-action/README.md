# @scopebond/github-action

The Scopebond connector for **GitHub** — check every pull request an AI agent
opens against your policy *before it can merge*, in your own Actions runner, with
no Scopebond-held credential and no GitHub SDK.

- **Label:** boundary · stops the consequence. Scopebond cannot see or stop what a
  sandboxed cloud agent does inside its sandbox; it can stop the **merge**, and it
  attests what was allowed or blocked. A repository that does not require the check,
  or an actor with ruleset bypass rights, is not gated.

## Use it

Add the check to a workflow and make it a **required status check** in your ruleset:

```yaml
# .github/workflows/scopebond-policy.yml
name: Scopebond policy
on: pull_request
jobs:
  scopebond:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: avouro-com/scopebond/packages/github-action@v1
        with:
          policy: scopebond.policy.json
```

A governed-agent PR that violates the policy fails the check (blocking the merge);
a human PR and non-pull-request events are **not evaluated** (never blocked). The
governed-agent actors are the known coding-agent bots (Copilot, Devin, Jules,
Codex, Cursor); extend the set in code via `evaluatePullRequest`.

## Policy

Path policy uses the Action Taxonomy's `pr.merge` type with an array bound —
"agents may not touch production paths":

```json
{
  "vocabulary_version": "1.0", "policy_id": "github", "version": 1,
  "clauses": [
    { "id": "no-prod-paths", "type": "action_allowlist", "mode": "enforce",
      "action_types": ["pr.merge"],
      "param_bounds": { "paths": { "items": { "pattern": "^(?!infra/prod/).*" }, "match": "all" } } }
  ]
}
```

## Library

The evaluation core is exported and pure:

```js
import { evaluatePullRequest, mapPullRequest } from "@scopebond/github-action";
```

`evaluatePullRequest(ctx, policy)` returns `{ decision, reason, ruleIds, attribution, outcomeRef }`.

## Signed receipts

Set a signing key (a repository secret) to emit a signed **boundary receipt** per
PR head — the verdict, the gate, the attributed agent and the pinned policy, in
the `boundary` evidence class:

```yaml
      - uses: avouro-com/scopebond/packages/github-action@v1
        with:
          policy: scopebond.policy.json
        env:
          SCOPEBOND_ATTESTER_KEY: ${{ secrets.SCOPEBOND_ATTESTER_KEY }}
          SCOPEBOND_RECEIPT_OUT: scopebond-receipt.json
```

The receipt is signed with your own key in your own runner (Scopebond holds no
key), records `boundary` — never that the agent's sandbox action was prevented or
signed — and verifies offline like any `scopebond:receipt`. A `not_evaluated`
(human) PR emits none.

## Not in this release

Cloud-side webhook/check-run posting, deploy gating via OIDC, the admin-bypass
record, and the GitHub Marketplace listing.

Experimental alpha; controlled test use only.
