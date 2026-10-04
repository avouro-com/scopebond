---
"@scopebond/hook": minor
---

`status` and `doctor` now tell the truth about delivery. Each delivery attempt is remembered after the hook exits: when this computer last delivered records, when it last tried, how many records wait and since when, and the last problem. A refused connection (HTTP 401 from record delivery or the rules check) is shown as **NOT DELIVERING** since the time it started, with the one command that fixes it; it clears on the next accepted delivery. `doctor` checks that the workspace still accepts the connection, not only that it is reachable, and fails when records have waited more than an hour or the connection is refused.

The delivery queue no longer drops records: no 10,000-record or 64 MiB cap and no 7-day expiry. A record leaves the queue only when the workspace accepts it, or when a key change sets it aside for `recover`.

Signing in again leaves an agent settings file that already holds the right hook entry byte-for-byte untouched (no rewrite, no backup), and `login` notes when it is run inside a coding agent's own terminal. Commands the hook prints use `npx.cmd` on Windows, where PowerShell's default script policy refuses `npx`.

`login` and `connect` for this computer (the default) now put the hook in the user-level agent settings (`~/.claude/settings.json`, `~/.cursor/hooks.json`, `~/.codex/hooks.json`), so every project is checked. Before, with no existing setup they wrote the current folder's project settings, so a sign-in run from a scratch folder governed only that folder. `--project` keeps a per-project connection and placement.
