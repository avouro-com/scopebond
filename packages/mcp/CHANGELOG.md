# @scopebond/mcp

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
