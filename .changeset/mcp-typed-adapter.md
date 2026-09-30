---
"@scopebond/mcp": minor
---

Optional typed adapter (`--typed typed.json`, off by default). Each `tools/call` is described from the request actually forwarded: server, tool, a pinned manifest revision verified against the upstream's live tool list, read-only or mutation class, and resource ids read from the dispatched arguments, with an HMAC request digest under an installation-local key. Under `enforce` an unknown tool, a drifted server, or (with `requireResourceBinding`) a resource that cannot be bound or is not approved is denied before the upstream is invoked; under `monitor` nothing is denied. `tool_intent` and `tool_outcome` observations go to any sink with an `emit` method, including the hook's outbox when it is installed and enrolled.
