# Scopebond

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/avouro-com/scopebond/actions/workflows/ci.yml/badge.svg)](https://github.com/avouro-com/scopebond/actions/workflows/ci.yml)

**Trust infrastructure for AI agents that are delegated real authority.**

When you give an AI agent authority to move money and touch systems, you can
partly *prevent* misuse and you can *log* it — but when an agent acts outside
what you authorized, your recourse today is a contract and a hope. Scopebond
closes that gap with two open pieces built on one core:

- **Scopebond Gateway** — a policy-enforcement proxy that sits between an agent
  and everything it can touch (MCP tools, HTTP APIs, wallets). You write a
  machine-readable policy (spend limits, allowlists, action types, time windows,
  approvals); each clause is *enforced* (blocked in-flight) or *monitored*
  (allowed, but signed and logged). Every action the agent signs is
  countersigned, the log is anchored so history can't be rewritten, and you have
  a kill switch. No blockchain, no deposit, no account required to run it.
- **Scopebond Collateral Registry** — a neutral vault where an agent's operator
  posts a fractional USDC deposit against the *same* policy the gateway runs. On
  a provable scope violation, the principal recovers from the deposit after a
  short challenge window. Scopebond holds no key that can move it.

**One policy, three uses: prevent · prove · pay.** Or, as a rule: *prevent what
you can, collateralize what you can't prevent, refuse what you can't observe.*

## Status

Early development. This repository is the open-source home for the component,
the verification library, the policy schema, the on-chain contracts, and the
conformance suite. Code is landing package by package — see `packages/`. The
hosted control plane ("Scopebond Cloud") is a separate, proprietary product and
is not in this repository.

> `[PLANNED]` Quickstart, `npx scopebond-gateway`, and package docs will appear
> here as each package lands.

## What lives here (and what doesn't)

**Here (Apache-2.0):** the gateway, the `scopebond-verify` verdict library and
its test vectors, the policy schema, the SDK, the framework integrations, the
smart contracts, the registry indexer/read API, and the conformance suite.

**Not here:** Avouro's internal documentation and any proprietary or hosted-service
code — those live in separate private repositories. A commit gate
(`scripts/oss-gate.mjs`, enforced on commit, push, and merge) keeps non-public
material out of this repo by design.

## Packages

| Package | What it is |
|---|---|
| [`@scopebond/policy-schema`](packages/policy-schema) | The policy vocabulary — JSON Schema for the policy document and the `scopebond:receipt` envelope, plus test vectors. |
| [`@scopebond/verify`](packages/verify) | `scopebond-verify` — the deterministic `violates(policy, receipts, claimed)` verdict library. |

Further packages (gateway, sdk, contracts, conformance) are `[PLANNED]` — see [`packages/`](packages/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026
Avouro LLC. Scopebond is a product of Avouro LLC (https://scopebond.com).

Nothing in this repository is an offer of insurance, securities, or financial
services, or legal or financial advice.
