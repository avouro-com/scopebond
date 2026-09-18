---
"@scopebond/gateway": minor
---

Wire up M0 (check-only / cooperative) enforcement. `createGateway({ mode: "check_only" })`, the `serve --check-only` flag and `SCOPEBOND_MODE=check_only` make an allowed action a **cooperative allow**: the gateway decides and countersigns but never dispatches to an executor, recording `execution.state: "cooperative_allow"` (always `executed: false`, `external_effect: "not_independently_verified"`). A new `gateway.check(req)` forces the same cooperative semantics regardless of the configured mode, so an agent can obtain a decision plus a portable signed receipt in-process with no HTTP server. Denials and the kill switch remain fail-closed, and replayed signed requests are still rejected.

A cooperative allow is never counted as executed — not even transiently while reserved — so it cannot inflate a spend window it did not dispatch. Cumulative window enforcement across cooperative allows is therefore not provided in M0 by design; the per-action decision still applies, and in-path dispatch mode remains the way to enforce cumulative budgets. Also fixes the MCP `serverInfo.version` (previously reported `0.0.0`).
