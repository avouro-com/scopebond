---
"@scopebond/hook": minor
---

A workspace may now say that a person's unblock has no time limit, no daily limit, or both.

- A rule's override terms accept `"minutes": "unlimited"` and `"daily_limit": "unlimited"` besides the numbers (`minutes` 0 to 60, `daily_limit` 1 to 50). Any other value still makes the terms invalid and the rules document is refused, so the rules in force stay.
- With no time limit, once a person allows an action, the same action under the same rule stays allowed from then on without asking again, and each repeat is recorded as a repeat of that unblock. The window says the unblock covers "the same action from now on". The hook keeps such an unblock past the two days it keeps the others, so it still applies later.
- With no daily limit, a person may allow as many actions per rule per day as they need, in the window and from the tray.
- The hook reports the new `unlimited_terms` capability on its rules check (`x-scopebond-hook-capabilities: allowances,session_budgets,service_rules,unblock_terms,unlimited_terms`). A workspace sends `"unlimited"` only to a hook that reports it; older hooks keep getting numbers.
