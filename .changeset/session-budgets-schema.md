---
"@scopebond/policy-schema": minor
---

Session budgets: limits on what one coding-agent session may do. New `schema/session-budgets.schema.json` describes the
optional `session_budgets` member of a workspace rules document: closed budgets with `budget_id`, `scope: "session"`,
`session_id` (the id receipts carry as `context.session_id`), `limits` (`{ operations, max }`, `0` for none), `mode`
(`enforce` or `monitor`), `version`, `expires_at` and an optional `source`, in the gateway's action-budget words.
`schema/receipt.schema.json` adds the optional, closed `payload.budget` (the budget, the action type counted, the count,
the limit and the state). New exports: `sessionBudgetsSchema`, `SESSION_BUDGET_SCOPE`, `SESSION_BUDGET_DEFAULT_SECONDS`
(two hours), `SESSION_BUDGET_MODES`, `SESSION_BUDGET_LIMITS`, `RECEIPT_BUDGET_STATES`, the `SessionBudget` types and
`vectors/session-budgets.json`.

Compatibility: a document without `session_budgets` and a receipt without `budget` are unchanged. A receipt check older
than this release reports a receipt carrying `budget` as invalid (the payload's key list is closed); `evidence_version`
stays `1.0`.
