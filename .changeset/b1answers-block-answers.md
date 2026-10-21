---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

A person can now keep a block without being asked again ("Keep blocking without asking me"): the same action is denied at once for 30 days, the coding agent is told not to ask again, the tray lists it under the allowed items as kind "quiet" with Undo, and it is sent to the workspace as an allowance record with `kind: "quiet"` that never lets anything through.

A workspace can now name the lengths a person's unblock may last (`lengths` on a rule's override terms: Once, 1 hour, Until tomorrow, 30 days); the hook reports the `answer_lengths` capability, refuses unknown lengths, offers `hour` and `tomorrow`, and makes allowances that last 1 hour, 24 hours or 30 days, while terms without `lengths` work exactly as before.

The hook's new `ruleSummary` counts every rule in force (the starter rules, the workspace's own, the rule packs' rules on Block and each service the workspace blocks by name) and lists the packs in force, and the tray model passes these counts on; `ruleReport` keeps its shape.

"Rules updated" now means the last successful rules check: a failed check keeps `checked_at`, records `last_attempt_at` and `last_error`, and is not tried again before five minutes have passed.

The message a coding agent gets on a deny now has five lines (what was blocked in plain words and the rule's name, why, what to do, what the person can do, and a `Ref:` line with the clause, the mode and the record id), and its final instruction follows the outcome: the person can unblock it, an admin decides, it stays blocked, or the person chose to keep it blocked; a Safe Install block also says it stays blocked.
