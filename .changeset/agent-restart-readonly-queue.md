---
"@scopebond/agent": patch
---

On Linux and macOS, when delivery fails because the queue reads as read-only (after a full disk or a read-only file), the agent starts a fresh copy of itself to open the queue again, at most once every ten minutes: a process that once failed to open it keeps seeing it read-only after it is writable again. Windows reopens it normally in the same process.
