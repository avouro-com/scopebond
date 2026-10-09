# @scopebond/mcp

## 2.0.10

### Patch Changes

- a17f73b: A `tools/call` whose tool name is an object with its own `toString` key is decided instead of failing with an error, a failed reply write can no longer surface as an unhandled rejection in the stdio proxy, and `mapMcpToolCall` returns precisely typed params.
- Updated dependencies [611d02c]
- Updated dependencies [a17f73b]
  - @scopebond/gateway@0.17.5
  - @scopebond/verify@0.6.3

## 2.0.9

### Patch Changes

- 0225f33: The proxy's local binding key is now created exclusively with owner-only permissions (a damaged one is replaced atomically), and `init` writes the starter policy through an exclusive create when it is absent.
- Updated dependencies [0225f33]
  - @scopebond/gateway@0.17.3

## 2.0.8

### Patch Changes

- 0f7268b: `args_digest` on the proxy's receipts is now an HMAC-SHA-256 (`hmac-sha256:…`) of the tool arguments under a local key instead of a plain SHA-256, so a short argument cannot be confirmed offline from a receipt. The CLI keys it with the hook's per-machine digest key when `--observations-dir` names the hook's folder, else with the key file beside the signing key (`<key>.binding`, made on first use); the library takes `argsDigestKey` (64 hex) and exports `keyedArgsDigest`. The Cloud outbox is now lossless (no cap, no expiry, like the hook's and the agent's), and `openExporter` reports delivery gaps to an `onGap` option (stderr by default). Upgrade note: `args_digest` values change format, so they no longer match digests recorded by earlier versions.
- 88a6380: Harden the MCP proxy. A JSON-RPC batch, a non-object message or a non-string `method` is rejected with a -32600 error and never forwarded, in the library `handle` and in the stdio CLI. The manifest pin now hashes every page of the client's own `tools/list`, keeps the server unverified until restart once a full list that differs from the pin has been seen, treats an incomplete paginated listing as unverified, and gives its own probes random ids. The CLI starts the upstream with an allow-listed environment (pass anything else with the new repeatable `--env NAME[=value]` option or `SCOPEBOND_MCP_UPSTREAM_ENV`), drops JSON-RPC lines over 8 MiB, and fails a request closed when the upstream has not answered within `--timeout-ms` (default 120000). The starter policy written by `scopebond-mcp init` now allows only read-only tool names (read*, list*, get*, search*, describe*, view*) instead of denying a few mutating prefixes, and the README example and wording match. Upgrade note: an upstream server that reads a token from the environment now needs it passed with `--env`.
- Updated dependencies [258cdb6]
- Updated dependencies [d6996ad]
- Updated dependencies [7fc5efb]
- Updated dependencies [0f7268b]
  - @scopebond/gateway@0.17.1
  - @scopebond/verify@0.6.1

## 2.0.7

### Patch Changes

- Updated dependencies [cb4d4e0]
- Updated dependencies [e343292]
- Updated dependencies [e0f2de4]
- Updated dependencies [ce7728c]
- Updated dependencies [c877e45]
- Updated dependencies [d4b34d8]
  - @scopebond/policy-schema@0.7.0
  - @scopebond/gateway@0.17.0
  - @scopebond/verify@0.6.0

## 2.0.6

### Patch Changes

- Updated dependencies [40c1fb7]
  - @scopebond/gateway@0.16.0

## 2.0.5

### Patch Changes

- Updated dependencies [9fd79e2]
  - @scopebond/verify@0.5.0
  - @scopebond/gateway@0.15.0

## 2.0.4

### Patch Changes

- Updated dependencies [c4514ca]
- Updated dependencies [7736223]
- Updated dependencies [8e42db0]
- Updated dependencies [2a9b060]
- Updated dependencies [6c3b253]
  - @scopebond/gateway@0.14.0

## 2.0.3

### Patch Changes

- Updated dependencies [433c8df]
  - @scopebond/gateway@0.13.0
  - @scopebond/policy-schema@0.6.0
  - @scopebond/verify@0.4.3

## 2.0.2

### Patch Changes

- Updated dependencies [3308250]
  - @scopebond/gateway@0.12.0

## 2.0.1

### Patch Changes

- Updated dependencies [6e61a3b]
  - @scopebond/gateway@0.11.0

## 2.0.0

### Patch Changes

- Updated dependencies [0a30e9c]
- Updated dependencies [1b8be99]
- Updated dependencies [4242eda]
  - @scopebond/hook@0.11.0
  - @scopebond/gateway@0.10.0

## 1.0.0

### Patch Changes

- Updated dependencies [c37c604]
  - @scopebond/hook@0.10.0

## 0.4.0

### Minor Changes

- b65261d: Optional dispatch boundary (`--dispatch-dir`, `--delegation`, off by default). Each `tools/call` that policy allows is checked for its single-use approval (bound to the exact request forwarded), its delegated scope and its action-budget slot immediately before it is forwarded; otherwise it is answered with an error and never sent upstream. A retry of the same JSON-RPC request does not use a second slot.
- d5ba4cb: Optional typed adapter (`--typed typed.json`, off by default). Each `tools/call` is described from the request actually forwarded: server, tool, a pinned manifest revision verified against the upstream's live tool list, read-only or mutation class, and resource ids read from the dispatched arguments, with an HMAC request digest under an installation-local key. Under `enforce` an unknown tool, a drifted server, or (with `requireResourceBinding`) a resource that cannot be bound or is not approved is denied before the upstream is invoked; under `monitor` nothing is denied. `tool_intent` and `tool_outcome` observations go to any sink with an `emit` method, including the hook's outbox when it is installed and enrolled.

