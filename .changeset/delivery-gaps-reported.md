---
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
---

Records that miss normal delivery are now kept, put right and reported.

- When a receipt is written locally but its delivery-queue write fails (the queue cannot be opened, or another process holds its lock), the action stays allowed and recorded on the computer as before. The miss is now noted, kept as an `outbox_error` gap on the next flush, and the receipt is queued then (every receipt written since the miss that the queue does not know yet, in log order). A tool call waits at most 2 seconds for the queue's lock, so an override wait plus a lock wait stays inside the coding agent's hook time limit; after an override wait, the local log also waits less for its lock. `flush` and the Scopebond Agent keep the longer wait.
- An evaluation stopped between its reservation and its receipt (a hook time limit, a crash) is closed after five minutes by the next hook call or the Scopebond Agent, with a signed receipt whose outcome is unknown (`execution.state: outcome_unknown`, reference `scopebond:evaluation-interrupted`, the policy's decision kept), queued like any other.
- The delivery queue keeps a lifetime count of gaps per reason (`status().gapsByReason`), beside the lifetime total; the gap rows themselves are still trimmed to the newest 10,000. `SqliteCloudOutbox` takes a `busyTimeoutMs` option and has `setBusyTimeout()` and `known()`; `SqliteReceiptStore` has `interruptedActions()`, `settleAction()`, `lastId()` and `setBusyTimeout()`.
- The rules check sends `x-scopebond-gaps-total` (the lifetime total) and `x-scopebond-gaps-by-reason` (compact JSON of reason code to count) when the queue has any gaps. `status` and `doctor` show a "delivery gaps" line, and `status --json` adds `delivery.gaps_total` and counts `delivery.gaps_by_reason` over the queue's lifetime.
- The status texts no longer say an unusable delivery queue blocks every action: actions stay allowed and recorded on the computer, and are sent once the queue can be written again.
