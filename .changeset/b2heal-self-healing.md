---
"@scopebond/agent": patch
---

Records waiting to send are now the agent's job alone: the tray stays "Protected" with no "Send records now" and no attention state, the agent starts again at once when a delivery worked elsewhere or the computer woke instead of waiting out its backoff, and only after 24 hours awake and online without a delivery does Settings show "Records can't reach <workspace> since <time>"; on macOS and Linux a notification now comes only when the person must act, and when that is over.

The agent now repairs this computer's setup as soon as it sees it broken (each cycle, whenever the tray asks, and before every self-check): a Scopebond hook entry a coding agent's settings lost is put back, a second copy is taken out, and autostart that is on but broken is started again (autostart the person turned off stays off); each repair is checked again and recorded as `last_repair` in `status`, the self-check runs once more after a repair, and the tray shows only a repair that failed, as "Scopebond couldn't reconnect to Claude Code" with Repair.
