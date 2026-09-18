---
"@scopebond/gateway": minor
---

`buildPepReceipt` and `buildBoundaryReceipt` now set a deterministic `action_ref.action_id`, so PEP-authorized and boundary receipts carry the idempotency key the durable Cloud outbox and the ingest use. Boundary receipts key on `(gate, outcome_ref, intent)` (re-evaluating the same PR head dedupes); PEP receipts key on `(intent, timestamp, principal)` (unique per authorized call, deterministic under an injected clock). Without this, those receipt classes could not be enqueued for export.
