---
"@scopebond/hook": patch
---

No false "switching Scopebond off" block for ordinary commands: a second here-document after a body with an apostrophe (`it's`) is still read as data, a here-document's text never counts as naming Scopebond, and the Windows reading closes a quote left open by `\"` at the end of the line, as cmd does, before giving up on the command. A real switch-off or a write into Scopebond's folder is still blocked in both readings.
