# @scopebond/framework

## 0.3.14

### Patch Changes

- 611d02c: Lint clean-ups in the tool adapters that change no behaviour.
- Updated dependencies [611d02c]
- Updated dependencies [a17f73b]
  - @scopebond/gateway@0.17.5
  - @scopebond/sdk@0.1.7

## 0.3.13

### Patch Changes

- 88a6380: `wrapVercelTools` throws on a tool with no `execute`, like `guardedTool`, instead of passing it through unchecked. `wrapLangGraphTool` now guards every entry point the tool has (`invoke`, `call`, `_call`, `func`, `stream`, `batch`), not only `invoke`.
- 0f7268b: Tool arguments in a guard's receipts now have credential shapes scrubbed inside their values (a token in a URL query, a SQL password literal, a Bearer header in a command, and more) before the receipt is signed and sent to Cloud; `asset`, `amount` and `currency` stay in clear. The README documents what a receipt keeps of each field. New `cloud.outboxPath` opens a durable, lossless SQLite queue (no cap, no expiry; Node 22.5 or later) so waiting receipts survive a restart, and `cloud.onGap` reports any record the queue could not keep (a warning on stderr by default). Without `outboxPath` the queue stays in memory and bounded, and a record dropped at the bound now takes its sequence number first, so the workspace counts it as missing.
- Updated dependencies [258cdb6]
- Updated dependencies [d6996ad]
- Updated dependencies [7fc5efb]
- Updated dependencies [0f7268b]
- Updated dependencies [88a6380]
  - @scopebond/gateway@0.17.1
  - @scopebond/sdk@0.1.6

## 0.3.12

### Patch Changes

- Updated dependencies [cb4d4e0]
- Updated dependencies [e343292]
- Updated dependencies [e0f2de4]
- Updated dependencies [ce7728c]
- Updated dependencies [c877e45]
- Updated dependencies [d4b34d8]
  - @scopebond/policy-schema@0.7.0
  - @scopebond/gateway@0.17.0
  - @scopebond/sdk@0.1.5

## 0.3.11

### Patch Changes

- Updated dependencies [40c1fb7]
  - @scopebond/gateway@0.16.0

## 0.3.10

### Patch Changes

- Updated dependencies [9fd79e2]
  - @scopebond/gateway@0.15.0

## 0.3.9

### Patch Changes

- Updated dependencies [c4514ca]
- Updated dependencies [7736223]
- Updated dependencies [8e42db0]
- Updated dependencies [2a9b060]
- Updated dependencies [6c3b253]
  - @scopebond/gateway@0.14.0

## 0.3.8

### Patch Changes

- Updated dependencies [433c8df]
  - @scopebond/gateway@0.13.0
  - @scopebond/policy-schema@0.6.0
  - @scopebond/sdk@0.1.4

## 0.3.7

### Patch Changes

- Updated dependencies [3308250]
  - @scopebond/gateway@0.12.0

## 0.3.6

### Patch Changes

- Updated dependencies [6e61a3b]
  - @scopebond/gateway@0.11.0

## 0.3.5

### Patch Changes

- Updated dependencies [1b8be99]
  - @scopebond/gateway@0.10.0

## 0.3.4

### Patch Changes

- Updated dependencies [b65261d]
- Updated dependencies [b08c8df]
- Updated dependencies [b08c8df]
- Updated dependencies [7c6fa19]
- Updated dependencies [aac4f6f]
  - @scopebond/gateway@0.9.0
  - @scopebond/policy-schema@0.5.0
  - @scopebond/sdk@0.1.3

## 0.3.3

### Patch Changes

- Updated dependencies [978e7a3]
- Updated dependencies [978e7a3]
  - @scopebond/gateway@0.8.0

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
