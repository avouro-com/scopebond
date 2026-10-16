---
"@scopebond/mcp": patch
---

The MCP proxy refuses JSON-RPC members spelled in another case. A message with a member that folds to a JSON-RPC member without being spelled exactly like it (`Method`, `Params`, `Id`; Unicode simple folding, so `ſ` counts as `s` and the Kelvin sign as `k`), or `tools/call` params with another spelling of `name`, `arguments` or `_meta`, is answered with `-32600` and never forwarded: an upstream that matches member names case-insensitively, such as one decoding with Go's `encoding/json`, could otherwise run a tool or method other than the one decided. What is forwarded is rebuilt from the JSON-RPC members the proxy read (and for `tools/call`, params `name`, `arguments` and `_meta`). Under the typed adapter, arguments holding two keys that differ only in case, at any depth, or a resource argument spelled in another case, are not bound and are denied in `enforce` mode.
