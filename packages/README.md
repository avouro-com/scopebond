# packages/

All ten packages below are free, Apache-2.0 open-source software. The hosted
shared workspace, Scopebond Cloud, is a separate proprietary service and is not
included here. Its Free and paid plans are distinct from these packages.

The hook and gateway can run locally without a Cloud account. The Scopebond Agent
is a companion for connected computers, not the AI coding agent doing the work.
See the [root README](../README.md) for product scope and hosted versus local setup.

| Package | Purpose | Status |
|---|---|---|
| `policy-schema` | Policy, action, receipt, and observation schemas and shared evidence vectors. | **experimental** (published 0.7.2) |
| `verify` | Deterministic policy evaluation and independent evidence verification. | **experimental** (published 0.6.4) |
| `gateway` | HTTP/MCP policy engine, constrained execution, signed evidence, and a kill switch. Default execution is a simulation. | **experimental alpha; not production-qualified** (published 0.17.6) |
| `sdk` | Signing action intents and approvals and submitting them to a gateway. | **experimental** (published 0.1.7) |
| `hook` | Claude Code, Cursor, and Codex checks and signed local records. Coverage depends on the tool; Cursor file edits are recorded after writing. | **experimental** (published 0.21.8) |
| `github-action` | Agent pull-request checks in your own runner. Make the check required to gate merge; signing is configurable. | **experimental** (published 0.5.11) |
| `mcp` | Checks routed MCP tools/call requests before forwarding; other MCP operations are outside the tool-call policy. | **experimental** (published 2.0.11) |
| `framework` | Guards supported tools in Vercel AI SDK, LangGraph/LangChain, and custom loops; the application must honor the decision. | **experimental** (published 0.3.15) |
| `fake-cloud` | A stand-in Scopebond workspace for tests: device sign-in, enrollment, delivery, rules, self-check and client version, with fault injection (401, 409, 429, 500, slow, dropped). | **experimental** (private test tool; not published) |
| `agent` | Open-source companion for delivery, rule and connection maintenance, repair, workspace-controlled updates, health, and user override dialogs. Windows tray; macOS/Linux notifications. | **experimental** (published 0.6.2) |

**Core-package rule:** `policy-schema`, `verify`, `gateway`, and `sdk` carry no
vendor or agent-framework SDK dependencies. External services sit behind an
interface with a local implementation exercised in tests. Framework integrations
are separate leaf packages.

## Runnable examples

Worked examples live in [`../examples/`](../examples/). After `pnpm -r build`, run
`node examples/<file>.mjs`, or `pnpm run test:examples` for the smoke checks.

| Connector | Example | Shows |
|---|---|---|
| `framework` | `framework-guard.mjs` | Allowed call, spend-cap deny, fail-closed deny, signed intent. |
| `github-action` | `github-pr-gate.mjs` | Human PR not evaluated; agent PR denied on a protected path. |
| `mcp` | `mcp-proxy.mjs` | Allowed call forwarded; denied call never forwarded. |
| `hook` | `hook-map.mjs` | Protected-branch and destructive-program denials; unmapped actions not evaluated. |
| `gateway` | `quickstart.mjs` | Signed request allowed within policy and denied over its limit. |

Conformance vectors are already included in the schema and verifier packages.
Separate certification packages, collateral contracts, and registry features are
future concepts, not available packages.
