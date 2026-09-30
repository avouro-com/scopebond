---
"@scopebond/hook": minor
---

With approvals required in `dispatch.json`, typed operations carry `approval_request_hash` (the hash the dispatch guard consumes with) and a `resource_id` equal to the guard's target id. `scopebond budget load` verifies the export's `agent_kid` against this machine's agent key (refusing a mismatch, warning on null) and writes it as the budget's actor. Workspace approvals no longer need a hand-copied id.
