---
"@scopebond/gateway": minor
"@scopebond/mcp": minor
---

Make stateful clauses (rate_limit, spend_limit, sequence) bind in cooperative
(check_only) enforcement.

Previously a cooperative allow was recorded `executed:false`, and windowed clauses
count only executed actions, so a per-window spend cap, a rate limit or a sequence
cooldown never triggered in check-only mode — "max 5 posts a day" or "max
$100/day" silently never fired. The gateway now counts prior cooperative allows
toward the window for the live decision (an in-memory coercion in `evaluate`);
stored receipts keep `executed:false` and claim-time `violates()` is unchanged, so
this is conservative by design — an authorized-but-skipped action counts, which
over-restricts rather than under. The MCP proxy previously evaluated every call
against an empty history, so the same clauses never bound; it now keeps a session
history of authorized calls (seedable via a new `history` option) and passes it to
`violates()`, so rate_limit and sequence clauses work across calls. The in-process
framework guard inherits the fix through the gateway.