### Patch Changes

- b08c8df: The typed adapter adds `approval_request_hash` and the guard's target id as `resource_id` to its operation when the dispatch guard requires approval for MCP calls.
- 7c6fa19: The optional dispatch boundary also uses the workspace as an approval and delegation source when `cloud.json` beside `--dispatch-dir` grants `observations:write` (through the gateway's guard); local signed approvals and delegations work as before.
- Updated dependencies [b65261d]
- Updated dependencies [b65261d]
- Updated dependencies [b08c8df]
- Updated dependencies [b08c8df]
- Updated dependencies [b08c8df]
- Updated dependencies [7c6fa19]
- Updated dependencies [7c6fa19]
- Updated dependencies [aa4db1c]
- Updated dependencies [7ffed9c]
- Updated dependencies [5a86ea0]
- Updated dependencies [d5ba4cb]
- Updated dependencies [aac4f6f]
  - @scopebond/gateway@0.9.0
  - @scopebond/hook@0.9.0
  - @scopebond/policy-schema@0.5.0
  - @scopebond/verify@0.4.2

## 0.3.3

### Patch Changes

- Updated dependencies [978e7a3]
- Updated dependencies [978e7a3]
  - @scopebond/gateway@0.8.0
  - @scopebond/verify@0.4.1

## 0.3.2

### Patch Changes

- Updated dependencies [df4fc67]
- Updated dependencies [df4fc67]
- Updated dependencies [f2e4d62]
- Updated dependencies [792c40f]
- Updated dependencies [5329932]
- Updated dependencies [a488918]
  - @scopebond/gateway@0.7.0
  - @scopebond/verify@0.4.0
  - @scopebond/policy-schema@0.4.1

## 0.3.1

### Patch Changes

- Updated dependencies [f212f82]
- Updated dependencies [7343f01]
  - @scopebond/policy-schema@0.4.0
  - @scopebond/verify@0.3.0
  - @scopebond/gateway@0.6.1

## 0.3.0

### Minor Changes

- 4dd6919: Make stateful clauses (rate_limit, spend_limit, sequence) bind in cooperative
  (check_only) enforcement.

  Previously a cooperative allow was recorded `executed:false`, and windowed clauses
  count only executed actions, so a per-window spend cap, a rate limit or a sequence
  cooldown never triggered in check-only mode — "max 5 posts a day" or "max
  $100/day" silently never fired. The gateway now counts prior cooperative allows
  toward the window for the live decision (an in-memory coercion in `evaluate`);
  stored receipts keep `executed:false` and claim-time `violates()` is unchanged, so
  this is conservative by design — an authorized-but-skipped action counts, which
  over-restricts rather than under. The MCP proxy previously evaluated every call
  against an empty history, so the same clauses never bound; it now keeps a session
  history of authorized calls (seedable via a new `history` option) and passes it to
  `violates()`, so rate_limit and sequence clauses work across calls. The in-process
  framework guard inherits the fix through the gateway.

### Patch Changes

- Updated dependencies [4dd6919]
  - @scopebond/gateway@0.6.0

## 0.2.0

### Minor Changes

- f0690e6: Connector onboarding helpers so the MCP proxy and framework guard go from install to working in one step.

  - `@scopebond/mcp`: `scopebond-mcp init --server <id>` scaffolds a signing key and a starter policy (allow non-destructive tools on that server, deny delete/write/remove/drop by name); `starterMcpPolicy(server)` is exported for library use.
  - `@scopebond/framework`: `generateAgentKey()` returns a fresh Ed25519 PKCS#8 PEM, and `starterToolPolicy(names)` builds an allowlist policy over `tool.<name>` types — so a guard can be scaffolded in code.

- c17c1fb: Add Cloud connect + auto-export to `@scopebond/mcp`. `scopebond-mcp connect <workspace-url> <enrollment-bundle.json>` enrolls the proxy's signing key with a workspace (reusing the gateway's `completeCloudEnrollment`) and stores a scoped machine credential next to the key. When connected, the running proxy mirrors every PEP-authorized receipt to the workspace through the gateway's durable outbox (`SqliteCloudOutbox` + `createCloudExporter`), flushing on the proxy's lifetime and on shutdown. New exports: `connectCloud`, `loadMcpConnection`, `openExporter`, `connectionFileFor`, `McpConnection`.
- 5fa48d5: Add `@scopebond/mcp` — the MCP proxy connector (a leaf package). It sits in-path between an MCP client and an upstream Model Context Protocol server, checks each `tools/call` against policy before it is forwarded, and records a signed **PEP-authorized** receipt; a denied call returns a JSON-RPC error and is never forwarded.

  - The pure `createMcpProxy({ policy, principal, server, attesterKeyPem, upstream })` returns `{ handle(message) }`: `tools/call` is mapped to the taxonomy `mcp.tool.call` action (arguments digested, never stored) and decided with `@scopebond/verify`; everything else passes through. The proxy decides the caller's request with no agent signature, so its receipts are `pep_authorized` — the identity is the configured principal.
  - `scopebond-mcp` is a stdio proxy: point your MCP client at it and give it the real server after `--`. It correlates upstream responses by id, fails closed on any error, and can append signed receipts to a local log.
  - Conformance vector (allowed call forwarded with a `pep_authorized` allow receipt, denied call blocked and never forwarded, tool-bound and passthrough) proves the decision path with an injected upstream.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [c0d81f6]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [0cb916f]
- Updated dependencies [c17c1fb]
- Updated dependencies [1fd3470]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/verify@0.2.0
  - @scopebond/gateway@0.5.0
