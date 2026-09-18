# @scopebond/mcp

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
