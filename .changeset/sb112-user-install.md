---
"@scopebond/hook": minor
---

Real install package: a once-per-machine, user-level installer (SB112).

- New `scopebond` bin (alongside `scopebond-hook`) and commands: `install`
  (user-level home in `~/.scopebond`, hook registered by absolute path in
  `~/.claude/settings.json` / `~/.cursor/hooks.json`, Cursor auto-detected),
  `status`, `doctor`, `uninstall` (`--purge`), and `login` (points at `connect`
  until device-code login ships).
- Hook events now resolve their config most-specific first: an explicit
  `SCOPEBOND_HOOK_DIR`, then the payload's project `.scopebond`, then
  `$CLAUDE_PROJECT_DIR`, then the user-level home — so one install governs every
  project while a project-local policy still wins.
- Ships as a Claude Code plugin (a `.claude-plugin` marketplace at the repo root):
  `/plugin marketplace add avouro-com/scopebond` then `/plugin install scopebond`.
