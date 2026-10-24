---
"@scopebond/agent": minor
---

On macOS, a signed install signs in to the workspace named by the `Workspace` preference of `com.scopebond.agent` (a configuration profile from device management first, then `/Library/Preferences`, then the person's own), and connects with its `InstallKey` without a code, as the Windows installer's `WORKSPACE=` and `KEY=` do. Beside the macOS installer package's LaunchAgent, `autostart on` and `off` enable and disable that LaunchAgent for the person in launchd instead of writing a second one, and `status` reads launchd's disabled list.
