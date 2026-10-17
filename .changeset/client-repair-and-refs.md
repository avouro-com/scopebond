---
"@scopebond/hook": minor
"@scopebond/gateway": patch
---

Errors that say what to do. A fail-closed block names the broken file and the command that fixes it (a rules file that does not parse: `rules apply`, or `init --force` with its warning; a full disk; a folder the account cannot write; a missing file) instead of `init`, which never replaced a file that exists. `doctor` reports a rules file that does not parse, an unreachable or unhealthy workspace and a refused connection as problems, and its health check gives up after 10 seconds. The block message names the rule as the tray does (its id in brackets), tells the coding agent not to retry or work around it, tells the person what to do (on a computer that follows its workspace's rules: ask an admin), and gives the record id. When a refused connection puts a computer back on its own rules, the person is told once and `status` says so first. The gateway keeps the workspace's `reason` (for `credential_refused`) and its reference (`[ref …]`) in a refusal.
