---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

A person can now keep a block without being asked again ("Keep blocking without asking me"): the same action is denied at once for 30 days, the coding agent is told not to ask again, the tray lists it under the allowed items as kind "quiet" with Undo, and it is sent to the workspace as an allowance record with `kind: "quiet"` that never lets anything through.

A workspace can now name the lengths a person's unblock may last (`lengths` on a rule's override terms: Once, 1 hour, Until tomorrow, 30 days); the hook reports the `answer_lengths` capability, refuses unknown lengths, offers `hour` and `tomorrow`, and makes allowances that last 1 hour, 24 hours or 30 days, while terms without `lengths` work exactly as before.
