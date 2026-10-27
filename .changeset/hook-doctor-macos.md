---
"@scopebond/hook": patch
---

`doctor` on macOS checks the signed program. It fails, with the command that fixes it, when the program carries Gatekeeper's quarantine. For the installer package's program it also fails when the package's LaunchAgent is not running the agent for you (turning autostart off on purpose is fine) or when the package's updater is missing.
