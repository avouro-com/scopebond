# packages/

The Scopebond monorepo packages. Landing incrementally; entries marked
`[PLANNED]` do not exist yet.

| Package | Purpose | Status |
|---|---|---|
| `policy-schema` | The policy vocabulary as JSON Schema, canonical types and shared evidence vectors. | **experimental** (published 0.3.0) |
| `verify` | `scopebond-verify` — the deterministic `violates(policy, receipts, claimed)` library used by the gateway and offline verification. | **experimental** (published 0.2.0) |
| `gateway` | Policy gateway with authenticated HTTP/MCP ingress, durable authority/lifecycle state, signed evidence, constrained execution and optional bounded Cloud export. Default execution is a simulation. `npx @scopebond/gateway`. | **experimental alpha** (published 0.5.0; not production-qualified) |
| `sdk` | Signing SDK for authenticated action intents and approvals plus a thin gateway client. | **experimental** (published 0.1.1) |
| `hook` | `scopebond-hook` — the Claude Code + Cursor connector (leaf): maps each tool call to a taxonomy action and checks it against policy in-path (cooperative M0) with a signed local receipt. | **experimental** (published 0.2.0) |
| `github-action` | `scopebond-verify-pr` — the GitHub connector's boundary-lane runner (leaf): checks an agent pull request against policy in your own Actions runner before it can merge. | **experimental** (published 0.2.0) |
| `mcp` | `scopebond-mcp` — the MCP proxy connector (leaf): one policy for every Model Context Protocol tool call, in-path in front of the upstream server, with a signed PEP-authorized receipt. | **experimental** (published 0.2.0) |
| `framework` | The framework plugins (leaf): a cooperative (M0) in-process tool guard with Vercel AI SDK and LangGraph/LangChain adapters — policy checked before every tool call, with a signed-intent receipt. | **experimental** (published 0.2.0) |
| `attest` | Countersignature / receipt emission (ACTA envelope, `scopebond:receipt`). | `[PLANNED]` |
| `contracts` | The on-chain vault, registry, and claim contracts (written fresh on OpenZeppelin primitives), verified on-chain. | `[PLANNED]` |
| `conformance` | The conformance suite a build must pass to use the "Scopebond Gateway" name. | `[PLANNED]` |

**Core-package rule:** `policy-schema`, `verify`, `gateway`, `sdk`, and
`contracts` carry no vendor or agent-framework SDK dependencies. External
services sit behind an interface with a local implementation exercised in tests.
Framework integrations are separate leaf packages.

## Runnable examples

Each connector has a worked, end-to-end example under [`../examples/`](../examples/)
(run with `node examples/<file>.mjs` after `pnpm -r build`); the same files are a
CI smoke that asserts their decisions (`pnpm run test:examples`):

| Connector | Example | Shows |
|---|---|---|
| `framework` | `framework-guard.mjs` | allow, spend-cap deny, fail-closed deny; signed-intent receipt |
| `github-action` | `github-pr-gate.mjs` | human PR never blocked; agent PR denied on a production path (D67) |
| `mcp` | `mcp-proxy.mjs` | allowed call forwarded (PEP receipt); denied call never forwarded |
| `hook` | `hook-map.mjs` | protected-branch push deny, destructive-program deny, unmapped → not_evaluated |
| `gateway` | `quickstart.mjs` | an agent signs an action; in-policy allowed, over-limit denied |
