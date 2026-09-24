# @scopebond/framework

## 0.3.2

### Patch Changes

- Updated dependencies [df4fc67]
- Updated dependencies [f2e4d62]
- Updated dependencies [5329932]
  - @scopebond/gateway@0.7.0
  - @scopebond/policy-schema@0.4.1

## 0.3.1

### Patch Changes

- Updated dependencies [f212f82]
- Updated dependencies [7343f01]
  - @scopebond/policy-schema@0.4.0
  - @scopebond/gateway@0.6.1
  - @scopebond/sdk@0.1.2

## 0.3.0

### Minor Changes

- 5d5724a: Connector hardening (SB68).

  - **github-action:** `claude[bot]` and `github-actions[bot]` are now governed
    coding-agent actors (a repo can still narrow the set via `agentActors`), and a
    pull request is evaluated at a real timestamp (injectable via a `now` option)
    instead of epoch 0, so `time_window` clauses actually bind.
  - **framework:** `guardedTool` (and `wrapOpenAITools`) now throw when a tool has no
    `execute` function instead of returning it unguarded — a silent passthrough on an
    unrecognized tool shape (for example an already-constructed OpenAI Agents tool that
    exposes only `invoke`) would let a tool run with no policy check. Wrap the tool
    _definition_'s `execute` before constructing the tool, or use `guardExecute`.

### Patch Changes

- Updated dependencies [4dd6919]
  - @scopebond/gateway@0.6.0

## 0.2.0

### Minor Changes

- f0690e6: Connector onboarding helpers so the MCP proxy and framework guard go from install to working in one step.

  - `@scopebond/mcp`: `scopebond-mcp init --server <id>` scaffolds a signing key and a starter policy (allow non-destructive tools on that server, deny delete/write/remove/drop by name); `starterMcpPolicy(server)` is exported for library use.
  - `@scopebond/framework`: `generateAgentKey()` returns a fresh Ed25519 PKCS#8 PEM, and `starterToolPolicy(names)` builds an allowlist policy over `tool.<name>` types — so a guard can be scaffolded in code.

- c17c1fb: Add optional Cloud export to `@scopebond/framework`. `connectCloud(attesterKeyPem, url, bundle)` enrolls the guard's countersigning key with a workspace; passing the resulting connection as `createToolGuard({ cloud: { connection } })` mirrors every signed-intent receipt to the hosted portal through a bounded outbox (in-memory by default; pass a durable `outbox` to survive restarts). `ToolGuard` gains `flush()` and `stop()`. New exports: `connectCloud`, `FrameworkConnection`.
- 0ec2dde: Extend `@scopebond/framework` with framework-agnostic guards so any tool-calling framework is covered, not only Vercel AI and LangGraph:

  - `guardExecute(name, execute, guard)` wraps a single async tool function so it checks policy first (a denied call returns a synthetic denial result).
  - `guardedTool({ name, execute }, guard)` wraps a function tool and preserves its other fields.
  - `wrapOpenAITools(tools, guard)` guards an OpenAI Agents SDK tools array.

  These cover the common `name` + `execute` shape used by the OpenAI Agents SDK, CrewAI, the Claude Agent SDK's MCP tools and others, without a framework dependency.

- d69338e: Add `@scopebond/framework` — the framework plugins (a leaf package; frameworks are optional peers, never dependencies). A cooperative (M0) in-process tool guard: before an agent runs a tool, it checks your policy and records a **signed-intent** receipt (the agent's key signs, so it is the strongest class). Enforcement depends on the framework honoring the guard; code outside the tool loop is not covered.

  - `createToolGuard({ policy, agentKeyPem, manifest?, onReceipt? })` returns `{ check(name, args) }`. A tool maps to the taxonomy `tool.<name>` type by default, or to a richer type (e.g. `payout.create`) via the `manifest`; money fields are lifted so `spend_limit` clauses apply. An unlisted tool is denied by a closed allowlist (fail closed).
  - Adapters ship for the **Vercel AI SDK** (`wrapVercelTools` — wraps a `tools` record; a denied call returns a synthetic denial result instead of executing) and **LangGraph/LangChain** (`wrapLangGraphTool` — proxies a tool so `invoke` checks first, preserving the instance).
  - Conformance vector (allowlisted tool → cooperative allow + signed-intent receipt; over-cap money tool → deny; unlisted tool → deny; both adapters run allowed tools and block denied ones). Smoke extended to eight packages.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [0cb916f]
- Updated dependencies [c17c1fb]
- Updated dependencies [1fd3470]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/gateway@0.5.0
  - @scopebond/sdk@0.1.1
