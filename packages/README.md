# packages/

The Scopebond monorepo packages. Landing incrementally; entries marked
`[PLANNED]` do not exist yet.

| Package | Purpose | Status |
|---|---|---|
| `policy-schema` | The policy vocabulary as JSON Schema, canonical types and shared evidence vectors. | **experimental** (strict versioned policy/action/receipt schemas and canonicalization vectors) |
| `verify` | `scopebond-verify` — the deterministic `violates(policy, receipts, claimed)` library used by the gateway and offline verification. | **experimental** (all supported v1 clauses, strict validation and conformance vectors) |
| `gateway` | Policy gateway with authenticated HTTP/MCP ingress, durable authority/lifecycle state, signed evidence, constrained execution and optional bounded Cloud export. Default execution is a simulation. `npx @scopebond/gateway`. | **experimental alpha** (local candidate; not yet published or production-qualified) |
| `sdk` | Signing SDK for authenticated action intents and approvals plus a thin gateway client. | **experimental** (local publication candidate) |
| `attest` | Countersignature / receipt emission (ACTA envelope, `scopebond:receipt`). | `[PLANNED]` |
| `contracts` | The on-chain vault, registry, and claim contracts (written fresh on OpenZeppelin primitives), verified on-chain. | `[PLANNED]` |
| `conformance` | The conformance suite a build must pass to use the "Scopebond Gateway" name. | `[PLANNED]` |

**Core-package rule:** `policy-schema`, `verify`, `gateway`, `sdk`, and
`contracts` carry no vendor or agent-framework SDK dependencies. External
services sit behind an interface with a local implementation exercised in tests.
Framework integrations are separate leaf packages.
