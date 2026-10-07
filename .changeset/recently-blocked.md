---
"@scopebond/hook": minor
"@scopebond/agent": minor
---

Act on a block afterwards, from the tray. When a rule lets a person allow a blocked action or ask an admin, the block is
kept for a week and the tray's **Recently blocked** list offers it: a click opens the Scopebond window for that action, and
the person may allow it once (the next try), for 15 minutes or always, or ask an admin, as the workspace allows now. The
reason length and the daily limit apply as in the window; a block is offered once; Scopebond never runs the action again by
itself. New: `blockedQuestion` and `actOnBlocked` in the hook, `POST /blocked` on the agent's local channel (it only names
the block; the answer comes from the window), and `can_act` / `acted` on the tray model's recent blocks.
