---
"@scopebond/agent": patch
---

Reconcile discovery within a short fallback interval after resume, even when the platform pauses timer clocks during sleep and no filesystem event arrives. Keep scans serialized and unchanged inventory deduplicated.
