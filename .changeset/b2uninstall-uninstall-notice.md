---
"@scopebond/hook": patch
---

`uninstall` now exits with code 75 (exported as `UNINSTALL_NOT_TOLD_EXIT`) when a workspace this computer is connected to could not be told about the removal, says when the computer is not connected to any workspace, and names the Scopebond folder once instead of twice when run from the home folder; a program that runs it for the person can set `SCOPEBOND_UNINSTALL_CALLER` to say what happens to the folder itself, and `uninstallReportLine` gives the line for a workspace's answer.
