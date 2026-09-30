---
"@scopebond/gateway": minor
---

Align the dispatch boundary with the workspace. Scope entries use a closed kind vocabulary (`action`, `privilege`; `scopeEntryDigest` throws on another) and `actionScopeEntry(action_type, target | null)` builds the exact and any-target entries over the opaque target id, refusing an invalid type or target. A delegation check sends the action and target id and uses the workspace's `covers` answer when it gives one. A required approval with no reference in the inbox is looked up with `GET /v1/monitoring/approvals/active` and consumed as before. New: `dispatchApprovalBinding`, `openApprovalBinder`, `SCOPE_ENTRY_KINDS`, `actionScopeEntry`, `CLOUD_ACTIVE_APPROVAL_PATH`.
