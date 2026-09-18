# @scopebond/mcp

The Scopebond **MCP proxy** — one policy for every Model Context Protocol tool
call, in front of the servers an agent uses. It sits in-path between an MCP client
and an upstream server, checks each `tools/call` against your policy before it is
forwarded, and records a signed **PEP-authorized receipt**. A denied call is never
forwarded.

- **Label:** in-path · prevents. The proxy decides the caller's request (no agent
  signature), so its receipts are `pep_authorized` — the identity is the
  configured principal, and the receipt attests that the proxy authorized the
  call, never that an agent signed it.

## Use it

Point your MCP client at `scopebond-mcp` and give it the real server after `--`:

```
scopebond-mcp --server filesystem --policy scopebond.policy.json --key scopebond-agent.key \
  -- npx -y @modelcontextprotocol/server-filesystem /path/to/workspace
```

`tools/call` is checked; everything else (`initialize`, `tools/list`, …) passes
through. A denial returns a JSON-RPC error to the client and is never sent
upstream. Set `--receipts log.jsonl` to keep the signed receipts locally.

## Policy

Bound MCP calls with the Action Taxonomy's `mcp.tool.call` type — "read-only
filesystem tools only":

```json
{
  "vocabulary_version": "1.0", "policy_id": "mcp", "version": 1,
  "clauses": [
    { "id": "fs", "type": "action_allowlist", "mode": "enforce",
      "action_types": ["mcp.tool.call"],
      "param_bounds": { "server": { "enum": ["filesystem"] }, "tool": { "pattern": "^(?!delete_|write_).+" } } }
  ]
}
```

## Library

The proxy core is exported and transport-agnostic:

```js
import { createMcpProxy, mapMcpToolCall } from "@scopebond/mcp";
```

`createMcpProxy({ policy, principal, server, attesterKeyPem, upstream })` returns
`{ handle(message) }`; inject `upstream` to test the decision path without a real
server.

Experimental alpha; controlled test use only.
