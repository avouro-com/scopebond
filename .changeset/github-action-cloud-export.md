---
"@scopebond/github-action": minor
---

Add optional Cloud export to `scopebond-verify-pr`. When `SCOPEBOND_CLOUD_URL` and `SCOPEBOND_CLOUD_CREDENTIAL` are set (alongside `SCOPEBOND_ATTESTER_KEY`), the runner POSTs the signed boundary receipt for a governed-agent PR to the workspace's `/v1/ingest`, so agent PRs show in the hosted portal. Export is best-effort — a Cloud outage never fails the required check, which already gated the merge — and no receipt is sent for a `not_evaluated` (human) PR. The composite `action.yml` gains a `workspace-url` input. This is the Actions-runner receipt-export path; the GitHub App's Cloud webhook/check-run route remains separate.
