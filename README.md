# Scopebond

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/avouro-com/scopebond/actions/workflows/ci.yml/badge.svg)](https://github.com/avouro-com/scopebond/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@scopebond/gateway.svg)](https://www.npmjs.com/package/@scopebond/gateway)

**Security & safety guardrails for AI agents with real authority.**

> **Experimental alpha:** use controlled test systems only. Unknown-outcome
> reconciliation, distributed hosted coordination, and release migration remain
> under active remediation. The live demo evaluates real policies but uses
> a no-op executor; it does not perform the displayed business actions.

AI agents are being handed the power to **move money, send messages, and change
systems** — on their own. When an agent makes a mistake or gets hijacked (a
prompt-injected agent will happily use its real permissions against you), the
damage is real and there's no undo. Scopebond is the open-source control layer
that **blocks out-of-policy actions before they happen** and **proves exactly what
every agent did**.

> ▶ **See the policy simulation:** **[try.scopebond.com](https://try.scopebond.com)** —
> compare live allow/deny decisions across finance, security, legal, DevOps, support,
> data, and vendor scenarios. Learn more at **[scopebond.com](https://scopebond.com)**.

## One policy, three uses: prevent · prove · recover

- **Prevent** — the **Scopebond Gateway** sits between an agent and everything it
  can touch (MCP tools, HTTP APIs, wallets). You write a machine-readable policy —
  spend limits, allowlists, action bounds, time windows, approvals — and each rule
  is *enforced* (blocked in-flight, **fail closed**) or *monitored* (allowed, but
  signed and flagged). Plus a kill switch. These are target semantics; do not rely on
  the alpha for production protection until the open remediation work is released.
- **Prove** — every action, allowed or blocked, is countersigned into a
  tamper-evident **`scopebond:receipt`** (Ed25519). Anyone can verify a receipt
  against the gateway's published key. A valid signature supports integrity and
  provenance for what the signer asserted; it does not by itself prove an external
  effect, completeness, compliance or legal admissibility.
- **Recover** *(roadmap)* — the **Collateral Registry**: an operator backs an agent
  with a refundable USDC deposit against the *same* policy; on a provable scope
  violation the principal recovers from it. Non-custodial — Scopebond holds no key
  that can move it.

## What it protects

Payments & finance · security incident response · legal & litigation (proof) ·
DevOps & infrastructure · customer support · data & privacy · third-party / vendor
agents. **[Try each one live →](https://try.scopebond.com)**

## Quickstart

```bash
pnpm -r build
node examples/quickstart.mjs
```

Embed it in your own service:

```ts
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
const keys = new StaticPrincipalKeyRegistry(principalKeyRecords);
const { app, handleAction } = createGateway({ policy, authentication: { keys } });
```

Verify a receipt independently (no trust in the server required):

```bash
npx @scopebond/gateway verify ./receipt.json --url http://localhost:8787
```

Works with any agent over **HTTP or MCP**. Self-host it free — no account required.

## Packages

| Package | What it is |
|---|---|
| [`@scopebond/gateway`](packages/gateway) | The experimental gateway alpha: HTTP + MCP ingress, authenticated Ed25519 action evidence, atomic SQLite authority reservations, persistent attester key, durable stop state and receipts, plus one constrained support-refund adapter. Default execution is a simulation. `npx @scopebond/gateway`. |
| [`@scopebond/verify`](packages/verify) | `scopebond-verify` — the deterministic `violates(policy, receipts, claimed)` verdict library + conformance vectors. The portable standard the whole thing rests on. |
| [`@scopebond/policy-schema`](packages/policy-schema) | The policy vocabulary — JSON Schema for the policy document and the `scopebond:receipt` envelope, plus test vectors. |

An Ed25519 operator-signing **`sdk`** and a runnable end-to-end **[`examples/quickstart`](examples/)** are in the repo; the on-chain **contracts** and the **conformance suite** are `[PLANNED]`.

## What lives here (and what doesn't)

**Here (Apache-2.0):** the gateway, the `scopebond-verify` verdict library and its
test vectors, the policy schema, the SDK, framework integrations, the smart
contracts, the registry read API, and the conformance suite — the open-source
product you self-host and build on.

**Not here:** Avouro's internal docs, marketing sites, hosted-service and
control-plane code ("Scopebond Cloud") — those live in separate private
repositories. A commit gate (`scripts/oss-gate.mjs`, enforced on commit, push, and
merge) keeps non-public material out of this repo by design.

## Status

Early development, landing package by package. `@scopebond/verify` and
`@scopebond/policy-schema` are published at `0.1.0`; the gateway is a
published **alpha**. The hosted control plane ("Scopebond Cloud") is a separate,
proprietary product and is not in this repository.

## Using Scopebond? Show it

If Scopebond guards your agents, add the badge so your users know their agent is
bounded and its actions are provable:

[![Secured by Scopebond](https://img.shields.io/badge/Secured%20by-Scopebond-5b8cff)](https://scopebond.com)

Markdown:

```md
[![Secured by Scopebond](https://img.shields.io/badge/Secured%20by-Scopebond-5b8cff)](https://scopebond.com)
```

HTML:

```html
<a href="https://scopebond.com"><img src="https://img.shields.io/badge/Secured%20by-Scopebond-5b8cff" alt="Secured by Scopebond"></a>
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SCOPE.md](SCOPE.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); contributions are under a [CLA](CLA.md).
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). © 2026 Avouro LLC.
Scopebond is a trademark of Avouro LLC (https://scopebond.com).

Nothing in this repository is an offer of insurance, securities, or financial
services, or legal or financial advice.
