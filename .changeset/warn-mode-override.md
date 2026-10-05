---
"@scopebond/hook": minor
"@scopebond/gateway": minor
"@scopebond/policy-schema": minor
---

Warn mode. A workspace can set a rule to "Block, user may override": the hook then blocks a matching action until the person at the computer allows it once, with a reason, in the Scopebond Agent's window, or, where the workspace allows it and Claude Code's permission mode really asks the person, offers Claude Code's own prompt. Scopebond's own protection, rules on Block and the kill switch are never overridable; the workspace's daily limit and repeat window hold. The gateway takes an optional override handler on `handleAction` and signs an `override` record (rule, method, state, reason digest) into an approved receipt; `validateOverrideRecord` and the receipt schema define its exact shape.
