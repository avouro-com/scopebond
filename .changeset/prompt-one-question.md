---
"@scopebond/agent": patch
"@scopebond/hook": patch
---

- The Scopebond window now shows a command containing `&` exactly as it runs (for example `2>&1` and `a && b`); before, Windows hid each `&` as a keyboard-shortcut mark.
- When the Scopebond tray is listening, a blocked action is asked about only in the tray, for the hook's whole wait; the Scopebond window no longer also opens after ten seconds.
- On Windows the old Scopebond window no longer opens for a block when no tray is listening; set `SCOPEBOND_PROMPT_WINDOW=1` to bring it back for this release (it will be removed after that). macOS and Linux keep their dialog.
- When no one could be asked at the moment of a block but the workspace lets the person act, the denial's "For the person" line now says to allow it (or ask an admin) from the Scopebond icon's recent blocks, or on this computer's page in the workspace, instead of saying the agent is not running.
