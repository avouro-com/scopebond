---
"@scopebond/gateway": patch
"@scopebond/mcp": patch
---

The self-hosted gateway now listens on 127.0.0.1 unless `HOST` is set, keeps reloading a policy or key registry file that is replaced by rename (a revoked key takes effect without a restart), and refuses a `/v1/resume` that does not name what it lifts. The HTTP and refund executors bound response size and time, and refuse a call they cannot send with 400 before it is charged. The Workers KV store no longer loses or drops receipts or accepts one authorization twice, public anchor proofs no longer re-read the whole log, a non-numeric `approval_max_lifetime_seconds` is refused, and the MCP proxy keeps only the history its policy can read.
