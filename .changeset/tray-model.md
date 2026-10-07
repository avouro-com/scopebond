---
"@scopebond/agent": minor
"@scopebond/hook": minor
---

The tray says what is true and offers only what applies. The Windows tray draws the Scopebond "S" tile with a status badge
(protected, working, offline, needs attention, problem, not connected) from a model the agent computes (`GET /tray`), so the
tray, `status` and the workspace agree. Its menu shows Rules, Delivery, Today's actions and blocks, and Version (each only
with data), the one fix when something is wrong, **Check now** with what it found, **Send records now** only when records
wait, **Update now** only when the workspace recommends a newer version, the last few blocks, a notification setting (All,
Problems only by default, Off) and Help (copy diagnostics, open the Scopebond folder, documentation, About). Records waiting
count only time the computer was awake, and the workspace being unreachable is offline (still checking actions) for four
hours before it needs attention.

The hook exports `localActivity()` (today's counts and the newest blocks, read-only and bounded, summarised without
arguments) and `ruleReport()`.
