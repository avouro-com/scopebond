---
"@scopebond/mcp": patch
---

Rate limits, sequence gaps and spend windows now hold for tool calls that arrive together (parallel or pipelined requests), and identical calls in the same millisecond count separately. A method that spells `tools/call` or `tools/list` another way is refused instead of passed through.
