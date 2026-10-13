---
"@scopebond/hook": minor
---

GitHub Copilot CLI is now a supported coding tool. `install --copilot` writes Scopebond's own hook file to
`~/.copilot/hooks/scopebond.json` (under `COPILOT_HOME` when it is set), and `init --copilot` writes
`.github/hooks/scopebond.json` in a project; a plain `install` adds Copilot when its user folder exists. The file registers
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart` and `SessionEnd` with a `bash` and a `powershell` command
and `timeoutSec: 60`. Copilot's tools are checked as their Claude Code counterparts: `bash`/`powershell` as shell commands,
`view`/`grep`/`glob` as reads, `create`/`edit`/`str_replace_editor`/`apply_patch` as writes, `web_fetch` as a recorded fetch;
any other tool is recorded and not evaluated. A deny answers `permissionDecision: "deny"` with the reason and exits 2.
Session and after-action events feed observations as they do for Claude Code.

Copilot is described as it is: cooperative, prevents if honored, and a hook timeout fails open in Copilot. Each check
therefore has its own 45 s deadline, inside the 60 s it installs, and denies when it cannot decide in time. `status`,
`doctor` and the capability manifest (new host variants `copilot_cli`, `copilot_vscode`, `copilot_cloud`) say so. The cloud
coding agent is not covered yet.

Scopebond's always-on protection now covers Copilot's hook settings: writes to `~/.copilot/hooks/`,
`~/.copilot/settings.json`, `.github/hooks/`, `.github/copilot/settings.json` and `.github/copilot/settings.local.json`,
removing those folders, and starting `copilot` with `COPILOT_HOME` moved are denied. An installed policy is upgraded in
memory; `rules.json` written by an earlier version keeps its own list for the recording rule.
