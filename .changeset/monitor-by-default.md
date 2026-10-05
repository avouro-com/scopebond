---
"@scopebond/hook": minor
---

Monitor is the default. Every rule now starts by recording what it would decide; a rule blocks only once it is turned on with `rules enforce <rule>` (or by the workspace for a connected computer), and `rules monitor <rule>` turns it back. Scopebond's own protection is no longer a rule: a coding agent changing Scopebond's settings, switching off the Scopebond Agent or uninstalling Scopebond is always denied, whatever the rules say, and a command that names Scopebond but cannot be read is treated the same way. A project set up by an earlier version whose rules were never edited moves to recording on its first run after the update and keeps the old policy as `policy.previous.json`; a project with its own edits keeps blocking what it blocked.

`uninstall` now tells each connected workspace before anything is removed, and prints whether the removal was allowed there; a removal the workspace did not allow raises a critical alert there. An unreachable workspace never stops the uninstall.

A delivery queue that cannot be opened (a full disk, a read-only or locked file) no longer stops the decision: the record stays in the local log and the runtime reports the file and the fix as `deliveryUnavailable`.
