---
"@scopebond/framework": minor
---

Add optional Cloud export to `@scopebond/framework`. `connectCloud(attesterKeyPem, url, bundle)` enrolls the guard's countersigning key with a workspace; passing the resulting connection as `createToolGuard({ cloud: { connection } })` mirrors every signed-intent receipt to the hosted portal through a bounded outbox (in-memory by default; pass a durable `outbox` to survive restarts). `ToolGuard` gains `flush()` and `stop()`. New exports: `connectCloud`, `FrameworkConnection`.
