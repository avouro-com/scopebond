---
"@scopebond/verify": minor
"@scopebond/gateway": minor
"@scopebond/hook": patch
---

A tool call no longer gets slower as the receipt log grows. Each decision reads only the history its policy can see: none for allowlists and guards (the coding-agent starter policies), and only the longest window or sequence gap for `rate_limit`, `spend_limit` and `sequence`. At 10,000 stored receipts a starter-policy decision went from more than 60 ms to under 1 ms, and it stays flat as the log grows. Decisions are unchanged; the tests check every conformance vector, every verdict test and randomized histories with and without the bound.

New in `@scopebond/verify`: `historyNeed(policy)` and `boundPrior(need, receipts, at)`, which define the bounded set exactly; a live verdict's `inputs_hash` commits to that set. New in `@scopebond/gateway`: `ReceiptStore.executed(scope)` and `reserveAction(…, scope)` take an optional `PriorScope`, and `SqliteReceiptStore` adds an index on `receipts.timestamp` when it opens. A store that ignores `scope` stays correct, only slower.
