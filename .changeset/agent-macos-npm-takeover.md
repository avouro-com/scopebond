---
"@scopebond/agent": patch
---

On macOS the package's agent takes over from an agent installed with npm, as the Windows installer's does. It stops the npm agent, replaces npm's own LaunchAgent and launcher with the package's LaunchAgent, and points every Scopebond hook entry at `/usr/local/bin/scopebond-agent`. It then says once how to remove the npm package (`npm uninstall -g @scopebond/agent`), and `status` notes either install while the other is there. `autostart on` beside the package lets a label loaded from another LaunchAgent give way to the package's.
