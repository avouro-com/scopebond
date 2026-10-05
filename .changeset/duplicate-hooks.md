---
"@scopebond/hook": minor
"@scopebond/agent": patch
---

Duplicate hooks: `status` and `doctor` say when an agent would run the Scopebond hook more than once for each action (user settings plus a project's, two entries in one file, or an enabled Claude Code plugin beside a settings entry), and the new `dedupe` command keeps one (the user-level entry unless `--keep project|plugin`), leaving other tools' hooks alone. The Scopebond Agent's self-check reports it as `hook_duplicates` with the fix. `dedupe` removes only the Scopebond command from a hook group it shares with a person's own hook (the group goes only when nothing else is left), never rewrites a file it has nothing to change in, and edits a git-tracked project file only when `--keep project` was chosen. Settings files with a byte-order mark are read too.
