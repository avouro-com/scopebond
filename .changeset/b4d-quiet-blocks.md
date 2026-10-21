---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

A workspace can now keep some kinds of block quiet: the hook works out a blocked record's tuning digest (the sha256 of its action type, workspace rule, program, target class, environment and host) and, when the workspace's rules document lists it in `quiet_patterns` (sent only to a hook that reports the new `quiet_patterns` capability, and signed with the allowances), the action stays blocked but no one is asked about it, the coding agent is told it stays blocked, and the tray's note for the block says it is quiet; an allowance in force still lets the action through, and Scopebond's own protection is never quiet.

The tray lists a block the workspace keeps quiet as "Kept blocked without asking you", with nothing to answer and no notification.
