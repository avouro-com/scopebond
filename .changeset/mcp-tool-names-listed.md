---
"@scopebond/mcp": patch
---

A `tools/call` is now forwarded only under a name that is exactly one tool of the upstream server's own tool list: the last full `tools/list` the client fetched, or one the proxy reads from the upstream itself (again after the recheck interval, a minute by default, or when a call names a tool the list lacks). An upstream that resolves tool names loosely (another case, a full-width form) could otherwise run a tool a rule denies by its exact name. A call is denied when its name is not listed, when it is another spelling of a listed tool (case and width folded as member names are), when the upstream lists two tools whose names differ only in case or width, and while no tool list can be read from the upstream. An upstream that does not answer `tools/list` therefore has every call denied.
