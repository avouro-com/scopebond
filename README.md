# Scopebond

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/avouro-com/scopebond/actions/workflows/ci.yml/badge.svg)](https://github.com/avouro-com/scopebond/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@scopebond/gateway.svg)](https://www.npmjs.com/package/@scopebond/gateway)

**Guardrails and audit-grade proof for AI agents.** Scopebond checks every action a
coding agent takes — a shell command, a file edit, a git push, an MCP tool call —
against rules you write, blocks the ones that break them, and signs a tamper-evident
receipt of every decision that anyone can verify offline.

> **Experimental alpha — use controlled test systems only.** The semantics below are
> the target; the alpha is under active hardening. The hosted workspace ("Scopebond
> Cloud") is a separate, proprietary product and is not in this repository.

## 60-second start: govern your coding agent

Put Scopebond in front of Claude Code or Cursor. One command scaffolds a signing
key and a starter policy and wires the hook into your agent:

```bash
npx @scopebond/hook init            # add --cursor for Cursor
```

Then work as usual. A push to `main`, an `rm -rf`, a write to your CI config, a read
of a `*.key` — blocked before it runs. Everything else is recorded. Look at what
happened and check it cryptographically, with no network and no account:

```bash
scopebond-hook log                  # recent decisions
scopebond-hook verify               # every receipt verifies offline
scopebond-hook test "rm -rf /"      # see a decision without running anything
```

The starter policy protects release branches, blocks destructive programs, keeps the
agent out of its own policy and keys, and observes network and MCP calls so you can
tighten them when ready. It is a plain JSON file — edit the limits.

## One policy, three uses: prevent · prove · recover

- **Prevent** — the **Scopebond Gateway** sits between an agent and what it can touch
  (MCP tools, HTTP APIs, wallets). You write a machine-readable policy — spend limits,
  allowlists, action bounds, time windows, approvals — and each rule is *enforced*
  (blocked in-flight, **fail closed**) or *monitored* (allowed, but signed and
  flagged). Plus a kill switch.
- **Prove** — every action, allowed or blocked, is countersigned into a tamper-evident
  **`scopebond:receipt`** (Ed25519). Anyone can verify a receipt against the signer's
  published key. A valid signature supports integrity and provenance for what the
  signer asserted; it does not by itself prove an external effect, completeness or
  compliance.
- **Recover** *(roadmap)* — a later, optional layer where an operator backs an agent
  with a refundable deposit against the *same* policy. Non-custodial. Not required to
  use anything above, and not in scope for the alpha.

## How enforcement actually works

The hook maps each native tool call to a normalized action, decomposing a shell
command into every simple command it will run (`a && b`, `$(c)`, `bash -c '…'`), so a
denied program can't ride in behind an allowed one. It records a signed receipt and,
when a call is out of policy, blocks it — otherwise it defers to the agent's own
permission flow (it blocks; it never silently auto-approves). Secrets in commands are
scrubbed before anything is signed or stored. It is cooperative (M0): the agent runs
the allowed action itself. An agent that ignores the hook is not enforced — for
in-path enforcement of money or system actions, put the **gateway** in the path.

## Connectors

| Package | Governs |
|---|---|
| [`@scopebond/hook`](packages/hook) | Claude Code + Cursor tool calls, in-path, before they run. `npx @scopebond/hook init`. |
| [`@scopebond/mcp`](packages/mcp) | Any MCP client, by proxying an upstream MCP server and deciding each `tools/call`. |
| [`@scopebond/framework`](packages/framework) | In-process agents — a Vercel AI SDK / LangGraph tool loop — via a cooperative guard. |
| [`@scopebond/github-action`](packages/github-action) | Pull requests from coding agents, as a required policy check in GitHub Actions. |

## Core

| Package | What it is |
|---|---|
| [`@scopebond/gateway`](packages/gateway) | The enforcement engine: HTTP + MCP ingress, Ed25519 action evidence, atomic SQLite authority/approval reservations, durable dispatch lifecycle and reconciliation, kill switch, Merkle anchoring. Default execution is a simulation. |
| [`@scopebond/verify`](packages/verify) | `scopebond-verify` — the deterministic `violates(policy, receipts, claimed)` verdict library plus conformance vectors. The portable standard the rest rests on. |
| [`@scopebond/policy-schema`](packages/policy-schema) | The policy vocabulary and the `scopebond:receipt` envelope as JSON Schema, plus the action taxonomy and test vectors. |
| [`@scopebond/sdk`](packages/sdk) | Ed25519 operator signing for agents that emit signed intents. |

The on-chain **contracts**, the **registry read API** and the **conformance suite**
are `[PLANNED]`.

## Embed the gateway

```bash
npx @scopebond/gateway init         # writes a key, a key registry and a starter policy
```

```ts
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
const keys = new StaticPrincipalKeyRegistry(principalKeyRecords);
const { app, handleAction } = createGateway({ policy, authentication: { keys } });
```

Verify a receipt independently, no trust in the server required:

```bash
npx @scopebond/gateway verify ./receipt.json --url http://localhost:8787
```

Runnable end-to-end walkthroughs are in [`examples/`](examples/). Self-host everything
free — no account required.

## What lives here (and what doesn't)

**Here (Apache-2.0):** the connectors, the gateway, the `scopebond-verify` verdict
library and its vectors, the policy schema and the SDK — the open-source product you
self-host and build on.

**Not here:** Avouro's internal docs, marketing site, and the hosted control plane
("Scopebond Cloud"). A commit gate (`scripts/oss-gate.mjs`, enforced on commit, push
and merge) keeps non-public material out of this repository by design.

## Status

Experimental alpha. Published set: `@scopebond/policy-schema`, `@scopebond/verify`,
`@scopebond/gateway`, `@scopebond/sdk`, and the connectors `@scopebond/hook`,
`@scopebond/mcp`, `@scopebond/framework`, `@scopebond/github-action`. Use controlled
test systems only until the documented safety, integration and operational gates
close. See [scopebond.com](https://scopebond.com) and the live policy demo at
[try.scopebond.com](https://try.scopebond.com).

## Using Scopebond? Show it

[![Secured by Scopebond](https://img.shields.io/badge/Secured%20by-Scopebond-5b8cff)](https://scopebond.com)

```md
[![Secured by Scopebond](https://img.shields.io/badge/Secured%20by-Scopebond-5b8cff)](https://scopebond.com)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SCOPE.md](SCOPE.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); contributions are under a [CLA](CLA.md). To
report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). © 2026 Avouro LLC.
Scopebond is a trademark of Avouro LLC (https://scopebond.com).

Nothing in this repository is an offer of insurance, securities, or financial
services, or legal or financial advice.
