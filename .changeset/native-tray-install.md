---
"@scopebond/agent": minor
---

The signed Windows install can carry the native Scopebond tray (`scopebond-tray.exe` beside the agent). When it is there, the agent leaves the tray to it (no PowerShell tray), `autostart on` sets the tray's own sign-in entry (`Scopebond`, which starts the agent) instead of the launcher's `ScopebondAgent` and retires the latter, `autostart off` removes it, `status` reports it, and after a self-update the helper stops the tray, installs, and starts the tray again (which starts the updated agent). npm installs are unchanged.
