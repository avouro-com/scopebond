---
"@scopebond/hook": minor
---

GitHub Copilot CLI is now a supported coding tool. `install --copilot` writes Scopebond's own hook file to
`~/.copilot/hooks/scopebond.json` (under `COPILOT_HOME` when it is set), and `init --copilot` writes
`.github/hooks/scopebond.json` in a project; a plain `install` adds Copilot when it finds the Copilot CLI (the `copilot`
program on PATH, or the CLI's `settings.json` or `logs`). The file registers `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `SessionStart` and `SessionEnd` with a `bash` and a `powershell` command (which passes the hook's
exit code on) and `timeoutSec: 60`. Copilot's tools are checked as their Claude Code counterparts: `bash`/`powershell` and
what `write_bash` types as shell commands, `view`/`grep`/`glob` as reads, `create`/`edit`/`str_replace_editor`/`apply_patch`
as writes, `web_fetch` as a recorded fetch; any other tool is recorded and not evaluated. A deny answers
`permissionDecision: "deny"` with the reason and exits 2. Session and after-action events feed observations as they do for
Claude Code.

Copilot is described as it is: cooperative, prevents if honored, and a hook timeout fails open in Copilot. Each check
therefore has its own 45 s deadline, inside the 60 s it installs, and denies when it cannot decide in time. `status`,
`doctor` and the capability manifest (new host variants `copilot_cli`, `copilot_vscode`, `copilot_cloud`) say so. VS Code
agent mode and the cloud coding agent are not covered yet: their manifest cells are unsupported, and where Scopebond is not
set up (the cloud agent's sandbox) the deny says so.

Scopebond's always-on protection now covers Copilot's hook settings in every coding agent: writes to `~/.copilot/hooks/`,
`~/.copilot/settings.json`, `~/.copilot/mcp-config.json`, `.github/hooks/` (every file in it),
`.github/copilot/settings.json` and `.github/copilot/settings.local.json`, removing those folders, and starting `copilot`
with `COPILOT_HOME` moved are denied. An installed policy is upgraded in memory; `rules.json` written by an earlier version
keeps its own list for the recording rule.
