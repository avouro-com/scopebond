---
"@scopebond/mcp": minor
---

Optional dispatch boundary (`--dispatch-dir`, `--delegation`, off by default). Each `tools/call` that policy allows is checked for its single-use approval (bound to the exact request forwarded), its delegated scope and its action-budget slot immediately before it is forwarded; otherwise it is answered with an error and never sent upstream. A retry of the same JSON-RPC request does not use a second slot.
