---
"@scopebond/framework": patch
---

`wrapVercelTools` throws on a tool with no `execute`, like `guardedTool`, instead of passing it through unchecked. `wrapLangGraphTool` now guards every entry point the tool has (`invoke`, `call`, `_call`, `func`, `stream`, `batch`), not only `invoke`.
