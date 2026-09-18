---
"@scopebond/policy-schema": minor
"@scopebond/gateway": minor
---

Add signed PEP-authorized receipts, completing the three-class receipt model. The evidence contract gains a `pep` authorization mode — the honest representation for a receipt with **no agent signature** where a proxy/PEP decided a request carrying the caller's own identity; the identity is the receipt's `principal`. `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

`@scopebond/gateway` exports `buildPepReceipt(input, attester)` — a reusable builder for any M1/PEP connector (the MCP proxy, gateway interceptors). It constructs and signs a `pep_authorized`-class receipt (the normalized action, the principal, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`). Like the boundary class, it attests only that the PEP authorized the action for the principal — never agent non-repudiation.
