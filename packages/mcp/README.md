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

A receipt never holds the tool's arguments, only `args_digest`: an HMAC-SHA-256
(`hmac-sha256:…`) under a local key that never leaves the computer. The CLI uses the
hook's per-machine digest key when `--observations-dir` names the hook's folder, and
otherwise the key file beside your signing key (`<key>.binding`, made on first use).
A short argument (a one-time code, a password) cannot be confirmed by hashing guesses.

When the proxy is connected to a workspace, receipts wait for delivery in a durable
queue beside the key (`<key>.cloud-outbox.db`) with no cap and no expiry, so an
outage delays them instead of dropping them. A record the queue could not keep is
recorded there and reported on stderr.

A JSON-RPC batch (an array of messages on one line) is rejected with a `-32600`
error and never forwarded, so every call is decided on its own. So is a method
that spells `tools/call` or `tools/list` another way (`Tools/Call`,
`tools/call `), which an upstream that matches method names loosely could
otherwise run without a decision.

Windowed clauses (`rate_limit`, `sequence`, a windowed `spend_limit`) hold for
calls that arrive together: a call policy allows takes its place in the window
as it is decided, so with a limit of 2 and ten parallel calls, two are forwarded.
The proxy keeps only the calls its policy can read: none for a policy without
windowed clauses, and the calls inside the longest window otherwise, so a
long-running proxy does not slow down or grow with every call it has made.

**Upstream environment.** The upstream server starts with a minimal environment
(`PATH`, `HOME`/`USERPROFILE`, the temp and system directories, locale), not the
proxy's whole environment. Pass anything else it needs explicitly, for example a
token the server reads:

```
scopebond-mcp --server github --env GITHUB_PERSONAL_ACCESS_TOKEN -- npx -y @modelcontextprotocol/server-github
```

`--env NAME` copies the variable from the proxy's environment and `--env NAME=value`
sets it; repeat it as needed, or list names in `SCOPEBOND_MCP_UPSTREAM_ENV`
(comma-separated).

**Limits.** A JSON-RPC line over 8 MiB from either side is dropped, never relayed.
A request the upstream has not answered within `--timeout-ms` (default 120000,
or `SCOPEBOND_MCP_TIMEOUT_MS`) fails closed with a JSON-RPC error.

**Same-user limit.** The upstream runs as the same OS user as the proxy, so it can
read any file the proxy can, including the signing key (`scopebond-agent.key`) and
a stored Cloud credential (`*.cloud.json`). The proxy decides what is forwarded; it
does not sandbox the server. Run an untrusted server as a different user or in a
container.

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

- The file is checked when the proxy starts, and one of any other shape is refused: `approvedResources` is an object
  of string lists (a value is approved only when it is one of them, exactly), each tool's `operation_class` is
  `read_only` or `mutation`, `resources` is a list of `{ "arg", "kind" }`, and `requireResourceBinding` is a boolean.
  `typedConfigProblem(config)` runs the same check in the library.
- `manifest.hash` pins the server's tool list (`manifestHash(tools)`). The proxy reads the live list (from the
  client's own `tools/list`, hashed across every page the client fetches, or by asking the upstream) and treats
  the manifest as valid only while it still hashes to the pin; a changed server is `unverified` and every tool
  on it is `unknown`. Once a full list that differs from the pin has been seen, the server stays `unverified`
  until the proxy restarts, and while a client's paginated listing is incomplete the manifest is not trusted.
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

Bound MCP calls with the Action Taxonomy's `mcp.tool.call` type. This example
allows only filesystem tools whose names mark them read-only, and denies every
other tool (including `write_file`, `edit_file`, `move_file` and
`create_directory`):

```json
{
  "vocabulary_version": "1.0", "policy_id": "mcp", "version": 1,
  "clauses": [
    { "id": "fs", "type": "action_allowlist", "mode": "enforce",
      "action_types": ["mcp.tool.call"],
      "param_bounds": { "server": { "enum": ["filesystem"] }, "tool": { "pattern": "^(read|list|get|search)_[A-Za-z0-9_]+$" } } }
  ]
}
```

List what a tool may do, not what it may not: a denylist of names such as
`delete_` or `write_` still allows any mutating tool named some other way. A name
is a convention, not a guarantee, so review the server's `tools/list` and extend
the pattern (or name tools one by one) for what you allow. `scopebond-mcp init`
writes a starter policy of the same shape.

## Library

The proxy core is exported and transport-agnostic:

```js
import { createMcpProxy, mapMcpToolCall } from "@scopebond/mcp";
```

`createMcpProxy({ policy, principal, server, attesterKeyPem, upstream })` returns
`{ handle(message) }`; inject `upstream` to test the decision path without a real
server.

Experimental alpha; controlled test use only.
