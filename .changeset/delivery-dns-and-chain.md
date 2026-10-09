---
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
"@scopebond/verify": patch
"@scopebond/mcp": patch
---

A recorded wait the workspace asked for (429, or 503 with Retry-After) never holds delivery more than an hour and five minutes after it was recorded, and a clock that jumps no longer extends it; a host name that does not resolve is recorded as failed, not as an unknown outcome; a scoped link-local IPv6 address from the resolver is compared without its zone index; the chain-head check no longer reports a rollback after a clock step back or across computers sharing one folder; and the MCP proxy's session history is bounded in calls and bytes.
