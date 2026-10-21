---
"@scopebond/hook": patch
---

The safe-shell rule now lets a delete (`rm`, `rmdir`, `unlink`, `del`, `rd`, `erase`, `deltree`, `Remove-Item`) run when every target it names is inside the working folder, is build or cache output such as `node_modules`, `dist` or `*.log`, or is under the temp folder, and still blocks a delete of `~`, `/`, a drive root, anything outside the working folder, the folder itself, `.git`, a protected file, a whole-folder wildcard, a target known only at run time or no target, as well as `sudo`, `mkfs`, `dd`, `shred`, `format`, `shutdown` and the other non-delete programs whatever their arguments.
Each shell command's record carries a new `program_scope` value (`rm/contained` for an allowed delete) beside the unchanged `program`, and an allowed delete also records each of its targets as a file write so the protected-path rules judge them.
A policy written by an earlier version of the starter rules is read with the new safe-shell rule without running `init` again.
