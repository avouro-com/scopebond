---
"@scopebond/agent": patch
---

On macOS the signed executable never takes the Windows installer's update path. When the workspace recommends a newer signed build, it logs that a new package updates this computer. It downloads no installer, records no failed update to retry, and offers no update in the tray. On Windows nothing changes.
