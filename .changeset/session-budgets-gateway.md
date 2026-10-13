---
"@scopebond/gateway": minor
---

`handleAction(req, { budget })` signs a session budget's decision into the receipt as the optional `payload.budget`
(`ReceiptBudget`), checked by the new `validateReceiptBudget` (`RECEIPT_BUDGET_KEYS`); the gateway refuses to sign an
invalid one, and `verifyReceipt` / `validateEvidencePayload` accept a valid one. Receipts made without one are unchanged.
