---
"@scopebond/framework": patch
---

Tool arguments in a guard's receipts now have credential shapes scrubbed inside their values (a token in a URL query, a SQL password literal, a Bearer header in a command, and more) before the receipt is signed and sent to Cloud; `asset`, `amount` and `currency` stay in clear. The README documents what a receipt keeps of each field. New `cloud.outboxPath` opens a durable, lossless SQLite queue (no cap, no expiry; Node 22.5 or later) so waiting receipts survive a restart, and `cloud.onGap` reports any record the queue could not keep (a warning on stderr by default). Without `outboxPath` the queue stays in memory and bounded, and a record dropped at the bound now takes its sequence number first, so the workspace counts it as missing.
