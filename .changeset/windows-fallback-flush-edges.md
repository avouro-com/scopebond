---
"@scopebond/hook": patch
"@scopebond/gateway": patch
"@scopebond/agent": patch
---

Windows hook entries: the quoted fallback is reported and hardened.

- `status` and `doctor` note when a Codex or Cursor entry uses quoted paths (no short name for one of its folders), since PowerShell may not start it.
- A quoted path containing `$`, a backtick, `%` or `!` is refused with a clear error instead of being written (Git Bash and cmd.exe expand those even inside quotes).
- The short-name lookup runs with code page 65001, so a folder name outside the console's code page reads correctly.
- The quoted form is used when the volume has short names switched off, a folder name has `%`, `^`, `!` or `&`, a short name is not plain ASCII, or the path is a network (UNC) path.
- The agent rewrites a quoted Windows entry into the plain form when that form is available.
- `doctor` also checks a Codex entry's `commandWindows`, and `init` recognises a hook that names Scopebond only there.
- `uninstall` now removes only Scopebond's hook from a hook group another tool shares; the group, its matcher and the other hooks stay.

`flush` edge cases:

- `flush` exits 1 when the last delivery attempt failed even with nothing left in the queue (it used to exit 0 then).
- A routine record stamped further ahead than one summary window and its grace (a clock set wrong) is counted as pending, not held.
- The "held until" time shows its date when it is not today.
- With only held routine records left, `flush` sends nothing and does not contact the workspace (now documented).
