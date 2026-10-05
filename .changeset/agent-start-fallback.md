---
"@scopebond/agent": patch
---

`scopebond-agent autostart on` on Windows starts the agent now even where the headless console host does not start (seen on Windows Server): after a few seconds without an answer it starts the same launcher through `cmd.exe` with its window hidden. Before, the agent stayed stopped until the next sign-in and the command only said how to start it by hand.
