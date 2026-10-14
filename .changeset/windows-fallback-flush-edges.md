---
"@scopebond/hook": patch
"@scopebond/gateway": patch
"@scopebond/agent": patch
---

Windows hook entries: the quoted fallback is reported and hardened, and shared hook groups are kept.

- `status` and `doctor` note when a Codex or Cursor entry uses the quoted form, which may not start under PowerShell. The quoted form is either written by an earlier release, or used because this computer has no short name for one of the folders; quoted network (UNC) paths count too. The note says the Scopebond Agent rewrites the entry when it can, or to reinstall.
- A quoted path containing `$` or a backtick is refused with a clear error instead of being written (Git Bash expands those even inside quotes). A path with `%` or `!` is written: cmd.exe and Git Bash start it.
- The short-name lookup passes the path to cmd.exe through an environment variable, so a folder name with `%`, `!`, `&` or `^` is not parsed. It reads cmd's answer as UTF-16 (`cmd /u`), so a name outside the console's code page reads correctly. The quoted form is used when the volume has short names switched off, a short name keeps such a character or is not plain ASCII, or the path is a network (UNC) path.
- The Scopebond Agent rewrites a quoted Codex or Cursor entry into the plain form once that form is available. Claude Code runs hooks under Git Bash, which starts the quoted form, so its entries are left alone. The agent reports a change only when a settings file actually changed.
- A path that cannot be written no longer stops anything else:
  - the dry-run previews show the refusal;
  - `init` refuses before anything is set up;
  - signing in reports it and fails;
  - the agent's upkeep, the move to the signed install and the hook repair record it for that coding agent and carry on.
- Writing the hook (install, upgrade, the agent's upkeep, the Claude Code session entries) replaces only Scopebond's own hook in a hook group another tool shares. The group's matcher and other hooks stay, and Scopebond's hook keeps its own timeout. `uninstall` likewise removes only Scopebond's hook from such a group.
- `doctor` also checks a Codex entry's `commandWindows`, and `init` recognises a hook that names Scopebond only there.
- A hook command counts as Scopebond's only when it runs one of Scopebond's own programs:
  - `@scopebond/hook`;
  - `scopebond`, `scopebond-hook` or `scopebond-agent`;
  - a `cli.js` inside a `.scopebond` or `@scopebond` folder;
  - this hook's own `cli.js`.

  Another tool's `cli.js`, or a path that merely mentions "scopebond", is left alone.

`flush` edge cases:

- `flush` exits 1 when the last delivery attempt failed, even with nothing left in the queue (it used to exit 0 then).
- A routine record stamped further ahead than one summary window and its grace (a clock set wrong) is sent in full rather than held for a window that will not close. Until then it counts as pending, not held.
- The "held until" time shows its date when it is not today.
- With only held routine records left, `flush` sends nothing and does not contact the workspace (now documented).
