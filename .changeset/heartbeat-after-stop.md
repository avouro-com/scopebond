---
"@scopebond/hook": patch
---

A heartbeat is queued only while its session is still active, checked in the same database transaction as the write, so a session ended by another hook process at that moment no longer gets a heartbeat after its stop.
