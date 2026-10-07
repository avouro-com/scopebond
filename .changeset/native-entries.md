---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

When Scopebond runs as the single executable, the coding agents' settings name the executable itself (`"…\scopebond-agent.exe" hook claude`), with no Node, npm or npx; `init`, `install`, sign-in and the agent's upkeep all write that form, and an npm agent leaves a working one alone. Autostart's launcher starts the executable with `run` (and still restarts it after a crash).
