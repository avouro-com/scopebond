# packages/

The Scopebond monorepo packages. Landing incrementally; entries marked
`[PLANNED]` do not exist yet.

| Package | Purpose | Status |
|---|---|---|
| `policy-schema` | The policy vocabulary as a JSON Schema + canonical types, and its test vectors. Published before the proxy. | **early** (schemas + constants + first vector; full vector suite in progress) |
| `verify` | `scopebond-verify` — the deterministic `violates(policy, receipts, claimed)` library; the same code runs in the gateway (real-time) and at claim time. The moat-bearing artifact. | **early** (spend/rate/approval/sequence/time-window implemented + tested; rest `[PLANNED]`) |
| `gateway` | Experimental policy-gateway alpha (HTTP + MCP ingress), currently with open safety findings and a no-op default executor. `npx @scopebond/gateway`. | **early** (not for production protection; enforcement/signing/durability remediation in progress) |
| `sdk` | Signing SDK for operators to sign action intents (+ a thin gateway client). | **early** (Ed25519 signing, verify, submit; tested) |
| `attest` | Countersignature / receipt emission (ACTA envelope, `scopebond:receipt`). | `[PLANNED]` |
| `contracts` | The on-chain vault, registry, and claim contracts (written fresh on OpenZeppelin primitives), verified on-chain. | `[PLANNED]` |
| `conformance` | The conformance suite a build must pass to use the "Scopebond Gateway" name. | `[PLANNED]` |

**Core-package rule:** `policy-schema`, `verify`, `gateway`, `sdk`, and
`contracts` carry no vendor or agent-framework SDK dependencies. External
services sit behind an interface with a local implementation exercised in tests.
Framework integrations are separate leaf packages.
