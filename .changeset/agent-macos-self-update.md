---
"@scopebond/agent": minor
---

The macOS package updates itself. When the workspace recommends a newer signed build, the agent asks the package's root updater (`scopebond-agent update-daemon`, the LaunchDaemon `com.scopebond.updater`) for that version. The updater installs it only when it is newer, named by the release manifest signed with an updater key, the package that manifest names (SHA-256 and size), and signed with Avouro LLC's Developer ID Installer identity and notarized. A package that did not install is a failed update and is tried again later, as on Windows. The `AutoUpdate` preference (`false`), set by a configuration profile or in `/Library/Preferences`, turns this off.
