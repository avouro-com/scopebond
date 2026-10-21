---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

A person can now keep a block without being asked again ("Keep blocking without asking me"): the same action is denied at once for 30 days, the coding agent is told not to ask again, the tray lists it under the allowed items as kind "quiet" with Undo, and it is sent to the workspace as an allowance record with `kind: "quiet"` that never lets anything through.
