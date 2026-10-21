---
"@scopebond/agent": patch
---

Records waiting to send are now the agent's job alone: the tray stays "Protected" with no "Send records now" and no attention state, the agent starts again at once when a delivery worked elsewhere or the computer woke instead of waiting out its backoff, and only after 24 hours awake and online without a delivery does Settings show "Records can't reach <workspace> since <time>"; on macOS and Linux a notification now comes only when the person must act, and when that is over.
