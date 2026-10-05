---
"@scopebond/agent": patch
---

`autostart on` now also starts the agent right away (on Windows the tray icon appears), instead of waiting for the next sign-in. `status` says plainly when the agent is not running and gives the Windows command (`scopebond-agent.cmd`). The command and the launcher no longer print Node's SQLite experimental warning.
