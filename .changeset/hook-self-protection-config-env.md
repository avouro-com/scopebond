---
"@scopebond/hook": patch
---

The always-on protection now stops a coding agent started with its config folder moved from anywhere in the same command (an earlier `export`, an enclosing `sh -c`, a PowerShell `$env:` assignment), and the removal or rename of a folder that holds what it protects (`.claude`, `.cursor`, `.codex`, `.git`, the working folder, a home folder); with `protect-branches` enforced, a push alias given through git's environment configuration is denied like one given with `-c`.
