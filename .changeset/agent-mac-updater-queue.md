---
"@scopebond/agent": patch
---

The macOS package's updater starts while its requests folder is not empty (launchd's QueueDirectories) instead of when the folder changes (WatchPaths), so a request left while the updater runs, or right after the package loads it, is no longer lost. Each run leaves the folder empty: anything that is not a request is removed without being read or followed.
