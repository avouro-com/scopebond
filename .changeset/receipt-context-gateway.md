---
"@scopebond/gateway": minor
---

Records now carry an optional `context` saying where they were produced. `handleAction(req, { context })` and
`observeAction(req, { context })` sign it into the receipt as `payload.context` (harness, harness version, model, session
id, repository and branch; each a string or null). `verifyReceipt` and `validateEvidencePayload` accept it, and an
unknown key inside it makes the receipt invalid like any other unknown key; the gateway refuses to sign a context that is
not valid. Receipts made without one are unchanged. New exports: `ReceiptPayloadContext`, `validateReceiptContext`,
`RECEIPT_CONTEXT_KEYS` and `ObserveOptions`.
