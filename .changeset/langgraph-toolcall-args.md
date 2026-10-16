---
"@scopebond/framework": patch
---

`wrapLangGraphTool` checks the arguments a tool actually runs with. A LangGraph ToolCall input (`{ name, args, id, type: "tool_call" }`, which `ToolNode` passes to every tool) was checked as if the envelope were the arguments, so clauses that read parameters, such as a spend limit, did not see the amount. The guard now checks `args`, after the tool's own zod schema parsing, on `invoke`, `call`, `stream` and `batch`, and denies a ToolCall that names a different tool.
