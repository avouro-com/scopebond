# @scopebond/github-action

**License and hosting:** this package is free, Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service
and is not included in this package.

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
on: pull_request_target        # runs the workflow as it is on the base branch
permissions:
  contents: read
  pull-requests: read
jobs:
  scopebond:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}   # the BASE commit only; never the PR head
          fetch-depth: 0
      - uses: avouro-com/scopebond/packages/github-action@main  # or pin a full commit SHA
        with:
          policy: scopebond.policy.json
```

Why `pull_request_target` with a base checkout: under `on: pull_request` the
workflow file itself comes from the pull request, so an agent's PR could edit or
delete the very workflow that checks it. Under `pull_request_target` GitHub runs the
workflow (and this action's pin) from the base branch. The job checks out only the
base commit and never runs code from the PR: the changed-file list comes from the
pull-request API, and the policy is read from the base commit. Do not add steps that
check out or execute the PR head in this job — `pull_request_target` runs with the
base repository's token.

A governed-agent PR that violates the policy fails the check (blocking the merge);
a human PR and non-pull-request events are **not evaluated** (never blocked). The
governed-agent actors are the known coding-agent bots (Copilot, Devin, Jules,
Codex, Cursor, Claude, and `github-actions[bot]` when an agent runs inside a
workflow); to govern another actor, call `evaluatePullRequest` from your own script.

The policy is read from the pull request’s **base commit**, not from the branch
under review, so a pull request cannot loosen the policy it is checked against: a PR
that adds or edits `scopebond.policy.json` is checked against the policy already on
the base branch. Merge policy changes through a reviewed (human) pull request first.
The changed-file list comes from the pull request API (including the old name of a
renamed file), falling back to a merge-base diff; if neither yields the full list —
no paths, or fewer listed files than the PR's `changed_files` (the API stops at 3000
files) — the check fails closed. Files are counted per entry, never per line, and a
path that contains a control character (a newline, for example) fails the check
closed.

**What code runs.** The check step installs `@scopebond/github-action` at the
version this action's own `package.json` names (unless you set the `version` input),
so pinning the action to a full commit SHA also pins the checking code. It installs
into the runner's temp directory with lifecycle scripts off, so a `node_modules` or
`.npmrc` in the checked-out workspace cannot choose the code, and inputs reach the
script through environment variables, never template expansion. A `version` older
than the action may not read the file list the action writes and then fails closed.

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
      - uses: avouro-com/scopebond/packages/github-action@main  # or pin a full commit SHA
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

## Mirror receipts to your workspace (optional)

Set `workspace-url` and a machine credential (from the portal's Connect step,
stored as a repository secret) to POST the boundary receipt to your workspace so
agent PRs show in the hosted portal. Export is **best-effort** — a Cloud outage
never fails the required check, which already gated the merge:

```yaml
      - uses: avouro-com/scopebond/packages/github-action@main  # or pin a full commit SHA
        with:
          policy: scopebond.policy.json
          workspace-url: https://your-workspace.example
        env:
          SCOPEBOND_ATTESTER_KEY: ${{ secrets.SCOPEBOND_ATTESTER_KEY }}
          SCOPEBOND_CLOUD_CREDENTIAL: ${{ secrets.SCOPEBOND_CLOUD_CREDENTIAL }}
```

## Evidence for a workspace collector (optional)

Set `evidence-out` (or `--evidence-out <file>`) to write JSON naming the exact head commit this run
checked, the SHA-256 of the policy it checked against, the hash of the boundary receipt when one was
signed, the check result (`success`, `failure`, `neutral`) and the run and workflow ids. The path is
also the `evidence-path` output. It is written for a deny too, before the check fails.

This is a report from your own runner, not an independent verification: the document says
`"independent": false`, and a collector decides whether to trust it by whether the run came from a runner
class it has registered. It holds no key or source text, and no list of paths.

## Not in this release

The GitHub App's Cloud-side webhook/check-run posting (identity linking + the
Cloud fallback evaluation), deploy gating via OIDC, the admin-bypass record, and
the GitHub Marketplace listing.

Experimental alpha; controlled test use only.
