---
"@scopebond/hook": minor
---

Records now carry an optional `context` saying where they were produced: the coding agent (`claude`, `cursor` or
`codex`), its version when it reports one (Cursor), the model when the hook input names it, the same keyed session id
the observations carry (never the agent's own session id), the git remote `origin` as `host/owner/name` (no credentials,
no `.git`, never a local path, a machine name, an IP address or a server folder) and the branch. `log` shows it after each action, and `verify` checks it with the rest of
the receipt.

A computer that is not connected always records it. A connected computer adds it only once its workspace says it reads
it: the rules check or a delivery answer carries the header `x-scopebond-receipt-context: 1`, kept as `receipt_context`
in the rules state. A full rules check answer without the header turns it off again, so a workspace that does not read
the context is never sent it. Signing in to a workspace forgets what the previous one said and checks the rules at once;
only an accepted delivery answer counts.

Compatibility: A receipt check older than this release (`@scopebond/gateway` `verifyReceipt` and `validateEvidencePayload` before this version, `npx @scopebond/gateway verify`, or an earlier hook's `scopebond verify`) reports a receipt that carries `context` as invalid, because the payload's key list is closed; `evidence_version` stays `1.0`. Verify such receipts with a release that knows `context`. (`@scopebond/verify`'s `verifyReceiptSignature` checks only the signature and key binding, so it verifies them in any version.)
