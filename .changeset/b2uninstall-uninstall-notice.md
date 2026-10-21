---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

`uninstall` now exits with code 75 (exported as `UNINSTALL_NOT_TOLD_EXIT`) when a workspace this computer is connected to could not be told about the removal, says when the computer is not connected to any workspace, and names the Scopebond folder once instead of twice when run from the home folder; a program that runs it for the person can set `SCOPEBOND_UNINSTALL_CALLER` to say what happens to the folder itself, and `uninstallReportLine` gives the line for a workspace's answer.

`scopebond-agent uninstall` (also what the Windows installer's removal and the Settings -> Apps entry run) now says when the workspace could not be told and exits with code 75 while still removing everything else, stops the hook's uninstall if it takes longer than 30 seconds, tells the workspace itself if the hook's uninstall cannot start, and ends with one sentence naming the Scopebond folder: that it stays (keys and records not yet sent) and how to remove it, or that it was removed with `--purge`.

The Settings -> Apps entry of an npm install now goes on to remove the npm package when only the workspace notice failed (and says so), ends with the sentence about the Scopebond folder, and is rewritten when the agent starts after an update, so it always runs the installed version's uninstall and shows its version.
