---
"@scopebond/policy-schema": minor
---

Records now carry an optional `context` saying where they were produced, so a workspace can group them by session and
filter them by tool, model and repository. `schema/receipt.schema.json` adds `payload.context`: a closed object of
`harness`, `harness_version`, `model`, `session_id`, `repository` (the git remote `origin` as `host/owner/name`) and
`branch`, each optional and nullable. It carries no local paths, no credentials and no prompts, and the signature covers it. A
receipt without it is unchanged; an unknown key inside it makes the receipt invalid. New: `RECEIPT_CONTEXT_KEYS`, the
`receipt_context` cases in `vectors/evidence-contract.json` and a canonicalization vector for a context member.

Compatibility: A receipt check older than this release (`@scopebond/gateway` `verifyReceipt` and `validateEvidencePayload` before this version, `npx @scopebond/gateway verify`, or an earlier hook's `scopebond verify`) reports a receipt that carries `context` as invalid, because the payload's key list is closed; `evidence_version` stays `1.0`. Verify such receipts with a release that knows `context`. (`@scopebond/verify`'s `verifyReceiptSignature` checks only the signature and key binding, so it verifies them in any version.)
