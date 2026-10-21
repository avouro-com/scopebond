---
"@scopebond/agent": patch
---

- The Scopebond window now shows a command containing `&` exactly as it runs (for example `2>&1` and `a && b`); before, Windows hid each `&` as a keyboard-shortcut mark.
- When the Scopebond tray is listening, a blocked action is asked about only in the tray, for the hook's whole wait; the Scopebond window no longer also opens after ten seconds.
