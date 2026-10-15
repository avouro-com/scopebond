---
"@scopebond/hook": minor
"@scopebond/agent": minor
---

The tray lists what was blocked in plain words, and allowing an earlier block from the tray offers 15 minutes again.

- Fix: acting on an earlier block from the tray (`POST /blocked`) left "Allow for 15 min" out of the Scopebond window, because the question for an earlier block carried no 15-minute offer. `blockedQuestion` now offers it wherever the window offers it when the block happens (a rule set to "Block, person may allow" whose workspace sends the allowance terms, under the daily limit), and `actOnBlocked` makes a 15-minute allowance only where it is offered.
- `GET /tray` lists up to 20 recent blocks (was 3), newest first. Each keeps its older fields and adds `what` (the action in plain words, such as "Read .env.production" or "git push --force origin main", with secrets masked as the Scopebond window masks them), `action_text` (the text the window shows), `rule_title`, `project` (the repository's name), `tool` ("Claude Code", "Cursor", "Codex"…), `offers` (once, fifteen, always with `always_days` and `always_needs_admin`, ask) and `reason_min`. The model also adds `can_ask` (the workspace lets a person ask an admin under some rule), `detail` (the line under "Protected"), `workspace` (its name) and `today` (actions and blocks since midnight).
- The hook exports `plainAction` and `ruleTitle`; `localActivity` adds `what`, `action_text`, `harness` and `repository` to each recent block, and `blockedQuestion` adds `offers.fifteen`, `always_days` and `always_needs_admin`.
- The PowerShell tray lists the newest five blocks, in plain words.
