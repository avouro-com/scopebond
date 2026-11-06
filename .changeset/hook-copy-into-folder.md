---
"@scopebond/hook": patch
---

A copy or move into a folder (`cp`, `mv`, `install`, `rsync`, `cp -t`) is judged by the file it writes there as well as by the folder: `cp settings.json ~/.claude/` is checked as `~/.claude/settings.json`.
