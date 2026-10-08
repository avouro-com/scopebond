---
"@scopebond/github-action": patch
---

The changed-file list is now read as one JSON entry per file (or a NUL-delimited diff) and counted per entry, so a file name holding a newline cannot inflate the count and hide a truncated list; any path with a control character fails the check closed. The check step no longer runs `npx` in the workspace: it installs the version named by the action's own package.json (the `version` input now defaults to empty, meaning that version) into the runner's temp directory with lifecycle scripts off, runs it from the workspace, and passes inputs through env instead of template expansion.
