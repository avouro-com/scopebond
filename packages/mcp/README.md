# @scopebond/mcp

**License and hosting:** this package is free, Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service
and is not included in this package.

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

Install the free open-source proxy with a current Node.js LTS release:

```bash
npm install -g @scopebond/mcp@latest
```

Point your MCP client at `scopebond-mcp` and give it the real server after `--`:

```
scopebond-mcp --server filesystem --policy scopebond.policy.json --key scopebond-agent.key \
  -- npx -y @modelcontextprotocol/server-filesystem /path/to/workspace
```

`tools/call` is checked; everything else (`initialize`, `tools/list`, …) passes
through. A denial returns a JSON-RPC error to the client and is never sent
upstream. Set `--receipts log.jsonl` to keep the signed receipts locally.

**Ceiling.** The proxy governs **tool invocations** (`tools/call`). It does not
gate resource reads (`resources/read`) or prompt fetches (`prompts/get`), which
pass through — so a server that exposes data as resources rather than tools is not
covered by a tool policy. Govern such data at the server, or front only servers
whose sensitive operations are tools.

## Typed adapter (optional, off by default)

`--typed typed.json` adds an adapter that describes each `tools/call` from the request the proxy actually
forwards (the proxy digests and dispatches one private copy of the message) and can refuse what it cannot
bind before anything reaches the upstream:

```json
{
  "mode": "enforce",
  "requireResourceBinding": true,
  "approvedResources": { "repository": ["acme/widgets"] },
  "manifest": {
    "hash": "sha256:…",
    "tools": {
      "get_issue": { "operation_class": "read_only", "resources": [{ "arg": "repository", "kind": "repository" }] },
      "delete_branch": { "operation_class": "mutation", "resources": [{ "arg": "repository", "kind": "repository" }] }
    }
  }
}
```

- `manifest.hash` pins the server's tool list (`manifestHash(tools)`). The proxy reads the live list (from the
  client's own `tools/list` or by asking the upstream) and treats the manifest as valid only while it still
  hashes to the pin; a changed server is `unverified` and every tool on it is `unknown`.
- Under `enforce`, an unknown tool or revision is denied. Under `monitor` (use it to start) nothing is denied
  and unknowns are recorded as unknown.
- A manifest says what a tool is, not which resource a call touches, so it cannot authorize a resource-specific
  call on its own. With `requireResourceBinding`, a mutation, or a tool that names resources, is denied
  unless every resource named at its argument paths was read from the dispatched arguments and is in
  `approvedResources` for its kind.
- When the hook is installed and enrolled for observations (`--observations-dir` or `SCOPEBOND_HOOK_DIR`), a
  `tool_intent` (before dispatch, also for a denied call) and a `tool_outcome` (after a forwarded call) go to its
  outbox as a closed `mcp` operation: server, tool, manifest revision, operation class, keyed resource ids and an
  HMAC request digest under the hook's installation-local key. Without the hook the adapter still runs with a
  local binding key beside your signing key and nothing is queued. The library takes any sink with an
  `emit(draft)` method, so no vendor SDK is involved.

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
