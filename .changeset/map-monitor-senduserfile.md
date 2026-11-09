---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

Claude Code's `Monitor` and `SendUserFile` tools are checked instead of refused as unknown. `Monitor` runs a shell command in the background, so its command is checked as `Bash`'s is: a push to main through it meets the branch rule, and a log tail runs. `SendUserFile` sends files to the person's own devices, so each file is checked as a read: a project file goes, and a file in Scopebond's own folder stays refused. In Monitor mode both are recorded, as every other mapped tool is.
