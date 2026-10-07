---
"@scopebond/policy-schema": minor
"@scopebond/verify": minor
"@scopebond/gateway": minor
---

Summary records. A signed `scopebond:summary` document (evidence class `summary`) stands in for many routine receipts when
a computer sends its evidence: their number, an RFC 9162 root over the receipts it covers, counts by action type, result,
program and working folder, and the actions repeated in the window. Every action keeps its own signed receipt; a denied,
overridden, approved or timed-out action is never covered.

- `@scopebond/policy-schema`: `summary.schema.json`, `summarySchema`, `SUMMARY_TYPE`, `SUMMARY_DOMAIN`, `SUMMARY_RESULTS`,
  `SUMMARY_LIMITS`.
- `@scopebond/verify/summary`: `validateSummary`, `verifySummarySignature` (domain-separated, so a summary never passes as
  a receipt), `verifySummaryCoverage` (count, root, window, routine only, totals), `summaryRoot`, `summarySigningInput`.
- `@scopebond/gateway`: `buildSummary` (signs with the receipts' key; at most 500 count lines, the rest folded by action
  type so the counts always add up), `isNotable` (the default test for what is always sent in full) and `repeatKey`.
