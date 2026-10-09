---
"@scopebond/mcp": patch
---

A `tools/call` whose tool name is an object with its own `toString` key is decided instead of failing with an error, a failed reply write can no longer surface as an unhandled rejection in the stdio proxy, and `mapMcpToolCall` returns precisely typed params.
