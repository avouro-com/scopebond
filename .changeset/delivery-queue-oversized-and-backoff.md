---
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
---

Delivery no longer stalls behind a record the workspace will never accept, and it honours a workspace that asks a computer to wait. A record over the workspace's size limit (one long URL or one large tool argument) used to be re-sent at the head of every batch and hold every newer record back for good; now large records travel alone, a batch refused for its size is split, and a record refused on its own for its size leaves the queue as an `oversize` gap (shown in `status`, `status --json` and `doctor`, reported to the workspace with the other gaps, and kept in the local log). A refused batch listing records refused for good beside records kept back (a clock ahead, a key not yet enrolled) now settles the first and keeps the second. A 429, or a 503 with Retry-After, is now honoured across hook calls and agent cycles: the wait (at most an hour plus a small random spread; a 429 without Retry-After starts at 30 seconds and doubles) is kept in `delivery.json`, `status` shows the next try, and `status --json` adds `delivery.backoff_until`.
