---
"@scopebond/hook": minor
---

Dispatch boundary for the hook. A `dispatch.json` beside the policy turns on per-agent action budgets (one count per tool call, however many intents it maps to, kept across hook processes), single-use approvals for named action types and, with `SCOPEBOND_DELEGATION`, a delegated child scope checked against its whole ancestry on every call. New `budget` and `delegation` commands manage them; the suggested 100 per 60 seconds template is monitor-only. Off unless configured.
